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

# What the phone page needs to sign in; empty without phone sign-in.
output "phone_sign_in" {
  value = local.phone_sign_in ? jsonencode({
    authority = "https://${local.auth_host}"
    clientId  = aws_cognito_user_pool_client.phone[0].id
    provider  = "Google"
  }) : ""
}

# What `axl remote login` needs to sign in; empty without sign-in.
output "daemon_sign_in" {
  value = local.phone_sign_in ? jsonencode({
    authority = "https://${local.auth_host}"
    clientId  = aws_cognito_user_pool_client.daemon[0].id
    provider  = "Google"
  }) : ""
}

output "user_pool_id" {
  value = local.phone_sign_in ? aws_cognito_user_pool.phone[0].id : ""
}

output "remote_page_bucket" {
  value = aws_s3_bucket.remote_page.id
}
