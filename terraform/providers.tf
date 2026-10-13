locals {
  k8s = {
    host                   = kind_cluster.this.endpoint
    client_certificate     = kind_cluster.this.client_certificate
    client_key             = kind_cluster.this.client_key
    cluster_ca_certificate = kind_cluster.this.cluster_ca_certificate
  }
}

provider "kind" {}

provider "kubernetes" {
  host                   = local.k8s.host
  client_certificate     = local.k8s.client_certificate
  client_key             = local.k8s.client_key
  cluster_ca_certificate = local.k8s.cluster_ca_certificate
}

provider "helm" {
  kubernetes = local.k8s
}
