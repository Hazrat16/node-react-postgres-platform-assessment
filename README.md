# Node + React + Postgres — Production-Style Local Platform

A small full-stack app (React + Node.js/Express + PostgreSQL) taken from "runs on my laptop" to a
production-style platform: containers, Kubernetes, an Ingress API gateway, CI/CD to three
environments, platform services (Redis, BullMQ, OpenSearch, a real Postgres read replica),
observability, autoscaling and rate limiting. Everything runs locally; Terraform provisions the
cluster and its add-ons.

```mermaid
flowchart LR
  B[Browser] -->|node-react.local| ING[ingress-nginx<br/>API gateway + rate limit]
  subgraph dev namespace
    ING -->|/| FE[frontend-service] --> FEP[(frontend pods<br/>nginx)]
    ING -->|/api| BE[backend-service] --> BEP[(backend pods<br/>Express, HPA 2-6)]
    BEP -->|writes| PGW[postgres-service] --> PG[(postgres-0<br/>primary)]
    BEP -->|reads| PGR[postgres-read-service] --> PGRP[(postgres-replica-0<br/>hot standby)]
    PG -. WAL streaming .-> PGRP
    BEP -->|enqueue| RS[redis-service] --> R[(redis)]
    W[(bullmq-worker)] -->|consume| RS
    W -->|index| SS[search-service] --> OS[(opensearch)]
    BEP -->|search| SS
  end
  subgraph monitoring / logging
    PROM[Prometheus] -. scrape /metrics .-> BEP
    PROM -. scrape .-> ING
    FB[Fluent Bit DaemonSet] --> LOKI[Loki]
    GRAF[Grafana] --> PROM & LOKI
  end
```

## Contents

1. [Prerequisites](#prerequisites)
2. [Quick start](#quick-start)
3. [Repository layout](#repository-layout)
4. [Task 1 — Docker Compose](#task-1--docker-compose)
5. [Task 2 — Kubernetes](#task-2--kubernetes)
6. [Task 3 — Ingress as API gateway](#task-3--ingress-as-api-gateway)
7. [Task 4 — CI/CD & multi-environment deployment](#task-4--cicd--multi-environment-deployment)
8. [Task 5 — Platform services](#task-5--platform-services)
9. [Task 6 — Observability, scaling & rate limiting](#task-6--observability-scaling--rate-limiting)
10. [Design decisions & trade-offs](#design-decisions--trade-offs)
11. [What I would do with more time](#what-i-would-do-with-more-time)

---

## Prerequisites

| Tool | Tested version | Needed for |
|---|---|---|
| Docker (+ Compose v2) | 29.x / Compose 5.x | everything |
| kind | 0.31 | Kubernetes |
| kubectl | 1.35 | Kubernetes |
| Terraform | ≥ 1.6 (tested 1.16) | cluster + platform add-ons |
| Helm | 3 or 4 | only for `make cluster-kind` (no-Terraform path) |
| Node.js | 24 | only to run tests outside Docker |

Resources: Compose needs ~2.5 GB RAM; the full Kubernetes stack (3 kind nodes, OpenSearch,
Prometheus/Grafana, Loki) needs ~6 GB free RAM.

## Quick start

### Docker Compose (Task 1 + 5)

```bash
cp .env.example .env          # or `make env` to generate random passwords
docker compose up --build     # or `make up`
```

- UI: http://localhost:8080
- API (debug only, bound to 127.0.0.1): http://localhost:4000/api/health

### Kubernetes (Tasks 2–6)

```bash
make k8s-up
# = terraform apply (kind cluster + ingress-nginx + metrics-server + Prometheus/Grafana + Loki + Fluent Bit)
#   + kubectl apply -k observability/   (ServiceMonitor, alert rules, Grafana dashboard)
#   + build images and `kind load` them
#   + generate k8s/overlays/dev/secrets.env with random passwords
#   + kubectl apply -k k8s/overlays/dev and wait for rollouts

# once: map the Ingress hostnames to localhost
echo "127.0.0.1 node-react.local preprod.node-react.local release.node-react.local grafana.node-react.local prometheus.node-react.local" | sudo tee -a /etc/hosts
```

| URL | What |
|---|---|
| http://node-react.local | the app (frontend + `/api`) |
| http://grafana.node-react.local | Grafana — user `admin`, password: `terraform -chdir=terraform output -raw grafana_admin_password` |
| http://prometheus.node-react.local | Prometheus (targets, alerts) |

> **Port 80 already in use** (e.g. a local nginx/apache)? Either stop it, or create the cluster
> on another port: `make k8s-up HTTP_PORT=8880` and use `http://node-react.local:8880`.

Other useful targets: `make help`, `make status`, `make load-test`, `make rate-limit-test`,
`make cluster-destroy`.

## Repository layout

```
.
├── backend/                    Express API + BullMQ worker (same image) + unit tests
├── frontend/                   React (Vite) app + nginx config template
├── Dockerfile.backend          multi-stage, non-root
├── Dockerfile.frontend         multi-stage, unprivileged nginx
├── .dockerignore
├── docker-compose.yml          app + Postgres primary/replica + Redis + worker + OpenSearch
├── .env.example                Compose config template (.env is git-ignored)
├── Makefile                    thin wrappers around the commands in this README
├── k8s/
│   ├── kind-config.yaml        3-node kind cluster (used by CI)
│   ├── base/                   environment-agnostic manifests (kustomize base)
│   ├── overlays/{dev,preprod,release}/   namespace, PV, Ingress, secrets, sizing
│   └── tools/load-test.yaml    HPA load generator
├── observability/              Helm values (Prometheus stack, Loki, Fluent Bit),
│                               ServiceMonitor, alert rules, Grafana dashboard JSON
├── terraform/                  kind cluster + Helm releases for all platform add-ons
├── .github/workflows/ci-cd.yml
└── docs/                       screenshots / evidence
```

Mapping from the file names suggested in the brief to this repo:

| Suggested | Here | Note |
|---|---|---|
| `namespace-dev.yaml` | `k8s/overlays/dev/namespace-dev.yaml` | one per environment |
| `backend-deployment.yaml`, `backend-service.yaml` | `k8s/base/` | + `backend-pdb.yaml` |
| `frontend-deployment.yaml`, `frontend-service.yaml` | `k8s/base/` | |
| `postgres-statefulset.yaml`, `postgres-service.yaml` | `k8s/base/` | + replica StatefulSet and `postgres-read-service.yaml` |
| `postgres-pv.yaml` / `postgres-pvc.yaml` | `k8s/overlays/<env>/` / `k8s/base/` | PV is cluster-scoped, so one per env |
| `app-configmap.yaml` | `k8s/base/app-configmap.yaml` | |
| `app-secrets.yaml` | `secretGenerator` in `k8s/overlays/<env>/kustomization.yaml` | built from a git-ignored `secrets.env` — see [Task 2](#task-2--kubernetes) |
| `ingress-dev.yaml` | `k8s/overlays/dev/ingress-dev.yaml` | |
| `redis-*`, `bullmq-worker-deployment.yaml`, `search-*` | `k8s/base/` | |
| `prometheus.yaml`, `grafana.yaml`, `loki.yaml`, `fluentbit-daemonset.yaml` | `observability/*-values.yaml` | Helm values, installed by Terraform |
| `hpa-backend.yaml` | `k8s/base/hpa-backend.yaml` | lives with the app so each env gets one |

---

## Task 1 — Docker Compose

`docker compose up --build` starts seven containers: `frontend`, `backend`, `worker`, `postgres`
(primary), `postgres-replica`, `redis`, `opensearch`.

**Dockerfiles** (both multi-stage, both run as non-root):

| Image | Stages | Final image | Size |
|---|---|---|---|
| `Dockerfile.backend` | `deps` (`npm ci --omit=dev`, BuildKit cache mount) → `runtime` | `node:24-alpine` + prod `node_modules` + `src/` | ~187 MB |
| `Dockerfile.frontend` | `build` (`npm ci && vite build`) → `runtime` | `nginx-unprivileged:1.30-alpine` + static files | ~60 MB |

- Dependency manifests are copied before the source, so code changes don't invalidate the
  `npm ci` layer.
- The build context is the repo root; `.dockerignore` excludes `node_modules`, `.env`, `.git`,
  `k8s/`, docs etc., so they never reach the daemon or an image.
- The backend image is reused for the BullMQ worker (`command: node src/worker.js`): one build,
  one scan, one version.

**Networking.** Two networks:

- `web`: frontend ↔ backend
- `data` (`internal: true`): backend/worker ↔ Postgres, replica, Redis, OpenSearch

The frontend container has no route to any datastore. Only the frontend publishes a port.
Services reach each other by Compose DNS names (`postgres`, `backend`…).

**The browser never talks to `backend:4000`.** That name only resolves inside Docker. The
frontend calls a same-origin `/api`, and its nginx proxies `/api/` to `BACKEND_URL` (a runtime
env var rendered into the nginx config by `envsubst` at container start). The API base URL the
React code uses is the build arg `VITE_API_BASE_URL` (default `/api`). So one frontend image
works in Compose, in Kubernetes and in every environment, with no CORS.

**Configuration / secrets.** All config is environment variables:

- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `DB_WRITE_URL`, `DB_READ_URL`, `REDIS_URL`, `SEARCH_URL`
- `VITE_API_BASE_URL` / `BACKEND_URL` for the frontend

Values come from `.env`, which is git-ignored. `docker-compose.yml` uses `${VAR:?}`, so a
missing password fails loudly instead of defaulting. The backend has no credential defaults in
code: `backend/src/config.js` throws on startup if a required variable is missing.

**Startup ordering.** Healthchecks plus `depends_on: condition: service_healthy` bring things up
in order: Postgres → replica → backend → frontend. The backend also retries DB connections
on its own, because ordering at startup doesn't help when the DB restarts later.

**Persistence.** Named volumes (`postgres_data`, `postgres_replica_data`, `redis_data`, `search_data`). Verified: items survive
`docker compose down && docker compose up` (`docker compose down -v` wipes them).

---

## Task 2 — Kubernetes

Everything for an environment lives in its own namespace (`dev`, `preprod`, `release`). The
manifests are a **kustomize base + one overlay per environment**, so the same base can later
be deployed to every namespace and only the differences live in the overlays:

- namespace
- Postgres PV
- Ingress hostname
- secrets
- HPA bounds

```bash
kubectl apply --server-side --force-conflicts -k k8s/overlays/dev   # what `make deploy` and CI run
kubectl get all -n dev
```

**Internal vs external.** Every Service is `ClusterIP`:

- `backend-service`
- `frontend-service`
- `postgres-service` (writer)
- `postgres-read-service` (reader)
- `redis-service`
- `search-service`

The only way in from outside the cluster is the Ingress controller (Task 3).

**Postgres** is a `StatefulSet` (stable identity, at most one pod on the volume), with
`PGDATA` in a subdirectory of the volume:

- `postgres-pvc` (2Gi, `storageClassName: manual`) binds to the statically provisioned
  `postgres-pv-<env>`.
- The PV is a `hostPath` on the kind node, with `Retain`, a `claimRef` pre-binding it to its
  environment's PVC, and `nodeAffinity` pinning it to the node labelled `node-react/storage=true`.
  Without that pin, a rescheduled pod could land on another node and see an empty directory.
- Verified: delete `postgres-0`, and the rows are still there when it comes back.

**Probes** (backend):

| Probe | Endpoint | Meaning | Why |
|---|---|---|---|
| readiness | `/api/health/ready` | startup done **and** primary DB reachable | an unready pod is removed from the Service endpoints, so it gets no traffic |
| liveness | `/api/health/live` | the process answers HTTP | deliberately **no** dependency checks: a DB outage must not restart every pod (a restart doesn't fix the DB, and causes a restart storm) |

The backend starts listening immediately and keeps retrying the DB in the background, staying
unready until the schema exists. An earlier version only started listening after connecting to
the DB; liveness then killed it while Postgres was still starting, and the pod ended up in
CrashLoopBackOff. Postgres uses a `startupProbe` (up to 10 min), so a slow first start (initdb)
is never killed. The frontend has probes too.

**Secrets.** There is no `app-secrets.yaml` in git. Each overlay's `kustomization.yaml` has a
`secretGenerator` that builds `app-secrets` from a git-ignored `secrets.env` (`make secrets`
generates one with random passwords; CI writes it from GitHub secrets). The generated name
carries a content hash, so changing a password rolls the pods that use it.

**Other production defaults:**

- `resources` requests and limits on every container (needed by the scheduler and the HPA)
- `runAsNonRoot`, `readOnlyRootFilesystem`, `drop: [ALL]` and seccomp `RuntimeDefault` on the
  app containers
- Rolling updates with `maxUnavailable: 0`
- `preStop` sleep so endpoints drain before SIGTERM; the app then finishes in-flight requests
  and closes its pools
- `PodDisruptionBudget` for the backend
- `topologySpreadConstraints` across nodes
- Server-side apply: the API server tracks which tool owns which field
- Pod Security Admission: `enforce: baseline` (the stock Postgres image needs it),
  `warn: restricted`

---

## Task 3 — Ingress as API gateway

`ingress-nginx` (Helm, installed by Terraform) runs on the kind control-plane node. It binds
host ports 80/443, which `kind` maps to the laptop. `k8s/overlays/dev/ingress-dev.yaml` defines
two Ingress objects on host `node-react.local`:

| Path | Backend | Policy |
|---|---|---|
| `/` (Prefix) | `frontend-service:80` | none |
| `/api` (Prefix, matches `/api` and `/api/*`) | `backend-service:4000` | rate limit, body size, timeouts |

They're split in two so API-only policy (body size, timeouts, rate limiting) doesn't apply
to static assets. The longest-prefix match means `/api/...` always wins over `/`.

**Terraform** (`terraform/`) now owns the cluster: the `tehcyx/kind` provider creates the same
3-node cluster as `k8s/kind-config.yaml`, and the `helm` provider installs ingress-nginx from a
pinned chart version. The app itself is not managed by Terraform; it is deployed with kustomize
(`make deploy`, CI).

### Request path: Browser → Ingress → Service → Pod → PostgreSQL

Example: `POST http://node-react.local/api/items`

1. **Browser → node.** `/etc/hosts` resolves `node-react.local` to `127.0.0.1`. Port 80 on the
   laptop is mapped by kind to port 80 of the control-plane node container, where the
   ingress-nginx pod listens via `hostPort`. (In the cloud this hop is DNS → a cloud load
   balancer → the controller's Service.)
2. **Ingress controller.** nginx matches `Host: node-react.local` and the longest path prefix
   `/api`, applies the rate limit, and picks an upstream. ingress-nginx doesn't go through
   the Service's virtual IP. It watches the Service's **EndpointSlices** and load-balances
   straight to the **ready** pod IPs.
3. **Service.** `backend-service` is a stable name + virtual IP whose selector `app=backend`
   defines the endpoint set. Only pods passing readiness are included. Any in-cluster client
   (e.g. the frontend's nginx proxy) uses the ClusterIP, which kube-proxy rules (iptables)
   DNAT to one of those pod IPs.
4. **Pod.** The Express app handles the request, writes with `INSERT … RETURNING` via
   `DB_WRITE_URL` = `postgres-service:5432`, and enqueues an `item-created` job in Redis.
5. **PostgreSQL.** `postgres-service` → `postgres-0` (primary). The change is WAL-streamed to
   `postgres-replica-0`. Later `GET /api/items` calls are served from the replica via
   `postgres-read-service`. Asynchronously, the worker consumes the job and indexes the item in
   OpenSearch.

### How Kubernetes DNS resolves services

- CoreDNS gives every Service an A record `<service>.<namespace>.svc.cluster.local` pointing at
  its ClusterIP, e.g. `backend-service.dev.svc.cluster.local`.
- Each pod's `/etc/resolv.conf` has `search dev.svc.cluster.local svc.cluster.local
  cluster.local` and `ndots:5`. So inside the `dev` namespace the short name `backend-service`
  resolves; from another namespace you need `backend-service.dev` (or the FQDN).
- That is why the same manifests work unchanged in every environment namespace: each
  environment's `postgres-service` resolves to its own namespace's database.
- Pods use these names, never pod IPs, because pod IPs change on every reschedule.
- Headless services (`clusterIP: None`) would return the pod IPs instead (StatefulSet per-pod
  DNS).

### Debugging

**(a) Ingress is reachable but the backend is not** (UI loads, `/api/*` gives 502/503/504):

```bash
kubectl -n dev get ingress api-ingress                  # host/path/backend as expected? ADDRESS set?
kubectl -n dev describe ingress api-ingress             # events: "service not found"?
kubectl -n dev get endpointslices -l kubernetes.io/service-name=backend-service
#   empty -> selector doesn't match pod labels, or no pod is Ready:
kubectl -n dev get pods -l app=backend                  # Running but 0/1 = failing readiness
kubectl -n dev describe pod <backend-pod>               # probe failures, OOMKilled, image pull
kubectl -n dev logs <backend-pod>                       # e.g. "database not ready, retrying"
kubectl -n dev get svc backend-service -o yaml          # port/targetPort name matches containerPort?
kubectl -n ingress-nginx logs deploy/ingress-nginx-controller | grep '/api'    # upstream status
```

How to read the status code:

- `503` with no endpoints → readiness / selector problem
- `502` → the pod is in the endpoint list but refused the connection (wrong port, app crashed)
- `504` → the app is too slow (often the DB)
- `429` → that's the rate limiter, not a fault

Also check whether a NetworkPolicy blocks the controller: `allow-backend` must allow namespace
`ingress-nginx`.

**(b) The frontend can't talk to the backend:**

1. Browser dev tools → Network. Which URL is called? It must be same-origin `/api/...`.
   - If it's `http://backend-service:4000/...` or `localhost:4000`, the wrong
     `VITE_API_BASE_URL` was baked in at build time: rebuild the image. Internal DNS names
     never resolve in a browser.
   - If it's `/api/...` and the response is `index.html` with status 200, the request hit the
     frontend instead of the API: the `/api` Ingress rule is missing or the path is wrong.
2. Call the API directly, bypassing the UI:
   `curl -i http://node-react.local/api/health`. If that fails, go to (a).
3. In-cluster path (the frontend's nginx proxy):
   `kubectl -n dev exec deploy/frontend -- wget -qO- http://127.0.0.1:8080/api/health`.
   - DNS: `kubectl -n dev exec deploy/backend -- getent hosts backend-service`
   - `BACKEND_URL` env value
   - NetworkPolicy `allow-backend` allows `app=frontend`
4. CORS errors only appear if the UI and the API are on different origins. This design avoids
   that entirely.

### Evolving to microservices

The Ingress is already a path-based API gateway. Splitting the backend means:

- `/api/items` → `items-service`, `/api/search` → `search-api`, `/api/users` → `users-service`.
  Each is its own Deployment + ClusterIP Service + HPA + NetworkPolicy, owned and deployed
  independently.
- Services call each other by DNS name, and talk asynchronously over a queue (BullMQ / Redis
  in Task 5), which avoids synchronous call chains.
- Each service owns its data. No shared tables. Integration happens through APIs and events.
- At that scale I'd move from ingress-nginx annotations to a real gateway: the **Gateway API**
  (`HTTPRoute` per team), with Envoy Gateway / Kong / Traefik. That brings per-route auth (JWT),
  per-consumer rate limits, retries and canary weights. Add a **service mesh** (Linkerd/Istio)
  only once mTLS between services, retries and per-hop tracing are actually needed.
- Note: the ingress-nginx project was retired in March 2026 (no further releases). It's used
  here because the brief suggests it and it still works. A real platform today should start on
  the Gateway API.

---

## Task 4 — CI/CD & multi-environment deployment

`.github/workflows/ci-cd.yml`

| Branch | Namespace | Hostname |
|---|---|---|
| `master` | `dev` | node-react.local |
| `pre-release/v*` | `preprod` | preprod.node-react.local |
| `release/v*` | `release` | release.node-react.local |

```
push ──► test (backend: lint + unit tests │ frontend: build)  ─┐
     ──► validate (kustomize build all overlays → kubeconform, │
                   docker compose config, terraform validate)  ─┤
                                                                ▼
         build: docker build ──► Trivy scan (fail on fixable CRITICAL) ──► push to GHCR
                tag = <branch>-<short-sha>   e.g. master-1a2b3c4, release-v1.2-1a2b3c4
                                                                ▼
         deploy (GitHub Environment = namespace, concurrency-locked per env):
                pin overlay images to that tag ──► kubectl apply -k k8s/overlays/<env>
                ──► rollout status ──► smoke test through the Ingress
                ──► on failure: diagnostics (+ automatic rollout undo on a real cluster)
```

- Pull requests to `master` run test, validate and build (no push, no deploy).
- Images are tagged `<branch>-<sha>` and **never** `latest`. Every running pod maps back to an
  exact commit, and a tag never changes content, which is what makes rollback precise.
- Build → scan → push: an image with a fixable critical CVE never reaches the registry.
- All third-party actions are pinned to a **commit SHA** (with the version in a comment). Tags
  are mutable; the 2026 `trivy-action` compromise worked by force-pushing tags.
- `concurrency: deploy-<env>` with `cancel-in-progress: false`: two pushes never deploy to the
  same environment at once, and a running rollout is never cancelled half-way.

**Where does it deploy?** The brief is local-only, and GitHub-hosted runners can't reach a kind
cluster on a laptop. So the deploy job has two targets:

- If the environment has a `KUBECONFIG_B64` secret, it deploys to that real cluster.
- Otherwise it creates an **ephemeral kind cluster on the runner** (same `k8s/kind-config.yaml`,
  same ingress-nginx values). It deploys the freshly pushed GHCR images into the branch's
  namespace and runs an end-to-end smoke test through the Ingress: UI loads, POST an item, GET
  it back, check DB/replica health.

So every green run proves the images, the manifests, the rollout and the request path. The
pipeline is unchanged when a real cluster is added. For a real on-prem/laptop cluster, the
alternatives would be a **self-hosted runner** next to the cluster, or (better) GitOps — see
"more time".

### How CI secrets are stored and used

| Secret | Where | Used for |
|---|---|---|
| `GITHUB_TOKEN` | built-in, short-lived, per run | pushing to GHCR (`packages: write` granted only to the build job; every other job has `contents: read`) |
| `KUBECONFIG_B64` | **Environment** secret (`dev` / `preprod` / `release`) | cluster access; should be a ServiceAccount token whose RBAC is limited to that one namespace |
| `DB_PASSWORD`, `REPLICATION_PASSWORD`, `REDIS_PASSWORD` | Environment secrets | written to the git-ignored `secrets.env` → kustomize `secretGenerator` → k8s Secret |
| `GHCR_PULL_TOKEN` (optional) | Environment secret | `read:packages` token for the cluster's image pull secret (GITHUB_TOKEN expires after the job) |

- Each environment has its **own** secrets, so a `master` build can never read production
  credentials. The `release` environment can additionally require **manual approval**
  (Environment protection rule) before the deploy job starts.
- Secrets are never interpolated into scripts. They're passed via `env:`, masked
  (`::add-mask::`), written with `umask 077`, and never echoed.
- No secret is in git: `.env`, `secrets.env` and Terraform state are git-ignored; only
  `*.example` templates are committed.
- The secret's name carries a content hash (kustomize), so rotating a password automatically
  rolls the pods that use it.

### Rollback strategy

1. **Automatic.** If `rollout status` or the smoke test fails on a real cluster, the pipeline
   runs `kubectl rollout undo` for the app Deployments. Rolling updates use
   `maxUnavailable: 0`, so a bad release never takes the old pods down first. Verified locally:
   with a non-existent image tag, the new pod sat in `ErrImagePull` while the old pods kept
   serving `200`, and `kubectl rollout undo` restored it.
2. **Manual, fast.** *Actions → CI/CD → Run workflow* with `environment=release` and an empty
   tag runs `kubectl rollout undo` (previous ReplicaSet; `revisionHistoryLimit: 5` keeps them).
3. **Manual, precise.** Same workflow with `image_tag=release-v1.2-1a2b3c4` redeploys that exact,
   already built and scanned image. Because tags are immutable `<branch>-<sha>`, this is exact,
   and it doesn't depend on Kubernetes still having the old ReplicaSet.
4. **Data.** Schema changes must be backward-compatible (expand → migrate → contract), so the
   previous image still works against the new schema. Otherwise an app rollback isn't safe.

Locally: `kubectl -n dev rollout history deploy/backend` and
`kubectl -n dev rollout undo deploy/backend [--to-revision=N]`.

---

## Task 5 — Platform services

All of these run in both Compose and Kubernetes, are reachable **only** from the backend tier
(NetworkPolicies / internal Docker network), and are password-protected where the engine
supports it in dev mode.

| Service | K8s files | How the app uses it | Health endpoint |
|---|---|---|---|
| **Redis 8** | `redis-deployment.yaml`, `redis-service.yaml` | `REDIS_URL` with password (`requirepass`); BullMQ backing store | `/api/health/redis` |
| **Queue: BullMQ** | `bullmq-worker-deployment.yaml` | `POST /api/items` enqueues `item-created` (5 attempts, exponential backoff); a **separate worker Deployment** (same image, `node src/worker.js`) consumes it | worker probe `:4001` |
| **Search: OpenSearch 2.19** (single node, dev mode) | `search-deployment.yaml`, `search-service.yaml` | the worker indexes each new item; `GET /api/search?q=` does a fuzzy match (UI search box) | `/api/health/search` |
| **Postgres read replica** | `postgres-replica-statefulset.yaml`, `postgres-read-service.yaml` | `DB_READ_URL` | `/api/health/db` |

The queue does real work instead of just logging:

- **Indexing is asynchronous.** A slow or down OpenSearch never slows down or fails a write;
  jobs retry with backoff until search is back.
- **The worker scales and fails independently** of the API. The next step would be autoscaling
  it on queue depth with KEDA.

### Isolation: platform services stay internal

All Services are `ClusterIP`, and inside the namespace a **default-deny NetworkPolicy** plus
explicit allow rules (`k8s/base/networkpolicies.yaml`) enforce who can talk to whom:

| To ↓ / allowed from → | ingress-nginx | frontend | backend | worker | monitoring |
|---|---|---|---|---|---|
| frontend :8080 | ✅ | | | | |
| backend :4000 | ✅ | ✅ (nginx proxy) | | | ✅ (/metrics) |
| postgres / replica :5432 | | | ✅ | ✅ | |
| redis :6379 | | | ✅ | ✅ | |
| opensearch :9200 | | | ✅ | ✅ | |

Verified on kind (kindnet enforces NetworkPolicy):

- frontend → postgres: **timeout**
- frontend → redis: **timeout**
- pod in `default` namespace → backend: **timeout**
- backend → postgres: **connected**

In Compose the same idea is the `internal: true` `data` network, which the frontend isn't on.

### Read/write DB cluster

This is a **real** streaming-replication pair rather than two URLs pointing at one database:

- `postgres` (primary) runs an init script that creates a `replicator` role and a `pg_hba`
  rule.
- `postgres-replica` clones it with `pg_basebackup -R` on first start, then runs as a read-only
  hot standby following the primary's WAL. Its storage comes from `volumeClaimTemplates` with
  the default StorageClass (dynamic provisioning, next to the primary's static PV).
- The same two scripts (`k8s/base/postgres-scripts/`) are used by Compose and Kubernetes.

```
DB_WRITE_URL = postgres://appuser:***@postgres-service:5432/appdb       (primary)
DB_READ_URL  = postgres://appuser:***@postgres-read-service:5432/appdb  (replica)
```

Passwords are not stored in the ConfigMap. The URLs are composed in the pod spec from
ConfigMap values plus Secret refs (`$(DB_PASSWORD)` expansion).

`GET /api/health/db` → `{"primary":"ok","read_target_is_replica":true,"replication_lag_seconds":…}`
proves reads really hit a standby (`pg_is_in_recovery()`). The lag value is
`now() - pg_last_xact_replay_timestamp()`. That's accurate under write load, but it grows while
the primary is idle, so in production compare LSNs from `pg_stat_replication` instead.

**Where the routing logic lives.** Here it's **in application code** (`backend/src/db.js`): two
pools, and every call site chooses `db.write()` or `db.read()`. If the replica is unreachable,
reads fall back to the primary (more load on the writer beats failing requests).

| Option | Pros | Cons |
|---|---|---|
| **App code** (this repo) | explicit, per-query control (read-your-writes), no extra hop | every developer must choose correctly; logic duplicated per service/language |
| **DB proxy** (Pgpool-II, ProxySQL-style, PgCat, AWS RDS Proxy reader endpoints) | transparent to the app, central policy, connection pooling | another component to run/HA; can't know which reads need fresh data, so it routes per transaction/statement type, not intent |
| **Managed endpoints** (RDS/Aurora writer + reader endpoints, Cloud SQL replicas) | no proxy to run | still two URLs, so the app still chooses |

A pragmatic production setup is app-level choice of writer vs reader, plus PgBouncer per pool
for connection limits.

**What replication lag implies.** A replica is asynchronously behind the primary, usually
milliseconds, but seconds or more under heavy writes, vacuum, or a network blip. So a read from
the replica can be *stale*. Operations that must always hit the **writer**:

- all writes (`INSERT/UPDATE/DELETE`, DDL, migrations) — a replica is read-only anyway
- **read-your-own-writes**: showing the user what they just saved. The UI here deliberately uses
  the row returned by `INSERT … RETURNING` (from the primary) instead of re-reading the list from
  the replica, where the new item might not exist yet.
- reads inside a transaction that then writes, and check-then-act logic (uniqueness checks,
  balances/stock, idempotency keys, "does this user exist" before creating one)
- authentication/authorization data right after it changes (password reset, revoked
  permissions, logout)
- anything feeding a decision that must be consistent (payments, inventory)

Safe for the replica: lists, search pages, dashboards, reports, anything where a few seconds of
staleness is acceptable. A common refinement is "sticky primary": route a user's reads to the
writer for N seconds after they write.

---

## Task 6 — Observability, scaling & rate limiting

Installed by Terraform (`terraform/platform.tf`) from pinned chart versions:

| Component | Chart | Namespace | Config |
|---|---|---|---|
| Prometheus, Alertmanager, Grafana, kube-state-metrics, node-exporter | `kube-prometheus-stack` 92.3.0 | `monitoring` | `observability/kube-prometheus-stack-values.yaml` |
| Loki (single binary, filesystem) | `loki` 7.3.0 | `logging` | `observability/loki-values.yaml` |
| Fluent Bit **DaemonSet** | `fluent-bit` 0.58.3 | `logging` | `observability/fluentbit-values.yaml` |
| metrics-server (for the HPA) | `metrics-server` 3.14.0 | `kube-system` | `terraform/values/metrics-server.yaml` |

Plus `kubectl apply -k observability/`, which adds:

- `servicemonitor-backend.yaml`: scrape `/metrics` of every `backend-service`, in every env
  namespace
- `prometheusrule-backend.yaml`: the alerts below
- the **Grafana dashboard as code** (`dashboards/backend-dashboard.json`), loaded by Grafana's
  sidecar from a labelled ConfigMap

### Metrics

The backend exports Prometheus metrics with `prom-client`:

- `http_requests_total{method,route,status}`
- `http_request_duration_seconds` (histogram)
- Node.js process metrics

The `route` label is the matched Express route pattern, never the raw URL, so label
cardinality stays bounded. The ingress controller is scraped too.

Dashboard **"Node React Platform – Backend"**, with an environment selector:

| Panel | Query source |
|---|---|
| Backend CPU per pod (+ request line) | cAdvisor `container_cpu_usage_seconds_total` |
| Backend memory per pod (+ limit line) | cAdvisor `container_memory_working_set_bytes` |
| Request rate by route | `http_requests_total` |
| Error rate (5xx ratio) | `http_requests_total{status=~"5.."}` / all |
| Backend replicas over time (available / HPA desired / max) | kube-state-metrics |
| Latency p50/p95/p99 | `http_request_duration_seconds_bucket` |
| Ingress responses by status (shows 429s) | `nginx_ingress_controller_requests` |
| Backend + worker warn/error logs | Loki |

### What I alert on, and why

| Alert | Condition | Severity | Why |
|---|---|---|---|
| `BackendHighErrorRate` | 5xx / all > 5% for 5m | critical | Users are getting errors right now. A ratio, not a count, so it means the same at 1 or 1000 req/s. |
| `BackendHighLatencyP95` | p95 > 500ms for 10m | warning | Users are waiting. Catches slow queries, a struggling dependency or CPU throttling *before* they turn into errors. p95, not the average, because averages hide the slow tail. |
| `BackendNoReadyPods` | available replicas == 0 for 2m | critical | Total outage, including when there's no traffic to produce errors. |
| `BackendHPAAtMaxReplicas` | current ≥ max for 15m | warning | Autoscaling has run out of headroom. The next symptom is latency, then errors. Act (raise max, add nodes, optimize) before that. |
| `BackendHighCPU` | CPU > 85% of limit for 10m | warning | Sustained throttling. Combined with the HPA alert it separates "needs more pods" from "pods are mis-sized". |
| `BackendRestarting` | > 3 restarts in 15m | warning | Crash loops (OOMKilled, bad config) stay invisible to the error rate while other replicas still serve. |

I alert on **symptoms users feel** (errors, latency, availability) as pages, and on **causes**
(CPU, capacity, restarts) as warnings. CPU alone never pages: high CPU with good latency is
just efficient use of resources. Next additions: replica lag, queue depth / job failure rate,
and SLO burn-rate alerts instead of fixed thresholds.

### Logging

Fluent Bit runs as a **DaemonSet**: one pod per node, including the control plane. That's the
only way to read every container's log file (`/var/log/containers/*.log`) on that node,
whichever pods land there. It adds Kubernetes metadata and ships to Loki with low-cardinality
labels only (`namespace`, `app`, `container`). The backend and the ingress controller log
**JSON**, so every field stays queryable without making it a label.

Example queries (Grafana → Explore → Loki):

```logql
{namespace="dev", app="backend"}                                          # all backend logs
{namespace="dev", app="backend"} | json | level="error"                   # errors only
{namespace="dev", app="backend"} | json | msg="request" | status >= 400   # failed requests
{namespace="dev", app="backend"} | json | duration_ms > 200               # slow requests
{namespace="dev", app="bullmq-worker"} | json | msg="job failed"          # queue failures
{namespace="ingress-nginx"} | json | status = 429                         # rate-limited calls
sum by (status) (count_over_time({namespace="dev", app="backend"} | json | msg="request" [5m]))
```

### Autoscaling

`k8s/base/hpa-backend.yaml` (autoscaling/v2):

- 2–6 replicas (release overlay: 3–10)
- target **70% CPU** or **80% memory** of requests
- scale-up immediately (+2 pods / 30s)
- scale-down after a 5-minute stabilization window (−1 pod / min), to avoid flapping

Min 2 means there's always redundancy across nodes, and together with the PDB, a node drain
never takes the API down. The backend Deployment deliberately has **no `replicas` field** any
more: the HPA owns it, so a deploy never resets a scaled-up backend to the manifest's count.

Verified with `make load-test` (50 concurrent connections from inside the cluster, which
bypasses the rate limit): CPU went to 131–447% of request, and the HPA scaled **2 → 4 → 6**
within ~90 s.

### Rate limiting

These are ingress-nginx annotations on the **API Ingress only**, so static assets are never
throttled:

| Setting | dev / preprod | release | Meaning |
|---|---|---|---|
| `limit-rps` | 20 | 50 | sustained requests per second **per client IP** |
| `limit-burst-multiplier` | 5 | 5 | allows bursts up to 5 × rps (100 / 250) before rejecting |
| `limit-connections` | 20 | 20 | concurrent connections per client IP |
| status code (controller config) | 429 | 429 | `Too Many Requests` instead of the default 503, so clients can back off and dashboards can tell throttling from outages |

**Why these numbers:**

- A real user of this UI makes a few API calls per page action. 20 rps sustained with a 100
  burst is far above that, so humans and page loads with parallel fetches never hit it. A
  script hammering the API is stopped quickly, and a single client can only use a fraction of
  the backend's capacity: each pod handles a few hundred simple req/s, and there are 2–6 pods.
- Release gets more headroom because real users can sit behind a shared NAT IP (offices,
  mobile carriers).
- Limits are per controller replica (nginx keeps counters in memory). With N controller
  replicas the effective limit is up to N × rps. For a global limit, use Redis-backed limiting
  at a gateway.

Verified: 300 parallel requests through the Ingress → **69 × 200, 231 × 429**. 100 parallel
requests to `/` → all 200. `make rate-limit-test` reproduces it.

Rate limiting is a guard against abuse and noisy neighbours, not capacity planning. Long-term
limits should come from load tests and be per API key/user (at a gateway), not just per IP.

---

## Design decisions & trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| **Same-origin `/api`** (nginx proxy in Compose, Ingress in k8s) | one image for all envs, no CORS, no internal hostnames in the browser | frontend nginx needs `BACKEND_URL` |
| **Fail fast on missing secrets, no defaults in code** | a misconfigured deploy fails at startup instead of connecting with a guessable password | local runs need a `.env` (`make env` generates one) |
| **kustomize base + overlays** instead of `sed` on manifests | one source of truth, per-env diffs are small and reviewable, CI only changes the image tag | less flexible than Helm for third-party-style packaging |
| **hostPath PV pinned to a labelled node** | satisfies the explicit PV/PVC requirement on kind | node-local storage: if that node dies, the data is gone until it returns. In the cloud use a CSI StorageClass (EBS/PD) and drop the static PV |
| **Server-side apply** | the API server tracks field ownership; the HPA owns `replicas`, so a deploy never resets a scaled-up backend | `--force-conflicts` makes the deploy tooling the owner of the fields it sets, so manual `kubectl edit` changes are overwritten on the next deploy (intended) |
| **Terraform for cluster + platform add-ons, not the app** | infrastructure changes rarely and needs plan/apply; app releases happen many times a day via CI | `k8s/kind-config.yaml` (used by CI) and `terraform/main.tf` describe the same cluster and must be kept in sync |
| **Helm for third-party, kustomize for our app** | upstream charts are maintained by their authors; our app is simple enough for plain YAML | two tools |
| **ingress-nginx** | suggested by the brief, mature, simple annotations | project retired in 2026; Gateway API is the forward path |
| **Ephemeral kind in CI** | the only way to get a real deploy + smoke test from GitHub-hosted runners for a local-only brief | doesn't deploy to *your* laptop cluster; a real cluster just needs `KUBECONFIG_B64` |
| **Real streaming replica** instead of two URLs to one DB | shows the read/write split and lag behaviour for real (`pg_is_in_recovery() = true`) | more moving parts; failover is manual (no Patroni) |
| **Async indexing via BullMQ** | writes never depend on search availability | search is eventually consistent (ms–s behind) |
| **OpenSearch / Redis on emptyDir** | dev mode; the search index is derived data rebuildable from Postgres | Redis queue contents are lost if the pod is deleted (AOF survives container restarts only) |
| **Security plugin disabled on OpenSearch** | dev mode, as the brief allows | only acceptable because NetworkPolicies restrict it to the backend tier |
| **Loki over Elasticsearch for logs** | a fraction of the RAM, label model fits Kubernetes, same Grafana UI | weaker full-text search than ES |

## What I would do with more time

- **GitOps:** Argo CD / Flux watching `k8s/overlays/*`. CI would only build, scan and commit
  the new tag, and the cluster pulls. No cluster credentials in CI, drift detection, and
  rollback = `git revert`.
- **Secrets:** External Secrets Operator (Vault / AWS Secrets Manager) or Sealed Secrets
  instead of files generated from CI secrets. Encryption at rest for etcd.
- **Database:** CloudNativePG operator (automated failover, backups to object storage, PITR,
  pooler), real migrations tool, PgBouncer, `postgres_exporter` + replica-lag alerts.
- **Progressive delivery:** Argo Rollouts canary (10% → 50% → 100%) gated on the error-rate /
  latency queries above, with automatic abort.
- **Supply chain:** SBOM (syft), image signing (cosign) + admission verification (Kyverno), pin
  base images by digest with Renovate/Dependabot updates.
- **Policies:** Kyverno/Gatekeeper rules (no `latest`, required limits/probes, non-root) and
  egress NetworkPolicies (deny-all except DNS and named dependencies).
- **Tracing:** OpenTelemetry SDK in the backend → Tempo, with trace IDs in the JSON logs, linked
  from Grafana panels.
- **Scaling:** KEDA to scale the BullMQ worker on queue depth; HPA on request rate (custom
  metrics) instead of CPU only; multiple ingress controller replicas.
- **Testing:** integration tests against real Postgres/Redis in CI (service containers),
  frontend tests, k6 load tests with thresholds as a pipeline gate.
- **Alerting:** route Alertmanager to Slack/PagerDuty, SLOs with multi-window burn-rate alerts,
  runbook links in every alert.
- **Hardening:** run Postgres as non-root with `restricted` Pod Security, TLS on the Ingress
  (cert-manager), OpenSearch security plugin enabled.
