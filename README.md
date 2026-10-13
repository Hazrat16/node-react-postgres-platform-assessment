# Node + React + Postgres — Production-Style Local Platform

A small full-stack app (React + Node.js/Express + PostgreSQL) being taken, one task at a time,
from "runs on my laptop" to a production-style local platform. The [roadmap](#roadmap) at the
end shows what is done and what comes next.

## Contents

1. [Prerequisites](#prerequisites)
2. [Quick start](#quick-start)
3. [Repository layout](#repository-layout)
4. [Task 1 — Docker Compose](#task-1--docker-compose)
5. [Task 2 — Kubernetes](#task-2--kubernetes)
6. [Task 3 — Ingress as API gateway](#task-3--ingress-as-api-gateway)
7. [Task 4 — CI/CD & multi-environment deployment](#task-4--cicd--multi-environment-deployment)
8. [Design decisions & trade-offs](#design-decisions--trade-offs)
9. [Roadmap](#roadmap)

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

Resources: Compose needs ~1 GB RAM; the Kubernetes setup needs ~3 GB free RAM.

## Quick start

### Docker Compose (Task 1)

```bash
cp .env.example .env          # or `make env` to generate random passwords
docker compose up --build     # or `make up`
```

- UI: http://localhost:8080
- API (debug only, bound to 127.0.0.1): http://localhost:4000/api/health

### Kubernetes (Tasks 2–4)

```bash
make k8s-up
# = terraform apply (kind cluster + ingress-nginx)
#   + build images and `kind load` them
#   + generate k8s/overlays/dev/secrets.env with random passwords
#   + kubectl apply -k k8s/overlays/dev and wait for rollouts

# once: map the Ingress hostnames to localhost
echo "127.0.0.1 node-react.local preprod.node-react.local release.node-react.local" | sudo tee -a /etc/hosts
```

| URL | What |
|---|---|
| http://node-react.local | the app (frontend + `/api`) |

> **Port 80 already in use** (e.g. a local nginx/apache)? Either stop it, or create the cluster
> on another port: `make k8s-up HTTP_PORT=8880` and use `http://node-react.local:8880`.

Other useful targets: `make help`, `make status`,
`make cluster-destroy`.

## Repository layout

```
.
├── backend/                    Express API + BullMQ worker (same image) + unit tests
├── frontend/                   React (Vite) app + nginx config template
├── Dockerfile.backend          multi-stage, non-root
├── Dockerfile.frontend         multi-stage, unprivileged nginx
├── .dockerignore
├── docker-compose.yml          frontend + backend + Postgres
├── .env.example                Compose config template (.env is git-ignored)
├── Makefile                    thin wrappers around the commands in this README
├── k8s/
│   ├── kind-config.yaml        3-node kind cluster (used by CI)
│   ├── base/                   environment-agnostic manifests (kustomize base)
│   ├── overlays/{dev,preprod,release}/   namespace, PV, Ingress, secrets
├── terraform/                  kind cluster + ingress-nginx (Helm)
├── .github/workflows/ci-cd.yml
```

Mapping from the file names suggested in the brief to this repo:

| Suggested | Here | Note |
|---|---|---|
| `namespace-dev.yaml` | `k8s/overlays/dev/namespace-dev.yaml` | one per environment |
| `backend-deployment.yaml`, `backend-service.yaml` | `k8s/base/` | + `backend-pdb.yaml` |
| `frontend-deployment.yaml`, `frontend-service.yaml` | `k8s/base/` | |
| `postgres-statefulset.yaml`, `postgres-service.yaml` | `k8s/base/` | |
| `postgres-pv.yaml` / `postgres-pvc.yaml` | `k8s/overlays/<env>/` / `k8s/base/` | PV is cluster-scoped, so one per env |
| `app-configmap.yaml` | `k8s/base/app-configmap.yaml` | |
| `app-secrets.yaml` | `secretGenerator` in `k8s/overlays/<env>/kustomization.yaml` | built from a git-ignored `secrets.env` — see [Task 2](#task-2--kubernetes) |
| `ingress-dev.yaml` | `k8s/overlays/dev/ingress-dev.yaml` | |

---

## Task 1 — Docker Compose

`docker compose up --build` starts three containers: `frontend`, `backend` and `postgres`.

**Dockerfiles** (both multi-stage, both run as non-root):

| Image | Stages | Final image | Size |
|---|---|---|---|
| `Dockerfile.backend` | `deps` (`npm ci --omit=dev`, BuildKit cache mount) → `runtime` | `node:24-alpine` + prod `node_modules` + `src/` | ~187 MB |
| `Dockerfile.frontend` | `build` (`npm ci && vite build`) → `runtime` | `nginx-unprivileged:1.30-alpine` + static files | ~60 MB |

- Dependency manifests are copied before the source, so code changes don't invalidate the
  `npm ci` layer.
- The build context is the repo root; `.dockerignore` excludes `node_modules`, `.env`, `.git`,
  `k8s/`, docs etc., so they never reach the daemon or an image.
- The backend image also contains the BullMQ worker entrypoint (`node src/worker.js`); it runs
  as its own container from Task 5, with the same image: one build, one scan, one version.

**Networking.** Two networks:

- `web`: frontend ↔ backend
- `data` (`internal: true`): backend ↔ Postgres

The frontend container has no route to any datastore. Only the frontend publishes a port.
Services reach each other by Compose DNS names (`postgres`, `backend`…).

**The browser never talks to `backend:4000`.** That name only resolves inside Docker. The
frontend calls a same-origin `/api`, and its nginx proxies `/api/` to `BACKEND_URL` (a runtime
env var rendered into the nginx config by `envsubst` at container start). The API base URL the
React code uses is the build arg `VITE_API_BASE_URL` (default `/api`). So one frontend image
works in Compose, in Kubernetes and in every environment, with no CORS.

**Configuration / secrets.** All config is environment variables:

- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `VITE_API_BASE_URL` / `BACKEND_URL` for the frontend

Values come from `.env`, which is git-ignored. `docker-compose.yml` uses `${VAR:?}`, so a
missing password fails loudly instead of defaulting. The backend has no credential defaults in
code: `backend/src/config.js` throws on startup if a required variable is missing.
Redis and search are optional: when `REDIS_URL` / `SEARCH_URL` are unset, the API still
serves items and reports those services as `disabled` (they are added in Task 5).

**Startup ordering.** Healthchecks plus `depends_on: condition: service_healthy` bring things up
in order: Postgres → backend → frontend. The backend also retries DB connections
on its own, because ordering at startup doesn't help when the DB restarts later.

**Persistence.** Named volume `postgres_data`. Verified: items survive
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

```bash
kubectl apply --server-side --force-conflicts -k k8s/overlays/dev   # what `make deploy` and CI run
kubectl get all -n dev
```

**Internal vs external.** Every Service is `ClusterIP`:

- `backend-service`
- `frontend-service`
- `postgres-service`

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

- `resources` requests and limits on every container (needed by the scheduler)
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
| `/api` (Prefix, matches `/api` and `/api/*`) | `backend-service:4000` | body size, timeouts |

They're split in two so API-only policy (body size, timeouts) doesn't apply
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
   `/api`, and picks an upstream. ingress-nginx doesn't go through
   the Service's virtual IP. It watches the Service's **EndpointSlices** and load-balances
   straight to the **ready** pod IPs.
3. **Service.** `backend-service` is a stable name + virtual IP whose selector `app=backend`
   defines the endpoint set. Only pods passing readiness are included. Any in-cluster client
   (e.g. the frontend's nginx proxy) uses the ClusterIP, which kube-proxy rules (iptables)
   DNAT to one of those pod IPs.
4. **Pod.** The Express app handles the request and writes with `INSERT … RETURNING` to
   `postgres-service:5432`.
5. **PostgreSQL.** `postgres-service` → `postgres-0`, whose data lives on the PersistentVolume.

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
  it back.

So every green run proves the images, the manifests, the rollout and the request path. The
pipeline is unchanged when a real cluster is added. For a real on-prem/laptop cluster, the
alternatives would be a **self-hosted runner** next to the cluster, or (better) GitOps.

### How CI secrets are stored and used

| Secret | Where | Used for |
|---|---|---|
| `GITHUB_TOKEN` | built-in, short-lived, per run | pushing to GHCR (`packages: write` granted only to the build job; every other job has `contents: read`) |
| `KUBECONFIG_B64` | **Environment** secret (`dev` / `preprod` / `release`) | cluster access; should be a ServiceAccount token whose RBAC is limited to that one namespace |
| `DB_PASSWORD` | Environment secret | written to the git-ignored `secrets.env` → kustomize `secretGenerator` → k8s Secret |
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

## Design decisions & trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| **Same-origin `/api`** (nginx proxy in Compose, Ingress in k8s) | one image for all envs, no CORS, no internal hostnames in the browser | frontend nginx needs `BACKEND_URL` |
| **Fail fast on missing secrets, no defaults in code** | a misconfigured deploy fails at startup instead of connecting with a guessable password | local runs need a `.env` (`make env` generates one) |
| **kustomize base + overlays** instead of `sed` on manifests | one source of truth, per-env diffs are small and reviewable, CI only changes the image tag | less flexible than Helm for third-party-style packaging |
| **hostPath PV pinned to a labelled node** | satisfies the explicit PV/PVC requirement on kind | node-local storage: if that node dies, the data is gone until it returns. In the cloud use a CSI StorageClass (EBS/PD) and drop the static PV |
| **Server-side apply** | the API server tracks field ownership | `--force-conflicts` makes the deploy tooling the owner of the fields it sets, so manual `kubectl edit` changes are overwritten on the next deploy (intended) |
| **Terraform for cluster + platform add-ons, not the app** | infrastructure changes rarely and needs plan/apply; app releases happen many times a day via CI | `k8s/kind-config.yaml` (used by CI) and `terraform/main.tf` describe the same cluster and must be kept in sync |
| **Helm for third-party, kustomize for our app** | upstream charts are maintained by their authors; our app is simple enough for plain YAML | two tools |
| **ingress-nginx** | suggested by the brief, mature, simple annotations | project retired in 2026; Gateway API is the forward path |
| **Ephemeral kind in CI** | the only way to get a real deploy + smoke test from GitHub-hosted runners for a local-only brief | doesn't deploy to *your* laptop cluster; a real cluster just needs `KUBECONFIG_B64` |

## Roadmap

| Task | Status |
|---|---|
| 1. Docker Compose | ✅ done |
| 2. Kubernetes (dev namespace) | ✅ done |
| 3. Ingress / API gateway + Terraform | ✅ done |
| 4. CI/CD & multi-environment deployment | ✅ done |
| 5. Redis, queue, search, read/write DB | planned |
| 6. Observability, autoscaling, rate limiting | planned |
