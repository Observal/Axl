<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2EE transport preflight

Status: architecture review checkpoint

## Integration base

The private implementation branch is `feature/e2ee-transport`. It was created from clean `main` commit `ea906d0295ba67f833c49ace408a9573551ea687` and rebased for integration onto clean `main` commit `57bd31b7e718a125fc51a0fcf3a554cb100ea708`.

## Scope

This checkpoint proves bounded opaque transport. It does not provide E2EE or production remote control.

Allowed work is limited to:

- the TypeScript control-plane boundary and deterministic in-memory stores
- one-use relay tickets and authenticated internal admission
- the Elixir/OTP WebSocket relay
- opaque structural schemas and cross-language fixtures
- bounded routing, queues, heartbeat, lease expiry, revocation, draining, and rate limits
- later daemon authorization and SDK delivery tests behind a test-only fake E2EE adapter

Person 1 exclusively owns PQXDH, Triple Ratchet, pairing cryptography, signatures, cryptographic prekey validation and consumption, cryptographic replay behavior, secure key and ratchet storage, encryption and decryption, associated data, attachment cryptography, and cryptographic test vectors.

PQXDH plus Triple Ratchet is the approved direction and supersedes earlier Noise selections. No production cryptography may be implemented or enabled until Person 1 supplies an approved RFC, exact suite, reviewed library, secure-state contract, and interoperability fixtures and the integrated result passes independent review.

## Service ownership

`services/control-plane` is the only hosted component allowed to mutate account, installation, device, ticket, prekey, grant, upload-reservation, quota, and security-audit state. This slice implements ticket state only. Authentication, authorization, proof verification, clocks, and persistence are injected. Test adapters are deterministic and are not production defaults.

`services/relay` owns ticket-authenticated WebSocket admission and bounded in-memory routing. It has no database access, E2EE dependency, RPC knowledge, canonical history, durable mailbox, or attachment storage. The relay derives the source route from consumed-ticket state and never accepts it from a sender.

The daemon remains authoritative for grants, revocation, session authorization, idempotency, durable acceptance, canonical JSONL, and execution. Cryptographic authentication will identify a sender but will never authorize a command.

## Internal service contract

The relay sends `POST /internal/v1/relay/tickets/consume` once during admission. The exact JSON request and response fixture is `packages/protocol/test/fixtures/internal-relay-api-v1.json`. Binary proof bytes use canonical base64 in JSON. The control plane validates the body at runtime and atomically consumes one unexpired ticket. One concurrent consumer succeeds. Replays fail.

The control plane sends `POST /internal/v1/revocations` to the relay. The same fixture defines its versioned request and response. Notifications are best effort. The daemon will still recheck current authority before durable command acceptance.

Both HTTP boundaries require injected service authentication and fail closed when it is absent or rejects the request. Tickets and internal credentials are forbidden in URLs, logs, metrics, and canonical events.

Production service authentication is distinct from user authentication and ticket proof. It answers whether this exact relay instance may consume tickets and whether this exact control-plane instance may revoke routes. TLS without client authentication protects bytes in transit but does not establish that caller authority. The production mechanism remains an owner decision because it depends on deployment identity:

- Prefer mutually authenticated TLS with short-lived workload certificates when both services have stable workload identities.
- A cloud-native signed workload token is acceptable when the selected platform provides audience-bound, short-lived service identities.
- Do not use a long-lived static bearer secret as the production design.
- Bind credentials to service role, environment, and endpoint audience. Rotate them without reconnecting existing leased clients.
- Authenticate the exact request body before parsing it, reject replays within the chosen mechanism, and redact all credential material.

The current code therefore injects authentication on both sides and provides no production credential implementation. Selecting mTLS, SPIFFE, or a cloud IAM mechanism waits for the deployment decision. Tests use obvious fixture credentials only.

If the control plane is unavailable, new admissions fail. Existing connections continue only through their consumed-ticket lease.

## WebSocket admission

Clients connect to `/v1/connect` with compression disabled. They do not put a ticket in the URL. The first binary message is bounded JSON with exactly:

```json
{
  "version": 1,
  "ticket": "opaque",
  "connectionNonce": "opaque",
  "possessionProof": "canonical-base64"
}
```

The relay adds its own instance ID and calls the control plane. Proof bytes and proof verification are fake and test-only in this checkpoint. No production proof construction is implied.

## Binary relay framing

`packages/protocol/test/fixtures/remote-transport-v1.json` is the byte-level cross-language fixture. Every integer is unsigned big-endian. UUIDs use their 16 RFC 9562 bytes.

```text
bytes  size  field
0      4     ASCII AXLR
4      1     transport version (1)
5      1     kind: send=1, delivery=2, receipt=3, failure=4
6      16    transport attempt UUID
```

Send and delivery continue with:

```text
22     16    destination route for send; source route for delivery
38     n     opaque payload through the end of the WebSocket message
```

The revised encoding deliberately has no inner payload-length field. One binary WebSocket message is exactly one relay frame, so the WebSocket message boundary is authoritative. Removing the duplicate untrusted length avoids a second allocation decision and one class of inconsistent-length input.

Receipt and failure frames instead contain one byte at offset 22. Receipt values are `admitted=1` and `forwarded=2`. Failure values are permanently assigned as follows:

```text
1  bad_frame                       7  destination_offline
2  unsupported_transport_version   8  rate_limited
3  unauthorized                    9  queue_full
4  forbidden_route                10  slow_consumer
5  ticket_expired                 11  service_unavailable
6  ticket_consumed
```

These assignments must not be reordered. A new failure receives a new number or requires a transport-version change.

A complete WebSocket message, including this framing, is at most 65,535 bytes. Therefore the largest opaque payload is 65,497 bytes. The relay rejects oversized messages through the WebSocket parser ceiling and checks negotiated limits again before parsing or enqueueing.

`attemptId` is transport-local. Retrying exact opaque bytes uses a new attempt ID while retaining the encrypted request and daemon idempotency identifiers inside the opaque payload. The relay does not define or inspect that payload.

## Receipt meaning

- `admitted`: the relay accepted one valid bounded frame.
- `forwarded`: the relay enqueued the bytes into the destination WebSocket process after route and queue checks. It does not prove a network write, endpoint receipt, parsing, decryption, or daemon acceptance.
- `daemon_accepted`: not a relay receipt. It is produced only after daemon authorization and durable acceptance.

A client may remove a mutation from its durable outbox only after `daemon_accepted`.

## Approved relay dependencies

The first relay slice uses pinned Bandit, Plug, and WebSock Adapter production dependencies. They are approved for this boundary. Cowboy was evaluated and rejected after its locked version reported active security advisories. Credo, Dialyxir, and mix_audit are development-only checks.

## Reviewed limits

```text
maximum complete relay frame: 65,535 bytes
pending bytes per connection: 512 KiB
heartbeat interval:           20 seconds
idle timeout:                 60 seconds
maximum ticket lifetime:      60 seconds
```

## Review boundary

Stop here after the documentation, CI boundaries, fixtures, ticket-consumption path, and first bounded relay slice pass. Daemon authorization, SDK outbox behavior, prekey storage, S3 transport, real E2EE integration, ordinary-session steering, and permission approvals require the next reviewed milestone.
