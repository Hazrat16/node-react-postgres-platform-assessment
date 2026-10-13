# Node + React + Postgres — Production-Style Local Platform

A small full-stack app (React + Node.js/Express + PostgreSQL) being taken, one task at a time,
from "runs on my laptop" to a production-style local platform. The [roadmap](#roadmap) at the
end shows what is done and what comes next.

## Contents

1. [Prerequisites](#prerequisites)
2. [Quick start](#quick-start)
3. [Repository layout](#repository-layout)
4. [Task 1 — Docker Compose](#task-1--docker-compose)
5. [Design decisions & trade-offs](#design-decisions--trade-offs)
6. [Roadmap](#roadmap)

---

## Prerequisites

| Tool | Tested version | Needed for |
|---|---|---|
| Docker (+ Compose v2) | 29.x / Compose 5.x | everything |
| Node.js | 24 | only to run tests outside Docker |

Resources: Compose needs ~1 GB RAM.

## Quick start

### Docker Compose (Task 1)

```bash
cp .env.example .env          # or `make env` to generate random passwords
docker compose up --build     # or `make up`
```

- UI: http://localhost:8080
- API (debug only, bound to 127.0.0.1): http://localhost:4000/api/health

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
```

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

## Design decisions & trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| **Same-origin `/api`** (nginx proxy in Compose) | one image for all envs, no CORS, no internal hostnames in the browser | frontend nginx needs `BACKEND_URL` |
| **Fail fast on missing secrets, no defaults in code** | a misconfigured deploy fails at startup instead of connecting with a guessable password | local runs need a `.env` (`make env` generates one) |

## Roadmap

| Task | Status |
|---|---|
| 1. Docker Compose | ✅ done |
| 2. Kubernetes (dev namespace) | planned |
| 3. Ingress / API gateway + Terraform | planned |
| 4. CI/CD & multi-environment deployment | planned |
| 5. Redis, queue, search, read/write DB | planned |
| 6. Observability, autoscaling, rate limiting | planned |
