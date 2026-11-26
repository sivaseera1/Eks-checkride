# SivaP EKS Checkride — Shared Cluster Adaptation

This is a **safe starter adaptation**, not an automatic deployment.

Target environment:
- Cluster: `eks-checkride-shared`
- Region: `ap-south-1`
- Namespace: `siva-p`

## Frontend requirement
A frontend is **not required** for the EKS reliability checkride. The demo is API-focused.
Use curl/PowerShell, port-forward, Kubernetes status, rollout history, logs and metrics.
A frontend/dashboard can be added optionally, but it is not needed to demonstrate HA,
health probes, rolling updates, self-healing, PDB, scaling, and rollback.

## Safety
This package does not create a Namespace, ALB/Ingress, cluster, add-ons, monitoring,
or node group. It does not include cluster deletion or node-drain commands.
Do not apply HPA until namespace quota and shared cluster capacity are checked.
Do not apply the optional Argo Rollout until its CRD/controller and routing integration
are confirmed by the senior/cluster owner.

## 1. Inspect first (read-only)
```powershell
kubectl config current-context
kubectl get nodes -o wide
kubectl get namespace siva-p --show-labels
kubectl get pods -A
kubectl get deployments -A
kubectl get ingress -A
kubectl get resourcequota -n siva-p
kubectl get limitrange -n siva-p
kubectl get crd | findstr /i argo
helm list -A
```

## 2. Build and push demo image
Run from this folder (Docker must be available). Replace the ECR URI if required.
```powershell
$ECR = "783764579167.dkr.ecr.ap-south-1.amazonaws.com/checkride/siva-p"
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 783764579167.dkr.ecr.ap-south-1.amazonaws.com
docker build -t checkride-demo:demo-v1 .\app
docker tag checkride-demo:demo-v1 "$ECR:demo-v1"
docker push "$ECR:demo-v1"
```

## 3. Update image placeholder
Edit `k8s/deployment.yaml` and replace:
`REPLACE_WITH_YOUR_ECR_URI:demo-v1`
with:
`783764579167.dkr.ecr.ap-south-1.amazonaws.com/checkride/siva-p:demo-v1`

## 4. Deploy only after approval
```powershell
kubectl apply -f .\k8s\deployment.yaml
kubectl apply -f .\k8s\service.yaml
```
PDB/HPA are separate and capacity-sensitive:
```powershell
kubectl apply -f .\k8s\pdb-hpa.yaml
```
Only after approval and capacity/quota validation.

## 5. Verify
```powershell
kubectl get pods -n siva-p -l app=checkride-demo -o wide
kubectl get deployment checkride-demo -n siva-p
kubectl get service checkride-demo -n siva-p
kubectl rollout status deployment/checkride-demo -n siva-p
```

## 6. Local tunnel for API demonstration
Terminal 1:
```powershell
kubectl port-forward service/checkride-demo 8081:80 -n siva-p
```
Terminal 2:
```powershell
curl http://localhost:8081/
curl http://localhost:8081/ready
curl http://localhost:8081/healthz
curl http://localhost:8081/api/orders/1001
```

## 7. Self-healing demo (delete ONE demo pod only)
```powershell
kubectl get pods -n siva-p -l app=checkride-demo
kubectl delete pod <DEMO_POD_NAME> -n siva-p
kubectl get pods -n siva-p -l app=checkride-demo -w
```

## 8. Rollout/rollback demo
Change the image tag to a new tag and update the Deployment:
```powershell
kubectl set image deployment/checkride-demo app=$ECR:demo-v2 -n siva-p
kubectl rollout status deployment/checkride-demo -n siva-p
kubectl rollout history deployment/checkride-demo -n siva-p
```
Rollback only this demo Deployment:
```powershell
kubectl rollout undo deployment/checkride-demo -n siva-p
kubectl rollout status deployment/checkride-demo -n siva-p
```

## Optional Argo Rollouts
`optional-argo-rollouts/rollout.yaml` is a template only.
Requires Argo Rollouts installed and an approved traffic-routing integration.
Do not apply it alongside the Deployment with the same selector/name.
Do not create a public ALB or install cluster-wide controllers without approval.

## Cleanup
Only remove these demo resources, and only after approval:
```powershell
kubectl delete deployment checkride-demo -n siva-p
kubectl delete service checkride-demo -n siva-p
kubectl delete pdb checkride-demo -n siva-p
kubectl delete hpa checkride-demo -n siva-p
```
