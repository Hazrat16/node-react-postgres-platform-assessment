variable "cluster_name" {
  description = "kind cluster name"
  type        = string
  default     = "node-react"
}

variable "node_image" {
  description = "kindest/node image (pins the Kubernetes version)"
  type        = string
  default     = "kindest/node:v1.35.0"
}

variable "worker_count" {
  description = "Number of worker nodes"
  type        = number
  default     = 2
}

variable "ingress_http_port" {
  description = "Host port mapped to the ingress controller's port 80 (change if 80 is taken)"
  type        = number
  default     = 80
}

variable "ingress_https_port" {
  description = "Host port mapped to the ingress controller's port 443"
  type        = number
  default     = 443
}

# Chart versions are pinned so `terraform apply` is reproducible.
variable "chart_versions" {
  type = map(string)
  default = {
    ingress_nginx = "4.15.1"
  }
}
