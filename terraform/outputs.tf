output "kubeconfig_context" {
  value = "kind-${kind_cluster.this.name}"
}

output "grafana_admin_password" {
  value     = random_password.grafana_admin.result
  sensitive = true
}

output "urls" {
  value = {
    app        = "http://node-react.local"
    grafana    = "http://grafana.node-react.local"
    prometheus = "http://prometheus.node-react.local"
  }
}
