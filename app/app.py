"""Order-tracking demo service for the EKS checkride.

Standard library only. Behaviour is controlled by environment variables so the
same image can play v1 (healthy), v2 (healthy) and v3 (broken):

  APP_VERSION      version string returned in responses and metrics (default v1)
  FAIL_RATE        fraction 0.0-1.0 of /api requests that return HTTP 500 (default 0)
  READY_FAIL       "true" -> /ready always returns 503 (pod never becomes Ready)
  STARTUP_DELAY    seconds before the app reports started/ready (default 5)
  SHUTDOWN_DELAY   seconds to keep serving after SIGTERM (default 5)

Endpoints:
  GET /api/orders/<id>  fake order lookup (does a little CPU work for HPA demos)
  GET /healthz          liveness  - process is alive (no dependency checks)
  GET /ready            readiness - started, not shutting down, deps OK
  GET /startup          startup   - initialisation finished
  GET /metrics          Prometheus text format
  POST /break           flip liveness to failing (self-healing demo)
"""
import hashlib
import json
import os
import random
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = os.getenv("APP_VERSION", "v1")
FAIL_RATE = float(os.getenv("FAIL_RATE", "0"))
READY_FAIL = os.getenv("READY_FAIL", "false").lower() == "true"
STARTUP_DELAY = float(os.getenv("STARTUP_DELAY", "5"))
SHUTDOWN_DELAY = float(os.getenv("SHUTDOWN_DELAY", "5"))
POD = os.getenv("POD_NAME", "local")


def detect_zone():
    """Return NODE_ZONE if set, otherwise query EC2 IMDSv2 for the AZ."""
    env_zone = os.getenv("NODE_ZONE")
    if env_zone:
        return env_zone
    try:
        token_req = urllib.request.Request(
            "http://169.254.169.254/latest/api/token",
            method="PUT",
            headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"},
        )
        with urllib.request.urlopen(token_req, timeout=1.0) as resp:
            token = resp.read().decode().strip()
        az_req = urllib.request.Request(
            "http://169.254.169.254/latest/meta-data/placement/availability-zone",
            headers={"X-aws-ec2-metadata-token": token},
        )
        with urllib.request.urlopen(az_req, timeout=1.0) as resp:
            az = resp.read().decode().strip()
        return az or "unknown"
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return "unknown"


ZONE = detect_zone()

START = time.time()
state = {"shutting_down": False, "live": True}
lock = threading.Lock()
counts = {}          # (path_group, status) -> count
latency_sum = {"sum": 0.0, "count": 0}


def started():
    return time.time() - START >= STARTUP_DELAY


def record(group, status, dur):
    with lock:
        counts[(group, status)] = counts.get((group, status), 0) + 1
        if group == "api":
            latency_sum["sum"] += dur
            latency_sum["count"] += 1


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass  # keep pod logs quiet; metrics carry the signal

    def _send(self, status, body, ctype="application/json"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-App-Version", VERSION)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        t0 = time.time()
        p = self.path.split("?")[0]
        if p == "/healthz":
            ok = state["live"]
            self._send(200 if ok else 500, json.dumps({"live": ok}))
        elif p == "/startup":
            self._send(200 if started() else 503, json.dumps({"started": started()}))
        elif p == "/ready":
            ok = started() and not state["shutting_down"] and not READY_FAIL
            self._send(200 if ok else 503, json.dumps({"ready": ok}))
        elif p == "/metrics":
            self._send(200, metrics(), "text/plain; version=0.0.4")
        elif p.startswith("/api/orders/"):
            order_id = p.rsplit("/", 1)[-1]
            # small CPU burn so HPA has something to react to
            h = order_id.encode()
            for _ in range(2000):
                h = hashlib.sha256(h).digest()
            if random.random() < FAIL_RATE:
                status = 500
                self._send(status, json.dumps({"error": "internal error", "version": VERSION}))
            else:
                status = 200
                self._send(status, json.dumps({
                    "orderId": order_id,
                    "status": random.choice(["PLACED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]),
                    "version": VERSION, "pod": POD, "zone": ZONE,
                }))
            record("api", status, time.time() - t0)
            return
        elif p == "/":
            self._send(200, json.dumps({"service": "order-tracking", "version": VERSION, "pod": POD, "zone": ZONE}))
        else:
            self._send(404, json.dumps({"error": "not found"}))

    def do_POST(self):
        if self.path == "/break":
            state["live"] = False
            self._send(200, json.dumps({"live": False}))
        else:
            self._send(404, json.dumps({"error": "not found"}))


def metrics():
    lines = [
        "# HELP http_requests_total API requests by status code",
        "# TYPE http_requests_total counter",
    ]
    with lock:
        for (group, status), n in sorted(counts.items()):
            lines.append(f'http_requests_total{{group="{group}",status="{status}",version="{VERSION}"}} {n}')
        lines += [
            "# TYPE http_request_duration_seconds_sum counter",
            f'http_request_duration_seconds_sum{{version="{VERSION}"}} {latency_sum["sum"]}',
            "# TYPE http_request_duration_seconds_count counter",
            f'http_request_duration_seconds_count{{version="{VERSION}"}} {latency_sum["count"]}',
        ]
    return "\n".join(lines) + "\n"


def main():
    server = ThreadingHTTPServer(("0.0.0.0", int(os.getenv("PORT", "8080"))), Handler)

    def on_sigterm(*_):
        # Graceful shutdown: fail readiness first, keep serving in-flight and
        # late-arriving requests, then exit. preStop sleep in the pod spec covers
        # the window while the ALB deregisters the target.
        state["shutting_down"] = True
        def stop():
            time.sleep(SHUTDOWN_DELAY)
            server.shutdown()
        threading.Thread(target=stop, daemon=True).start()

    signal.signal(signal.SIGTERM, on_sigterm)
    print(f"order-tracking {VERSION} listening; FAIL_RATE={FAIL_RATE} READY_FAIL={READY_FAIL} ZONE={ZONE}", flush=True)
    server.serve_forever()
    sys.exit(0)


if __name__ == "__main__":
    main()
