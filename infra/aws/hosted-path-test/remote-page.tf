# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

# Deployment-test phone page for remote access. It is served from the same CloudFront origin as the
# control plane, witness, and relay, so the browser binding's worker reaches the witness and the
# page reaches the relay as same-origin requests under a strict CSP. The bucket stays private;
# only this distribution reads it.

resource "aws_s3_bucket" "remote_page" {
  bucket_prefix = "${local.name}-remote-"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "remote_page" {
  bucket                  = aws_s3_bucket.remote_page.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "remote_page" {
  bucket = aws_s3_bucket.remote_page.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "remote_page" {
  bucket = aws_s3_bucket.remote_page.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "remote_page" {
  name                              = "${local.name}-remote-page"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "remote_page" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.remote_page.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "remote_page" {
  bucket     = aws_s3_bucket.remote_page.id
  policy     = data.aws_iam_policy_document.remote_page.json
  depends_on = [aws_s3_bucket_public_access_block.remote_page]
}

# S3 has no directory index behind an origin access control: serve /remote/ as its index.html.
resource "aws_cloudfront_function" "remote_page_index" {
  name    = "${local.name}-remote-index"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var request = event.request;
      if (request.uri === "/remote") {
        return { statusCode: 302, statusDescription: "Found", headers: { location: { value: "/remote/" } } };
      }
      if (request.uri.endsWith("/")) request.uri += "index.html";
      return request;
    }
  JS
}

resource "aws_cloudfront_response_headers_policy" "remote_page" {
  name = "${local.name}-remote-page"

  security_headers_config {
    content_security_policy {
      override                = true
      content_security_policy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = false
      override                   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "no-store"
      override = true
    }
    items {
      header   = "Cross-Origin-Opener-Policy"
      value    = "same-origin"
      override = true
    }
  }
}
