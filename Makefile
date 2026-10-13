# Convenience wrapper. Every target is a thin alias for commands documented
# in the README, so nothing here is magic.
SHELL := /bin/bash
ENV ?= dev
CLUSTER ?= node-react
OVERLAY := k8s/overlays/$(ENV)
# Host port for the Ingress (use e.g. HTTP_PORT=8880 if something already listens on 80)
HTTP_PORT ?= 80

.PHONY: help env up down logs test cluster cluster-kind cluster-destroy secrets images deploy k8s-up hosts status

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

# ---- Kubernetes (Tasks 2-6) --------------------------------------------------
cluster: ## Create kind cluster + ingress-nginx (Terraform)
	terraform -chdir=terraform init -upgrade
	terraform -chdir=terraform apply -auto-approve -var ingress_http_port=$(HTTP_PORT)

cluster-kind: ## Alternative without Terraform: plain kind + ingress-nginx
	kind create cluster --config k8s/kind-config.yaml
	helm upgrade --install ingress-nginx ingress-nginx --repo https://kubernetes.github.io/ingress-nginx \
	  --version 4.15.1 -n ingress-nginx --create-namespace -f terraform/values/ingress-nginx.yaml --wait

cluster-destroy: ## Delete the cluster
	terraform -chdir=terraform destroy -auto-approve || kind delete cluster --name $(CLUSTER)

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

k8s-up: cluster images deploy hosts ## Everything: cluster + ingress + app in dev

hosts: ## Print the /etc/hosts line needed for the Ingress hostnames
	@echo "Add this to /etc/hosts (once):"
	@echo "127.0.0.1 node-react.local preprod.node-react.local release.node-react.local"

status: ## kubectl get all in $(ENV)
	kubectl get all,ingress,pvc -n $(ENV)
