# Convenience wrapper. Every target is a thin alias for commands documented
# in the README, so nothing here is magic.
SHELL := /bin/bash
ENV ?= dev
CLUSTER ?= node-react
# Host port for the Ingress (use e.g. HTTP_PORT=8880 if something already listens on 80)
HTTP_PORT ?= 80
OVERLAY := k8s/overlays/$(ENV)

.PHONY: help env up down logs test cluster cluster-kind cluster-destroy secrets images deploy observability k8s-up hosts load-test load-test-clean rate-limit-test status

help: ## Show targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-18s %s\n", $$1, $$2}'

# ---- Docker Compose (Task 1) -------------------------------------------------
env: ## Create .env with random passwords (if missing)
	@test -f .env || { cp .env.example .env; \
	  for k in DB_PASSWORD REPLICATION_PASSWORD REDIS_PASSWORD; do \
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
cluster: ## Create kind cluster + ingress, metrics-server, Prometheus/Grafana, Loki, Fluent Bit (Terraform)
	terraform -chdir=terraform init -upgrade
	terraform -chdir=terraform apply -auto-approve -var ingress_http_port=$(HTTP_PORT)
	kubectl apply --server-side --force-conflicts -k observability/

cluster-kind: ## Alternative without Terraform: plain kind + ingress-nginx + metrics-server only
	kind create cluster --config k8s/kind-config.yaml
	helm upgrade --install ingress-nginx ingress-nginx --repo https://kubernetes.github.io/ingress-nginx \
	  --version 4.15.1 -n ingress-nginx --create-namespace -f terraform/values/ingress-nginx.yaml --wait
	helm upgrade --install metrics-server metrics-server --repo https://kubernetes-sigs.github.io/metrics-server/ \
	  --version 3.14.0 -n kube-system -f terraform/values/metrics-server.yaml --wait

cluster-destroy: ## Delete the cluster
	terraform -chdir=terraform destroy -auto-approve || kind delete cluster --name $(CLUSTER)

secrets: ## Generate k8s/overlays/$(ENV)/secrets.env with random passwords (if missing)
	@test -f $(OVERLAY)/secrets.env || { \
	  for k in DB_PASSWORD REPLICATION_PASSWORD REDIS_PASSWORD; do echo "$$k=$$(openssl rand -hex 16)"; done \
	  > $(OVERLAY)/secrets.env; echo "created $(OVERLAY)/secrets.env"; }

images: ## Build images and load them into kind
	docker build -f Dockerfile.backend -t node-react-backend:local .
	docker build -f Dockerfile.frontend -t node-react-frontend:local .
	kind load docker-image node-react-backend:local node-react-frontend:local --name $(CLUSTER)

deploy: secrets ## Apply the $(ENV) overlay and wait for rollouts
	@# Ingress objects are validated by the ingress-nginx admission webhook, which
	@# can still be starting right after `make cluster` - wait for it, then retry.
	kubectl -n ingress-nginx wait --for=condition=ready pod -l app.kubernetes.io/component=controller --timeout=300s
	for i in 1 2 3 4 5; do kubectl apply --server-side --force-conflicts -k $(OVERLAY) && break; \
	  [ $$i = 5 ] && exit 1; echo "apply failed (attempt $$i), retrying in 10s"; sleep 10; done
	kubectl -n $(ENV) rollout status statefulset/postgres --timeout=180s
	kubectl -n $(ENV) rollout status statefulset/postgres-replica --timeout=300s
	kubectl -n $(ENV) rollout status deployment/backend --timeout=180s
	kubectl -n $(ENV) rollout status deployment/frontend --timeout=120s
	kubectl -n $(ENV) rollout status deployment/bullmq-worker --timeout=120s

observability: ## (Re)apply ServiceMonitor, alert rules, Grafana dashboard
	kubectl apply --server-side --force-conflicts -k observability/

k8s-up: cluster images deploy hosts ## Everything: cluster + platform + app in dev

hosts: ## Print the /etc/hosts line needed for the Ingress hostnames
	@echo "Add this to /etc/hosts (once):"
	@echo "127.0.0.1 node-react.local preprod.node-react.local release.node-react.local grafana.node-react.local prometheus.node-react.local"

status: ## kubectl get all in $(ENV)
	kubectl get all,ingress,pvc,hpa,networkpolicy -n $(ENV)

load-test: ## Generate CPU load on the backend from inside the cluster to trigger the HPA
	kubectl -n $(ENV) delete pod load-generator --ignore-not-found
	kubectl -n $(ENV) apply -f k8s/tools/load-test.yaml
	@echo "watch: kubectl -n $(ENV) get hpa backend-hpa -w"

load-test-clean: ## Remove the load generator and its NetworkPolicy
	kubectl -n $(ENV) delete -f k8s/tools/load-test.yaml --ignore-not-found

rate-limit-test: ## Fire 300 requests through the Ingress and count status codes (expect 429s)
	@for i in $$(seq 1 300); do curl -s -o /dev/null -w '%{http_code}\n' --resolve node-react.local:$(HTTP_PORT):127.0.0.1 http://node-react.local:$(HTTP_PORT)/api/health & done | sort | uniq -c; wait
