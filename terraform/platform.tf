# Cluster add-ons ("platform"). The application itself is NOT managed here:
# it is deployed with kustomize (`make deploy`, CI), so app releases don't
# need a Terraform run.

resource "helm_release" "ingress_nginx" {
  name             = "ingress-nginx"
  namespace        = "ingress-nginx"
  create_namespace = true
  repository       = "https://kubernetes.github.io/ingress-nginx"
  chart            = "ingress-nginx"
  version          = var.chart_versions.ingress_nginx
  timeout          = 600
  values           = [file("${path.module}/values/ingress-nginx.yaml")]
}
