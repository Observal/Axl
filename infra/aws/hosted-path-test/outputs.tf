# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

output "control_plane_url" {
  value = "https://${local.public_host}"
}

output "relay_url" {
  value = "wss://${local.public_host}/v1/connect"
}

output "cloudfront_url" {
  value = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "control_plane_repository_url" {
  value = aws_ecr_repository.control_plane.repository_url
}

output "relay_repository_url" {
  value = aws_ecr_repository.relay.repository_url
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "remote_page_url" {
  value = "https://${local.public_host}/remote/"
}

output "remote_page_bucket" {
  value = aws_s3_bucket.remote_page.id
}
