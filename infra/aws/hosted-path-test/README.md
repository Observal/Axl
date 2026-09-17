<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hosted-path deployment test

This stack deploys the Axl control-plane and opaque relay containers to AWS Hyderabad
(`ap-south-2`) for integration testing. It is deliberately fail-closed unless every process receives
`AXL_ENVIRONMENT=deployment-test`.

This is not the production witness topology. It uses one DynamoDB-backed control-plane state table,
one relay task, static test principals, and test-only possession proof. The stack does not enable
E2EE production constructors or change `productionStorageReady`.

The deployment creates a dedicated VPC, two public subnets, an ALB reachable only from the AWS
CloudFront origin-facing prefix list, one CloudFront HTTPS endpoint, two single-task ECS/Fargate
services, immutable ECR repositories, CloudWatch logs, and least-privilege ECS roles. Runtime
secrets are generated outside Terraform and stored in AWS Secrets Manager. Terraform state is
versioned and encrypted in a dedicated private S3 bucket.

Deploy from a clean tracked checkout:

```bash
AWS_PROFILE=axl-deploy infra/aws/hosted-path-test/deploy.sh
```

Run the HTTPS and WebSocket opaque-delivery smoke test again:

```bash
AWS_PROFILE=axl-deploy infra/aws/hosted-path-test/smoke-test.sh
```

Destroy compute and networking resources when testing ends:

```bash
AWS_PROFILE=axl-deploy terraform -chdir=infra/aws/hosted-path-test destroy \
  -var="image_tag=$(git rev-parse --short=12 HEAD)"
```

The ECR repositories, Secrets Manager secret, and Terraform state bucket should be retained until
artifacts and evidence have been reviewed, then removed explicitly if no longer needed.
