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
6. [Design decisions & trade-offs](#design-decisions--trade-offs)
7. [Roadmap](#roadmap)

---

## Prerequisites

| Tool | Tested version | Needed for |
|---|---|---|
| Docker (+ Compose v2) | 29.x / Compose 5.x | everything |
| kind | 0.31 | Kubernetes |
| kubectl | 1.35 | Kubernetes |
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

### Kubernetes (Task 2)

```bash
make cluster-kind   # kind create cluster --config k8s/kind-config.yaml (3 nodes)
make images         # build both images and `kind load` them into the cluster
make deploy         # generate k8s/overlays/dev/secrets.env, kubectl apply -k, wait for rollouts
```

- UI: http://localhost:30080 (frontend `NodePort`, mapped to the host by kind)
- `make status` = `kubectl get all,pvc -n dev`

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
│   ├── kind-config.yaml        3-node kind cluster
│   ├── base/                   environment-agnostic manifests (kustomize base)
│   ├── overlays/dev/           namespace, PV, secrets
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

Everything for an environment lives in its own namespace (`dev`). The
manifests are a **kustomize base + one overlay per environment**, so the same base can later
be deployed to every namespace and only the differences live in the overlays:

- namespace
- Postgres PV
- secrets

```bash
kubectl apply --server-side --force-conflicts -k k8s/overlays/dev   # what `make deploy` runs
kubectl get all -n dev
```

**Internal vs external.** `backend-service` and `postgres-service` are `ClusterIP`: reachable
only inside the cluster. `frontend-service` is a `NodePort` (30080), and kind maps that port
to the host, so the UI is at http://localhost:30080. The frontend's nginx proxies `/api` to
`backend-service`, so the backend never needs to be exposed. (Task 3 replaces the NodePort
with an Ingress.)

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
generates one with random passwords). The generated name
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

## Design decisions & trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| **Same-origin `/api`** (nginx proxy in Compose) | one image for all envs, no CORS, no internal hostnames in the browser | frontend nginx needs `BACKEND_URL` |
| **Fail fast on missing secrets, no defaults in code** | a misconfigured deploy fails at startup instead of connecting with a guessable password | local runs need a `.env` (`make env` generates one) |
| **kustomize base + overlays** instead of `sed` on manifests | one source of truth, per-env diffs are small and reviewable | less flexible than Helm for third-party-style packaging |
| **hostPath PV pinned to a labelled node** | satisfies the explicit PV/PVC requirement on kind | node-local storage: if that node dies, the data is gone until it returns. In the cloud use a CSI StorageClass (EBS/PD) and drop the static PV |
| **Server-side apply** | the API server tracks field ownership | `--force-conflicts` makes the deploy tooling the owner of the fields it sets, so manual `kubectl edit` changes are overwritten on the next deploy (intended) |

## Roadmap

| Task | Status |
|---|---|
| 1. Docker Compose | ✅ done |
| 2. Kubernetes (dev namespace) | ✅ done |
| 3. Ingress / API gateway + Terraform | planned |
| 4. CI/CD & multi-environment deployment | planned |
| 5. Redis, queue, search, read/write DB | planned |
| 6. Observability, autoscaling, rate limiting | planned |
