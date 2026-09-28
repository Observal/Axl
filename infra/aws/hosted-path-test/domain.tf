# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

# Optional public host name for the stack. With `domain_name` set, CloudFront answers on it with an
# ACM certificate validated in its Route 53 zone (the domain's parent, in this account), the relay
# URL handed to clients uses it, and the CloudFront host name redirects the phone page there.
# Without it, the stack is reached on its CloudFront host name as before.

# CloudFront takes certificates from us-east-1 only.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "Axl"
      Environment = "deployment-test"
      ManagedBy   = "Terraform"
    }
  }
}

locals {
  custom_domain = var.domain_name != ""
  domain_labels = split(".", var.domain_name)
  zone_name     = join(".", slice(local.domain_labels, 1, length(local.domain_labels)))
  public_host   = local.custom_domain ? var.domain_name : aws_cloudfront_distribution.main.domain_name
}

data "aws_route53_zone" "public" {
  count        = local.custom_domain ? 1 : 0
  name         = local.zone_name
  private_zone = false
}

resource "aws_acm_certificate" "public" {
  count             = local.custom_domain ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = local.custom_domain ? {
    for option in aws_acm_certificate.public[0].domain_validation_options :
    option.domain_name => option
  } : {}

  zone_id         = data.aws_route53_zone.public[0].zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "public" {
  count                   = local.custom_domain ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.public[0].arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

resource "aws_route53_record" "public" {
  for_each = local.custom_domain ? toset(["A", "AAAA"]) : toset([])

  zone_id = data.aws_route53_zone.public[0].zone_id
  name    = var.domain_name
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

# The bare host opens the phone page; every other path still reaches the control plane.
resource "aws_cloudfront_function" "root_redirect" {
  name    = "${local.name}-root-redirect"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var request = event.request;
      if (request.uri === "/") {
        return { statusCode: 302, statusDescription: "Found", headers: { location: { value: "/remote/" } } };
      }
      return request;
    }
  JS
}
