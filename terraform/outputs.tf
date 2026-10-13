output "kubeconfig_context" {
  value = "kind-${kind_cluster.this.name}"
}

output "urls" {
  value = {
    app = "http://node-react.local"
  }
}
