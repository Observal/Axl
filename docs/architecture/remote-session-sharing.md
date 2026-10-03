<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Remote session sharing

Status: accepted by the owner for implementation; the security review still applies. It amends [Production remote access from a WSL daemon](remote-production-wsl.md) and [Remote daemon authority](remote-daemon-authority.md).

## Purpose

Today `/remote` pairs a phone with the whole daemon. Once paired, the phone lists the machine's recent sessions and can open, resume, and steer any of them until the pairing is revoked. That is more authority than the feature needs, and more than a lost or compromised phone should carry.

This amendment separates two things that are currently one:

- **Pairing** (once): the phone and the installation establish trust. This is the existing QR flow, device enrollment, and MLS session, unchanged.
- **Sharing** (every `/remote`): the daemon lets the paired phone reach one session, for as long as that session is shared.

The phone can reach only sessions that are shared at that moment. Running `/remote` in a session shares it, and the session opens on the phone without a new QR code.

It also bounds the witness's per-pairing storage and its journal, which both grow with every message today. Push notifications, so a share can reach a phone whose page is closed, are designed here and deferred to a later slice.

Out of scope: packaging the daemon artifacts into releases, folding `axl remote login` into `/remote`, macOS and Linux desktop daemons (separate amendments), and more than one phone.

## User experience

In the terminal:

- **First `/remote` on a machine with no phone:** the existing pairing flow. The QR code appears; scanning it pairs the phone and shares the current session in the same step.
- **Every later `/remote`:** no QR code. The session is shared, and the terminal says so: `Shared with your phone. /remote stop to stop sharing.`
- **`/remote stop`:** stops sharing the current session.
- **`/remote unpair`:** removes the phone. Every share ends with it.

On the phone:

- An open page receives the share at once and opens that session. If the phone is already showing a conversation, it shows a banner for the new share instead of switching away.
- The page lists only the sessions that are currently shared. With none, it says: `Run /remote in a session to open it here.`
- When a share ends, the page closes that conversation and says it is no longer shared.
- A closed page learns about a share through a push notification, if the person turned those on (see [Push notifications](#push-notifications)). Otherwise the share is there the next time the page opens.

## One phone

An installation has at most one paired phone. Pairing a new phone revokes the previous device, as pairing again does today, and ends every share. The share model below is written per device so that a second phone could be added later without changing it, but nothing in this amendment enables that.

## Share authorization

### The share set

The daemon keeps the set of shared session IDs for the paired device in its authority record (`remote-authority.json`, see [Remote daemon authority](remote-daemon-authority.md#persistence)), with the same persistence rules: owner-only file, atomic replacement, and strict parsing. Each entry records the session ID, when it was shared, and the device generation it was shared with.

The share set narrows the device's existing grant. The effective authority for a request is:

```text
device scopes (observe, steer)  ∩  hosted grant  ∩  session is in the share set
```

A share can never add a scope. An `--unsafe` daemon still grants only `observe`, now for shared sessions only.

### Enforcement

The daemon checks every remote request, after authentication and before dispatch:

| Request kind | Check |
|---|---|
| Names a session (`session.subscribe`, `session.resume`, `session.send`, `session.steer`, `session.interrupt`, `session.interaction.respond`, `session.workspace.*`, and the other steering methods) | The session is in the share set. |
| Names a subscription or snapshot (`session.history`, `session.ack`, `session.unsubscribe`) | The subscription belongs to this connection, and its session is still in the share set. |
| `session.list` | Removed from the remote allowlist. The phone learns its sessions from share notices instead. |
| Anything else | Unchanged: denied unless it is in the allowlist. |

A request for a session that is not shared fails with a new `session_not_shared` error. It is indistinguishable from a request for a session that does not exist, so the phone cannot probe for session IDs.

Enforcement lives only in the daemon, the trusted endpoint. The relay and control plane see ciphertext and cannot widen the share set: share notices and requests travel inside the MLS session like any other message.

### Share notices

A new daemon-to-device message, `remote.shares`, carries the whole current share set: for each session its ID, title, working directory, and when it was shared. It is sent:

- whenever the share set changes;
- whenever the phone's relay route appears, so a phone that reconnects learns the current set; and
- in reply to the device's first request after it connects.

A notice is always the full set, never a delta, so a lost notice is repaired by the next one.

### When a share ends

A share ends when:

- `/remote stop` runs in that session;
- the session is deleted;
- the phone is unpaired or replaced, or its device generation is revoked; or
- the daemon's account signs out (`axl remote logout`); or
- 24 hours pass with no activity in the shared session.

Activity is any remote request for the session, any input to it from the terminal, and any event the session itself records, so a turn that runs for hours never idles out. The share entry keeps the time of its last activity, written at most once a minute, and the daemon checks it once a minute and at startup. A share that idled out while the daemon was stopped ends when the daemon starts.

When a share ends, the daemon removes it from the share set, closes the device's subscriptions to that session, drops their snapshots and cursors, and sends a new notice. A request already in flight for that session is refused when it is dispatched, not answered.

A daemon restart does not end a share. Sessions close when the daemon restarts; the phone may reopen a shared session with `session.resume`, which is a `steer` request like before, and only for a session in the share set. Quitting the terminal does not end a share either: the daemon keeps running the session, and watching a long task from the phone after walking away is the main use.

## Witness compaction

### The problem

The witness keeps one record per lineage (one lineage per endpoint and pairing). The record is append-only: every advance adds a ledger event, an accepted operation, and a retained response. On the owner's deployment a pairing reached 208 operations and about 865 KB per replica in one day of use, about 4 KB per message per replica. With pairings that last for months, that is unbounded storage, and every load and cache miss reads the full record.

### What the history is for

- **Ledger events** rebuild the current head. They also keep every earlier head's successor, so an advance from an older head with a different successor is recorded as a fork (`conflicting_successor` or `historical_fork`) and the lineage is quarantined.
- **Accepted operations** make a retried operation idempotent: the same operation ID returns the same result and receipt. A different request under a known operation ID is refused as `operation_conflict`.
- **Retained responses** return the exact receipt for a request the witness has already answered.
- **Recovery request hashes** keep a recovery read from being used twice.
- **The high-water journal** is a separate write-once table holding one entry per ledger sequence. A record table rolled back behind its journal is detected at restart.

### Proposal

Keep a bounded window of recent history and a checkpoint for everything before it:

- **Checkpoint:** the record carries a checkpoint of the head (sequence, revocation generation, counter, commitment, and predecessor commitment) at the start of the window. The ledger holds only the events after it. Rebuild starts from the checkpoint instead of from the zero head.
- **Window:** the most recent K successors, accepted operations, and retained responses are kept in full, with K = 32. A step is one message sealed or opened by one endpoint, so a window of 32 covers seconds to minutes of activity, not 32 prompts. The endpoint barrier retries only its current operation, so a window of one would serve correct endpoints, and 32 leaves room for slow retries.
- **Recovery hashes:** kept as 48-byte hashes until the recovery request they block can no longer be valid. If recovery requests carry no validity bound, all of them are kept: they are small and rare.
- **Journal:** superseded journal entries are pruned. A separate principal, holding only `Scan` and `DeleteItem` on the journal table, runs on a schedule and removes every entry older than a lineage's newest, never the newest itself. The witness service keeps no delete permission on the journal, so neither the record table's credentials nor the journal's writer can rewrite or remove the entry a restart checks against. On the owner's stack the journal held 2,367 entries (1.3 MB, about 535 bytes each) after four days; pruned, it holds one entry per lineage and replica.
- **Terminal lineages:** a revoked or forked lineage is reduced to its checkpoint and terminal event, because nothing can advance it again.

A compaction step is an ordinary conditional write: the checkpoint and the removal of the entries it covers commit in one transaction on the record's revision, so a concurrent step either sees the old record or the compacted one.

Storage per lineage then stays at about K times 4 KB per replica, about 130 KB at K = 32, however long the pairing lives.

### What the review must accept

Compaction changes what the witness can prove about old history. An advance from a head older than the window, or a replay of an operation older than it, is no longer compared against its recorded successor. The witness still refuses it, because it only accepts a successor of the current head, but it answers `stale_expected` instead of recording a fork and quarantining the lineage.

The rollback protection itself is unchanged: a rolled-back endpoint cannot advance. What is lost is the *record* of a fork older than K steps. Against that:

- the endpoint's own reconciliation still sees a witness head ahead of its local state and fails with `rollback_detected`; and
- a replayed old request can no longer quarantine a lineage, which removes a denial-of-service path that full history keeps open to anyone holding captured request bytes.

An operation ID older than the window could be reused with a different request and be accepted if it is a valid successor of the current head. Operation IDs exist for idempotency, not for authorization, so this grants nothing; the review should confirm that reading.

## Push notifications

Deferred: push is not in the first slice. A share reaches the phone over the relay whenever the page is connected, and is there the next time the page opens. This section records the design for the later slice.

### Design

Push uses standard Web Push (RFC 8030, message encryption per RFC 8291, VAPID per RFC 8292):

- **Phone opt-in:** the page offers `Notify me when a session is shared`. The browser's permission prompt runs only from that tap. The resulting push subscription (endpoint URL and keys) is registered with the control plane under the device, authorized by the phone's token and the device's possession proof. Unpairing deletes it.
- **Service worker:** `/remote/sw.js`, scoped to `/remote/` and served `no-cache`. On a push it shows a fixed notification; on a tap it focuses or opens `/remote/`, which connects, reads the share notice, and opens the session.
- **Sending:** when the daemon shares a session and the device has no relay route, it asks the control plane to notify the installation's paired device. The control plane checks that the installation belongs to the caller's account and has that device, signs with its VAPID key (kept in Secrets Manager), and sends through the browser vendor's push service. The push has a short TTL, 10 minutes as proposed, and is rate limited per installation.

### What a push carries

Nothing about the session. The payload is empty or a fixed string, and the notification text is fixed: `A session was shared from your computer.` Titles, paths, and content arrive only over the end-to-end encrypted channel after the page opens. A push grants no authority; it only prompts the phone to open the page.

### Platform limits

- **Android Chrome and desktop browsers:** supported from the page.
- **iPhone and iPad:** Web Push works only for a web app added to the Home Screen, on iOS 16.4 or later. The page needs a web app manifest, and on iOS it shows how to add it to the Home Screen before offering notifications.

### Privacy and exposure

- The control plane learns when shares happen and stores the push subscription. The subscription endpoint is a capability URL, so it is kept like a secret and removed on unpair.
- The browser vendor's push service (Apple, Google, or Mozilla) learns that a notification was sent to that device, and when.
- Without push, neither learns anything new. Push is off until the person turns it on.

Push is best effort. A share never depends on it: the notice reaches the phone over the relay whenever the page is connected.

## Security properties

Compared with the daemon-scoped pairing in [Production remote access from a WSL daemon](remote-production-wsl.md):

- **A lost or stolen phone** reaches only the sessions shared at that moment, and loses them when they stop being shared, without re-pairing. Before, it reached every session on the machine until the pairing was revoked.
- **The daemon remains the only authority.** Shares are decided in the terminal, stored in the daemon's authority record, and enforced at dispatch. No server-side state can widen them.
- **Session enumeration closes.** The phone no longer lists sessions, and unshared session IDs are refused like unknown ones.

Non-claims:

- A compromised phone holds full `steer` over every session shared while it is compromised.
- A compromised daemon or terminal is out of scope, as before.
- Workspace reads for a shared session expose that session's workspace files to the phone, as they do today for any session.

## Migration

Existing pairings stay valid; nobody re-pairs. After the daemon upgrades, the share set starts empty, so the phone shows no sessions until `/remote` runs in one. A phone page from before the upgrade still calls `session.list`, which is refused; it shows an error until it reloads with the new page.

Witness compaction applies to existing lineages the first time each one advances after the upgrade.

## Evidence before enabling

Recorded in `docs/evidence/`, in addition to the WSL amendment's list:

- **Sharing:** share, stop, unpair, delete, and account sign-out, each checked against every remote method for the shared session, another session, and an unknown session.
- **Lifetime:** daemon restart with a share, then phone resume; terminal quit with a share; a share ending while the phone has a request in flight.
- **Compaction:** lineages crossing the window, crash between compaction steps, a replay of an operation older than the window, rollback of an endpoint to before the window, and restart recovery on a compacted record.
- **Idle end:** a share idling out while the daemon runs and while it is stopped, and a long turn that keeps a share alive.
- **Journal pruning:** pruning racing appends, the newest entry surviving every run, and restart recovery after pruning.
- **Push (later slice):** Android Chrome and an iOS Home Screen web app, permission refused, subscription expired, and unpair removing the subscription.

## Decisions

Made by the owner:

1. **Pairing:** once per phone, with one phone per installation.
2. **Sharing:** every later `/remote` shares the current session; the phone reaches only shared sessions.
3. **Lifetime:** a share survives daemon restarts and terminal exits, and ends when stopped, when its session is deleted, on unpair or sign-out, or after 24 hours without activity.
4. **Compaction:** a checkpoint plus a window of K = 32 steps.
5. **Journal:** pruned by a separate delete-only principal, keeping each lineage's newest entry.
6. **Push:** deferred to a later slice.

For the security review: losing fork records older than the window, as described in [What the review must accept](#what-the-review-must-accept).
