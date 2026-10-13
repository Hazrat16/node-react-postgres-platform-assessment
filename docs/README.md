# Evidence

Screenshots referenced by the main README live in `docs/screenshots/`.

| File | Shows | How to reproduce |
|---|---|---|
| `kubectl-get-all-dev.png` | all workloads healthy in `dev` | `kubectl get all,ingress,pvc,hpa -n dev` |
| `app-node-react-local.png` | the app at http://node-react.local | add an item, search for it |
| `api-health-db.png` | reads served by the replica | http://node-react.local/api/health/db |
| `grafana-backend-dashboard.png` | CPU, memory, request/error rate, replicas | Grafana → "Node React Platform - Backend" during `make load-test` |
| `hpa-scaling.png` | HPA scaling 2 → 6 | `kubectl -n dev get hpa backend-hpa -w` during `make load-test` |
| `loki-query.png` | backend logs filtered in Loki | Grafana → Explore → Loki → `{namespace="dev", app="backend"} \| json \| msg="request"` |
| `rate-limit-429.png` | 429s from the Ingress | `make rate-limit-test` |
| `prometheus-alerts.png` | alert rules loaded | http://prometheus.node-react.local/alerts |
| `github-actions-run.png` | a passing pipeline | GitHub → Actions → CI/CD |
