<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hosted-path deployment-test evidence

Date: 2026-09-17

This is deployment-test evidence only. It is not production release evidence and does not enable
`productionStorageReady`.

## Environment

- AWS account: `897545289576`
- Region: Hyderabad (`ap-south-2`)
- Terraform state: encrypted, versioned S3 backend with DynamoDB locking
- Compute: one ECS/Fargate control-plane task and one ECS/Fargate relay task
- Edge transport: CloudFront HTTPS/WSS endpoint using its default certificate; a custom-domain TLS policy remains a production gate
- Origin: Application Load Balancer restricted to the CloudFront origin-facing managed prefix list
- State: DynamoDB on-demand table with server-side encryption, TTL, and point-in-time recovery
- Secrets: AWS Secrets Manager, injected through the ECS task execution role
- Images: immutable ECR tag `d6d6c1e9bd21`
- Control-plane digest: `sha256:f185778a7904633399e7426b530628073629869e081f808a638f70bf63b7c7de`
- Relay digest: `sha256:dbc2b0d871e1a996339071af3e35752726c471564b2a374487484d0220aeca27`
- Logs: CloudWatch log groups with 14-day retention

## Deployed endpoint

- Control plane: `https://d4z52xxwwvaep.cloudfront.net`
- Relay: `wss://d4z52xxwwvaep.cloudfront.net/v1/connect`

## Verified behavior

The deployment script waited for both ECS services to become stable and then exercised the public
CloudFront endpoint. The smoke test verified:

1. HTTPS health response;
2. authenticated claim publication;
3. atomic claim reservation;
4. exact Welcome publication and retrieval;
5. Welcome acknowledgement;
6. one-use relay-ticket issuance and consumption;
7. WebSocket admission; and
8. byte-identical opaque payload delivery from a device route to a daemon route.

The latest successful smoke-test result was:

```json
{"region":"ap-south-2","controlPlane":"healthy","pairing":"passed","relay":"opaque-delivery-passed"}
```

## Local daemon and device through the deployed relay

RC commit `1c77c13` was tested with a local `AxlDaemon`, local durable native daemon and device
OpenMLS endpoints, the real SDK delivery coordinator, and the deployed CloudFront relay endpoint.
Credentials were read from Secrets Manager into process environment only and were not written to the
repository or test output.

The test acquired separate daemon and device tickets over HTTPS, admitted both local endpoints over
WSS, delivered an MLS-encrypted `daemon.info` request and response, then completed an Update
proposal, daemon commit, epoch-ready message, and MLS-protected confirmation. It also verified that
the native outbox drained and that neither bridge reported an error. Two consecutive runs passed
after correcting invalid client-originated WebSocket close codes exposed by the first retry run.

The complete Node binding run reported 13 passed tests and no skips. The live relay case completed in
approximately eight seconds on each successful run.

## Deliberate limitations

The deployed services reject any environment mode other than `deployment-test`. Authentication and
possession proof use randomly generated test credentials stored in Secrets Manager. Witness replicas
are not deployed. No daemon is deployed as a hosted service; the daemon connection above was local,
temporary, and used test-only native storage. Production identity, independent witness failure
domains, workload authentication, signed Windows artifacts, installer evidence, and independent
security review remain release gates.
