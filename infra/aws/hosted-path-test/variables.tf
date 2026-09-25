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
