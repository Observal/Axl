<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2EE transport preflight

Status: architecture review checkpoint

## Integration base

The private implementation branch is `feature/e2ee-transport`, created from clean `main` commit `ea906d0295ba67f833c49ace408a9573551ea687`.

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

Both HTTP boundaries require injected service authentication and fail closed when it is absent or rejects the request. This checkpoint does not select the production authentication mechanism. Tickets and internal credentials are forbidden in URLs, logs, metrics, and canonical events.

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
38     4     opaque payload length
42     n     opaque payload
```

Receipt and failure frames instead contain one byte at offset 22. Receipt values are `admitted=1` and `forwarded=2`. Failure values follow the order of `RELAY_FAILURE_CODES` in `packages/protocol/src/remote-transport.ts`, starting at 1.

A complete WebSocket message, including this framing, is at most 65,535 bytes. Therefore the largest opaque payload is 65,493 bytes. The relay rejects oversized messages through the WebSocket parser ceiling and checks negotiated limits again before parsing or enqueueing.

`attemptId` is transport-local. Retrying exact opaque bytes uses a new attempt ID while retaining the encrypted request and daemon idempotency identifiers inside the opaque payload. The relay does not define or inspect that payload.

## Receipt meaning

- `admitted`: the relay accepted one valid bounded frame.
- `forwarded`: the relay handed the bytes to the destination socket path.
- `daemon_accepted`: not a relay receipt. It is produced only after daemon authorization and durable acceptance.

A client may remove a mutation from its durable outbox only after `daemon_accepted`.

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
