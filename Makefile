# Convenience wrapper. Every target is a thin alias for commands documented
# in the README, so nothing here is magic.
SHELL := /bin/bash
ENV ?= dev
CLUSTER ?= node-react
OVERLAY := k8s/overlays/$(ENV)

.PHONY: help env up down logs test cluster-kind cluster-destroy secrets images deploy status

help: ## Show targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-18s %s\n", $$1, $$2}'

# ---- Docker Compose (Task 1) -------------------------------------------------
env: ## Create .env with random passwords (if missing)
	@test -f .env || { cp .env.example .env; \
	  for k in DB_PASSWORD; do \
	    sed -i "s/^$$k=.*/$$k=$$(openssl rand -hex 16)/" .env; done; \
	  echo "created .env"; }

up: env ## docker compose up (build + start everything)
	docker compose up --build -d --wait
	@echo "UI: http://localhost:$${FRONTEND_PORT:-8080}"

down: ## Stop compose (keeps volumes; use `docker compose down -v` to wipe data)
	docker compose down

logs: ## Tail compose logs
	docker compose logs -f --tail=50

test: ## Run backend tests + frontend build
	cd backend && npm ci && npm run lint && npm test
	cd frontend && npm ci && npm run build

# ---- Kubernetes (Task 2) -----------------------------------------------------
cluster-kind: ## Create the 3-node kind cluster
	kind create cluster --config k8s/kind-config.yaml

cluster-destroy: ## Delete the cluster
	kind delete cluster --name $(CLUSTER)

secrets: ## Generate k8s/overlays/$(ENV)/secrets.env with random passwords (if missing)
	@test -f $(OVERLAY)/secrets.env || { \
	  for k in DB_PASSWORD; do echo "$$k=$$(openssl rand -hex 16)"; done \
	  > $(OVERLAY)/secrets.env; echo "created $(OVERLAY)/secrets.env"; }

images: ## Build images and load them into kind
	docker build -f Dockerfile.backend -t node-react-backend:local .
	docker build -f Dockerfile.frontend -t node-react-frontend:local .
	kind load docker-image node-react-backend:local node-react-frontend:local --name $(CLUSTER)

deploy: secrets ## Apply the $(ENV) overlay and wait for rollouts
	kubectl apply --server-side --force-conflicts -k $(OVERLAY)
	kubectl -n $(ENV) rollout status statefulset/postgres --timeout=180s
	kubectl -n $(ENV) rollout status deployment/backend --timeout=180s
	kubectl -n $(ENV) rollout status deployment/frontend --timeout=120s

status: ## kubectl get all in $(ENV)
	kubectl get all,pvc -n $(ENV)
