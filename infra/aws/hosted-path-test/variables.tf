# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

variable "aws_region" {
  description = "AWS region for the deployment-test stack."
  type        = string
  default     = "ap-south-2"

  validation {
    condition     = var.aws_region == "ap-south-2"
    error_message = "This deployment-test stack is intentionally pinned to Hyderabad (ap-south-2)."
  }
}

variable "image_tag" {
  description = "Immutable source revision used as both container image tags."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{7,40}$", var.image_tag))
    error_message = "image_tag must be a Git commit identifier."
  }
}

variable "domain_name" {
  description = "Optional public host name, such as remote.observal.io. Its parent must be a Route 53 zone in this account."
  type        = string
  default     = ""

  validation {
    condition     = var.domain_name == "" || can(regex("^([a-z0-9-]+\\.){2,}[a-z]+$", var.domain_name))
    error_message = "domain_name must be a lowercase host name below a zone, or empty."
  }
}

variable "google_client_id" {
  description = "Optional Google OAuth client ID for phone sign-in. Needs domain_name and the client secret in SSM."
  type        = string
  default     = ""
}

variable "google_client_secret_parameter" {
  description = "SSM SecureString parameter holding the Google OAuth client secret."
  type        = string
  default     = "/axl-hosted-test/google-oauth-client-secret"
}

variable "secret_name" {
  description = "Existing Secrets Manager JSON secret populated outside Terraform."
  type        = string
  default     = "axl/hosted-path/deployment-test"
}

variable "witness_secret_name" {
  description = "Existing Secrets Manager secret holding the three deployment-test witness signing keys."
  type        = string
  default     = "axl/hosted-path/witness-keys"
}

variable "control_plane_mode" {
  description = "deployment-test (the static test account and credentials) or production (Cognito accounts in the remote group, per-installation daemon keys). Production needs sign-in."
  type        = string
  default     = "deployment-test"

  validation {
    condition     = contains(["deployment-test", "production"], var.control_plane_mode)
    error_message = "control_plane_mode must be deployment-test or production."
  }
}
