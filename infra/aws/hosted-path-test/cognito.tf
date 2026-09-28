# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

# Phone sign-in: a Cognito user pool that federates Google, answered on auth.<domain_name>. The
# phone page signs in with the authorization code flow and PKCE and sends the pool's access token
# where it used to send the account token from the pairing link; the control plane grants those
# tokens the phone scope only (pairing and running a device, never the daemon's routes). It needs
# the custom domain, a Google OAuth client ID, and that client's secret in SSM.

locals {
  phone_sign_in = local.custom_domain && var.google_client_id != ""
  auth_host     = "auth.${var.domain_name}"
  # The page signs in and returns here; the fragment of a pairing link waits in session storage.
  phone_callback = "https://${var.domain_name}/remote/"
}

data "aws_ssm_parameter" "google_client_secret" {
  count           = local.phone_sign_in ? 1 : 0
  name            = var.google_client_secret_parameter
  with_decryption = true
}

resource "aws_cognito_user_pool" "phone" {
  count               = local.phone_sign_in ? 1 : 0
  name                = "${local.name}-phone"
  deletion_protection = "INACTIVE"

  # Nobody signs up with a password: accounts arrive through Google only.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }
}

resource "aws_cognito_identity_provider" "google" {
  count         = local.phone_sign_in ? 1 : 0
  user_pool_id  = aws_cognito_user_pool.phone[0].id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = var.google_client_id
    client_secret    = data.aws_ssm_parameter.google_client_secret[0].value
    authorize_scopes = "openid email"
  }

  attribute_mapping = {
    email    = "email"
    username = "sub"
  }
}

resource "aws_cognito_user_pool_client" "phone" {
  count                                = local.phone_sign_in ? 1 : 0
  name                                 = "${local.name}-phone-page"
  user_pool_id                         = aws_cognito_user_pool.phone[0].id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email"]
  callback_urls                        = [local.phone_callback]
  logout_urls                          = [local.phone_callback]
  supported_identity_providers         = [aws_cognito_identity_provider.google[0].provider_name]
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  access_token_validity                = 60
  id_token_validity                    = 60
  refresh_token_validity               = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

# Cognito's custom domain takes a us-east-1 certificate, like CloudFront.
resource "aws_acm_certificate" "auth" {
  count             = local.phone_sign_in ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = local.auth_host
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "auth_certificate_validation" {
  for_each = local.phone_sign_in ? {
    for option in aws_acm_certificate.auth[0].domain_validation_options :
    option.domain_name => option
  } : {}

  zone_id         = data.aws_route53_zone.public[0].zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "auth" {
  count                   = local.phone_sign_in ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.auth[0].arn
  validation_record_fqdns = [for record in aws_route53_record.auth_certificate_validation : record.fqdn]
}

resource "aws_cognito_user_pool_domain" "phone" {
  count                 = local.phone_sign_in ? 1 : 0
  domain                = local.auth_host
  certificate_arn       = aws_acm_certificate_validation.auth[0].certificate_arn
  user_pool_id          = aws_cognito_user_pool.phone[0].id
  managed_login_version = 1

  # Cognito requires the parent host to resolve before it accepts the custom domain.
  depends_on = [aws_route53_record.public]
}

resource "aws_route53_record" "auth" {
  for_each = local.phone_sign_in ? toset(["A", "AAAA"]) : toset([])

  zone_id = data.aws_route53_zone.public[0].zone_id
  name    = local.auth_host
  type    = each.key

  alias {
    name                   = aws_cognito_user_pool_domain.phone[0].cloudfront_distribution
    zone_id                = aws_cognito_user_pool_domain.phone[0].cloudfront_distribution_zone_id
    evaluate_target_health = false
  }
}
