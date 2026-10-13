# Local "infrastructure": a multi-node kind cluster. In a cloud setup this
# file is where an EKS/GKE/AKS module would go; everything layered on top
# (platform.tf, the app manifests) stays the same.

resource "kind_cluster" "this" {
  name            = var.cluster_name
  node_image      = var.node_image
  wait_for_ready  = true
  kubeconfig_path = pathexpand("~/.kube/config")

  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"

    # Control-plane also runs the ingress controller, with ports 80/443
    # mapped to the host so http://node-react.local works.
    node {
      role = "control-plane"
      labels = {
        "ingress-ready" = "true"
      }
      extra_port_mappings {
        container_port = 80
        host_port      = var.ingress_http_port
        protocol       = "TCP"
      }
      extra_port_mappings {
        container_port = 443
        host_port      = var.ingress_https_port
        protocol       = "TCP"
      }
    }

    # The first worker carries the label the Postgres hostPath PV is pinned to.
    dynamic "node" {
      for_each = range(var.worker_count)
      content {
        role   = "worker"
        labels = node.key == 0 ? { "node-react/storage" = "true" } : {}
      }
    }
  }
}
