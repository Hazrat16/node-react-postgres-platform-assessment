# Cluster add-ons ("platform"), installed in dependency order:
#   metrics-server -> kube-prometheus-stack (brings the ServiceMonitor CRDs)
#   -> ingress-nginx (registers its ServiceMonitor) -> Loki -> Fluent Bit
# The application itself is NOT managed here: it is deployed with kustomize
# by CI / `make deploy`, so app releases don't need a Terraform run.

resource "helm_release" "metrics_server" {
  name       = "metrics-server"
  namespace  = "kube-system"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = var.chart_versions.metrics_server
  values     = [file("${path.module}/values/metrics-server.yaml")]
}

# ---- monitoring --------------------------------------------------------------

resource "kubernetes_namespace_v1" "monitoring" {
  count = var.enable_observability ? 1 : 0
  metadata {
    name = "monitoring"
  }
}

# Grafana admin password: generated, stored in Terraform state and a k8s
# Secret, never in git. Read it with `terraform output -raw grafana_admin_password`.
resource "random_password" "grafana_admin" {
  length  = 24
  special = false
}

resource "kubernetes_secret_v1" "grafana_admin" {
  count = var.enable_observability ? 1 : 0
  metadata {
    name      = "grafana-admin"
    namespace = kubernetes_namespace_v1.monitoring[0].metadata[0].name
  }
  data = {
    admin-user     = "admin"
    admin-password = random_password.grafana_admin.result
  }
}

resource "helm_release" "kube_prometheus_stack" {
  count      = var.enable_observability ? 1 : 0
  name       = "kube-prometheus-stack"
  namespace  = kubernetes_namespace_v1.monitoring[0].metadata[0].name
  repository = "https://prometheus-community.github.io/helm-charts"
  chart      = "kube-prometheus-stack"
  version    = var.chart_versions.kube_prometheus_stack
  timeout    = 900
  values     = [file("${path.module}/../observability/kube-prometheus-stack-values.yaml")]

  depends_on = [kubernetes_secret_v1.grafana_admin]
}

# ---- ingress -----------------------------------------------------------------

resource "helm_release" "ingress_nginx" {
  name             = "ingress-nginx"
  namespace        = "ingress-nginx"
  create_namespace = true
  repository       = "https://kubernetes.github.io/ingress-nginx"
  chart            = "ingress-nginx"
  version          = var.chart_versions.ingress_nginx
  timeout          = 600
  values           = [file("${path.module}/values/ingress-nginx.yaml")]

  set = [{
    name  = "controller.metrics.serviceMonitor.enabled"
    value = tostring(var.enable_observability)
  }]

  depends_on = [helm_release.kube_prometheus_stack]
}

# ---- logging -----------------------------------------------------------------

resource "helm_release" "loki" {
  count            = var.enable_observability ? 1 : 0
  name             = "loki"
  namespace        = "logging"
  create_namespace = true
  repository       = "https://grafana.github.io/helm-charts"
  chart            = "loki"
  version          = var.chart_versions.loki
  timeout          = 600
  values           = [file("${path.module}/../observability/loki-values.yaml")]
}

resource "helm_release" "fluent_bit" {
  count      = var.enable_observability ? 1 : 0
  name       = "fluent-bit"
  namespace  = "logging"
  repository = "https://fluent.github.io/helm-charts"
  chart      = "fluent-bit"
  version    = var.chart_versions.fluent_bit
  values     = [file("${path.module}/../observability/fluentbit-values.yaml")]

  depends_on = [helm_release.loki]
}
