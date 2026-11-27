(() => {
  const STAGES = ["PLACED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];
  const MAX_HISTORY = 25;

  const state = {
    total: 0,
    success: 0,
    latencySumMs: 0,
    history: [],
    pollTimer: null,
  };

  const el = (id) => document.getElementById(id);

  async function fetchJsonWithStatus(url, options) {
    const start = performance.now();
    const res = await fetch(url, options);
    const latencyMs = Math.round(performance.now() - start);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, ok: res.ok, data, latencyMs };
  }

  function setProbePill(id, label, ok) {
    const node = el(id);
    node.textContent = ok ? `${label}: OK` : `${label}: FAIL`;
    node.classList.toggle("ok", Boolean(ok));
    node.classList.toggle("fail", !ok);
  }

  async function refreshTelemetry() {
    try {
      const [infoRes, startupRes, readyRes, liveRes] = await Promise.all([
        fetchJsonWithStatus("/api/info"),
        fetchJsonWithStatus("/startup"),
        fetchJsonWithStatus("/ready"),
        fetchJsonWithStatus("/healthz"),
      ]);

      if (infoRes.data) {
        const info = infoRes.data;
        el("hdr-version").textContent = info.version || "--";
        el("hdr-pod").textContent = info.pod || "--";
        el("hdr-zone").textContent = info.zone || "--";
      }

      setProbePill("probe-startup", "Startup", startupRes.ok && startupRes.data?.started);
      setProbePill("probe-ready", "Ready", readyRes.ok && readyRes.data?.ready);
      setProbePill("probe-live", "Live", liveRes.ok && liveRes.data?.live);
    } catch (err) {
      console.error("Telemetry refresh failed", err);
    }
  }

  function renderStepper(currentStage) {
    const idx = STAGES.indexOf(currentStage);
    const items = el("order-stepper").querySelectorAll("li");
    items.forEach((li) => {
      const stageIdx = STAGES.indexOf(li.dataset.stage);
      li.classList.remove("done", "active");
      if (idx >= 0) {
        if (stageIdx < idx) li.classList.add("done");
        else if (stageIdx === idx) li.classList.add("active");
      }
    });
  }

  function renderStatsAndLog() {
    el("stat-total").textContent = String(state.total);
    el("stat-success").textContent =
      state.total > 0 ? `${Math.round((state.success / state.total) * 100)}%` : "--";
    el("stat-avg-ms").textContent =
      state.total > 0 ? `${Math.round(state.latencySumMs / state.total)} ms` : "--";

    const tbody = el("trace-tbody");
    if (state.history.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-row">No requests recorded yet.</td></tr>';
      return;
    }

    tbody.innerHTML = state.history
      .map(
        (row) => `
        <tr>
          <td class="mono-val">${escapeHtml(row.time)}</td>
          <td class="mono-val">${escapeHtml(row.orderId)}</td>
          <td><span class="badge ${row.httpStatus === 200 ? "badge-ok" : "badge-err"}">${row.httpStatus}</span></td>
          <td class="mono-val">${escapeHtml(row.orderStatus)}</td>
          <td class="mono-val">${escapeHtml(row.version)}</td>
          <td class="mono-val">${escapeHtml(row.pod)}</td>
          <td class="mono-val">${escapeHtml(row.zone)}</td>
          <td class="mono-val">${row.latencyMs} ms</td>
        </tr>
      `
      )
      .join("");
  }

  function recordTrace(entry) {
    state.total += 1;
    if (entry.httpStatus === 200) state.success += 1;
    state.latencySumMs += entry.latencyMs;
    state.history.unshift(entry);
    if (state.history.length > MAX_HISTORY) {
      state.history.length = MAX_HISTORY;
    }
  }

  async function lookupOrder(orderId, updatePrimaryCard = true) {
    const cleanId = (orderId || "").trim();
    if (!cleanId) return;

    const result = await fetchJsonWithStatus(`/api/orders/${encodeURIComponent(cleanId)}`);
    const payload = result.data || {};
    const pod = payload.pod || "--";
    const zone = payload.zone || "--";
    const version = payload.version || "--";
    const orderStatus = result.ok ? payload.status || "UNKNOWN" : payload.error || "ERROR";

    if (pod !== "--") el("hdr-pod").textContent = pod;
    if (zone !== "--") el("hdr-zone").textContent = zone;
    if (version !== "--") el("hdr-version").textContent = version;

    recordTrace({
      time: new Date().toLocaleTimeString(),
      orderId: cleanId,
      httpStatus: result.status,
      orderStatus,
      version,
      pod,
      zone,
      latencyMs: result.latencyMs,
    });

    if (updatePrimaryCard) {
      if (result.ok) {
        el("order-error").classList.add("hidden");
        el("order-result").classList.remove("hidden");
        el("res-order-id").textContent = payload.orderId || cleanId;
        el("res-http").textContent = `HTTP ${result.status}`;
        el("res-http").className = "badge badge-ok";
        el("res-status").textContent = orderStatus;
        el("res-pod").textContent = pod;
        el("res-zone").textContent = zone;
        el("res-version").textContent = version;
        el("res-latency").textContent = `${result.latencyMs} ms`;
        renderStepper(orderStatus);
      } else {
        el("order-result").classList.add("hidden");
        el("order-error").classList.remove("hidden");
        el("order-error").textContent = `HTTP ${result.status} from ${pod} (${zone}, ${version}): ${orderStatus}`;
      }
    }

    renderStatsAndLog();
  }

  async function runBurst(count) {
    const buttons = document.querySelectorAll(".burst-btn");
    buttons.forEach((b) => (b.disabled = true));
    try {
      const baseId = (el("order-input").value || "1001").trim();
      const tasks = Array.from({ length: count }, (_, idx) =>
        lookupOrder(`${baseId}-${idx + 1}`, idx === count - 1)
      );
      await Promise.all(tasks);
      await refreshTelemetry();
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  // Event bindings
  el("order-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await lookupOrder(el("order-input").value, true);
    await refreshTelemetry();
  });

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", async () => {
      el("order-input").value = chip.dataset.order;
      await lookupOrder(chip.dataset.order, true);
      await refreshTelemetry();
    });
  });

  document.querySelectorAll(".burst-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      runBurst(Number(btn.dataset.count));
    });
  });

  el("auto-poll-toggle").addEventListener("change", (e) => {
    if (e.target.checked) {
      state.pollTimer = setInterval(async () => {
        await lookupOrder(el("order-input").value || "1001", true);
        await refreshTelemetry();
      }, 2000);
    } else if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  });

  el("clear-log-btn").addEventListener("click", () => {
    state.total = 0;
    state.success = 0;
    state.latencySumMs = 0;
    state.history = [];
    renderStatsAndLog();
  });

  el("break-btn").addEventListener("click", () => {
    el("break-btn").classList.add("hidden");
    el("break-confirm-btn").classList.remove("hidden");
    el("break-cancel-btn").classList.remove("hidden");
  });

  el("break-cancel-btn").addEventListener("click", () => {
    el("break-btn").classList.remove("hidden");
    el("break-confirm-btn").classList.add("hidden");
    el("break-cancel-btn").classList.add("hidden");
  });

  el("break-confirm-btn").addEventListener("click", async () => {
    el("break-confirm-btn").classList.add("hidden");
    el("break-cancel-btn").classList.add("hidden");
    el("break-btn").classList.remove("hidden");

    const res = await fetchJsonWithStatus("/break", { method: "POST" });
    const fb = el("chaos-feedback");
    fb.classList.remove("hidden");
    fb.textContent = res.ok
      ? "POST /break sent: /healthz now returns 500. Kubelet will restart this pod after failureThreshold."
      : `Failed to trigger /break (HTTP ${res.status}).`;
    await refreshTelemetry();
  });

  // Initial load
  refreshTelemetry();
  lookupOrder("1001", true);
})();
