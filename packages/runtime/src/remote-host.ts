// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Remote host for a hosted stack: the control plane, relay, and witness behind one origin.
 *
 * What differs between stacks comes in through `HostedRemoteSettings`: the account's credential,
 * the daemon's relay possession proof, and where the daemon endpoint comes from. The deployment-test
 * stack (`remote-deployment-test.ts`) passes its shared test credentials and the deployment-test
 * Node artifact; production (`remote-production.ts`) passes the signed-in account, the
 * installation's own key, and the hosted WSL artifact.
 *
 * `/remote` (`remote.pairing.start`) creates a fresh crypto session and daemon endpoint, registers
 * it with the hosted witness, and returns a link for the device page. The daemon then waits on the
 * relay for the device's pairing notice, reserves and verifies the claim, publishes the Welcome,
 * and accepts the device's MLS-protected activation. Only then does the ordinary E2EE bridge take
 * over the endpoint and serve the device's requests. Starting a new pairing replaces the previous
 * session; a completed pairing survives daemon restarts, and a restore that fails (the network or
 * the witness is briefly unreachable) is retried with backoff. A `/remote` that fails before it
 * replaces anything goes back to restoring the pairing it interrupted, and tells the terminal why.
 *
 * The device reaches only the sessions shared with it. `/remote` from a session pairs a device and
 * shares that session once the device activates; later shares and unpairing go through the daemon
 * and its authority store.
 *
 * The host writes its log to an owner-only `remote.log` beside its state, because a daemon started
 * by the terminal discards its output, and reports its phase, relay connection, and latest failure
 * through `remote.status`.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  type AxlDaemon,
  DaemonWitnessBarrier,
  DaemonWitnessError,
  type DaemonWitnessOutcome,
  type DaemonWitnessPending,
  type DaemonWitnessResult,
  HostedDaemonWitnessTransport,
  type NativeDaemonE2eeEndpoint,
  RemoteDeviceAuthorityStore,
  type RemotePairingService,
  RemotePairingStartError,
  WindowsRemoteE2eeBridge,
} from "@axl/daemon";
import {
  type CryptoSessionId,
  type DeviceId,
  type InstallationId,
  type OperationId,
  parseCryptoSessionId,
  parseDeviceId,
  parseOperationId,
  parseRemoteE2eeEnvelope,
  parseTransportAttemptId,
  type RelayDelivery,
  type RemoteDeviceScope,
  type RemotePairingStartResult,
  type RemoteStatusResult,
  type SessionId,
} from "@axl/protocol";
import {
  createRemoteDeviceEnrollmentSecret,
  encodeRemotePairingLink,
  HostedPairingClient,
  HttpRelayTicketProvider,
  parseRemotePairingNotice,
  RemoteDeviceControlPlane,
  RemoteRelayConnection,
  sealRemotePairingLink,
  uuidToBytes,
} from "@axl/sdk";

import type { RemoteAccessClaim } from "./remote-claim.ts";

/** Version 2 records the device ID minted for each pairing. */
const STATE_VERSION = 2;
const DEVICE_SCOPES: readonly RemoteDeviceScope[] = ["observe", "steer"];
const HOSTED_GRANT_GENERATION = 1;
/** Probe the relay this often, so a socket that died while the laptop slept is replaced. */
const RELAY_HEARTBEAT_MS = 30_000;
/** A reply waits this long for the relay to reconnect before it is dropped; the device resends. */
const RELAY_RECONNECT_WAIT_MS = 15_000;
const RESTORE_RETRY_MAX_MS = 60_000;
/** How many times one request waits out a witness recovery before the device's resend takes over. */
const WITNESS_RECEIVE_ATTEMPTS = 5;
/** The longest one request waits for the witness to recover before it is tried again. */
const WITNESS_RECEIVE_WAIT_MS = 60_000;
const MAX_LOG_BYTES = 1024 * 1024;

function isActivation(payload: Uint8Array): boolean {
  try {
    return parseRemoteE2eeEnvelope(payload).messageClass === "pair_activation";
  } catch {
    return false;
  }
}

/** Error codes of a connection that never reached the stack. */
const NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Whether `cause`, or an error it wraps, is a request that never reached the stack. */
function unreachable(cause: unknown): boolean {
  let current = cause;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    const { code, name, message } = current as {
      readonly code?: unknown;
      readonly name?: unknown;
      readonly message?: unknown;
    };
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    if (name === "TimeoutError" || (name === "TypeError" && message === "fetch failed"))
      return true;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

/** What the terminal shows for a failed `/remote`: a reason and what to do, nothing internal. */
function startFailure(cause: unknown, origin: string, logPath: string): RemotePairingStartError {
  const code = (cause as { readonly code?: unknown } | undefined)?.code;
  const reason = unreachable(cause)
    ? `Could not reach ${new URL(origin).host}. Check the network, then run /remote again.`
    : code === "sign_in_required" || code === "sign_in_failed" || code === "invalid_account"
      ? "Remote sign-in is no longer valid. Run axl remote login, then /remote again."
      : code === "not_enabled"
        ? "Remote access is not enabled for this account."
        : code === "helper_unavailable"
          ? `The key helper is not available. Details are in ${logPath}.`
          : code === "remote_busy" && cause instanceof Error
            ? cause.message
            : `Remote pairing could not start. Details are in ${logPath}.`;
  return new RemotePairingStartError(reason, { cause });
}

/** An error for the log, with the code and HTTP status that `String()` would drop. */
function describe(cause: unknown): string {
  const { code, status } = (cause ?? {}) as { readonly code?: unknown; readonly status?: unknown };
  const detail = [code, status].filter(
    (part) => typeof part === "string" || typeof part === "number",
  );
  return detail.length === 0 ? String(cause) : `${String(cause)} (${detail.join(" ")})`;
}

/** Settle once the bridge's witness is out of recovery, or after `timeoutMs` regardless. */
function whenWitnessSettles(bridge: WindowsRemoteE2eeBridge, timeoutMs: number): Promise<void> {
  if (bridge.witnessStatus?.state !== "recovering") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stop();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    const stop = bridge.onWitnessState((status) => {
      if (status.state !== "recovering") done();
    });
  });
}

/** Resolve once the relay is connected or closed, or after `timeoutMs`. */
function whenConnected(relay: RemoteRelayConnection, timeoutMs: number): Promise<void> {
  if (relay.state === "connected") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      release();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const release = relay.onState((state) => {
      if (state === "connected" || state === "closed") done();
    });
  });
}

export interface HostedRemoteSettings {
  /** HTTPS origin of the stack: control plane, witness, relay tickets, and the device page. */
  readonly origin: string;
  /** Path of the device page under `origin`, for example `/remote/`. */
  readonly pagePath: string;
  readonly accountId: string;
  readonly installationId: InstallationId;
  /** The account's bearer credential for control-plane requests. */
  accessToken(): Promise<string>;
  /** The daemon's relay admission proof for an issued ticket. */
  possession(ticket: string): Promise<{
    readonly connectionNonce: string;
    readonly possessionProof: Uint8Array;
  }>;
  /** Put in pairing links, for a phone that does not sign in (deployment test only). */
  readonly linkAccessToken?: string;
  /** Run before a pairing starts or a paired session is restored; it may run again. */
  prepare?(): Promise<void>;
  /**
   * Claim remote access among the user's daemons before serving a session, held until the session
   * closes. It rejects with code `remote_busy` while another daemon serves this installation.
   */
  claim?(): Promise<RemoteAccessClaim>;
  /** The daemon endpoint for one crypto session, with its storage under `root`. */
  endpoint(
    root: string,
    accountId: Uint8Array,
    installationId: Uint8Array,
    cryptoSessionId: Uint8Array,
  ): Promise<HostedDaemonEndpoint>;
}

/** The daemon endpoint surface this host drives. */
export interface HostedDaemonEndpoint extends NativeDaemonE2eeEndpoint {
  issue(operationId: Uint8Array): Promise<DaemonWitnessPending>;
  reopen(): Promise<unknown>;
  submitClaim(operationId: Uint8Array, claim: Uint8Array): Promise<DaemonWitnessOutcome>;
  confirmClaim(
    operationId: Uint8Array,
    claimHash: Uint8Array,
    reservationId: Uint8Array,
  ): Promise<DaemonWitnessOutcome>;
  createWelcome(operationId: Uint8Array, reservationId: Uint8Array): Promise<DaemonWitnessOutcome>;
  acceptActivation(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<DaemonWitnessOutcome>;
}

interface HostState {
  readonly version: typeof STATE_VERSION;
  readonly cryptoSessionId: CryptoSessionId;
  /** Minted for this pairing; no other pairing or browser ever uses it. */
  readonly deviceId: DeviceId;
  readonly phase: "pairing" | "paired";
}

interface Session {
  readonly id: CryptoSessionId;
  readonly deviceId: DeviceId;
  readonly endpoint: HostedDaemonEndpoint;
  readonly barrier: DaemonWitnessBarrier<HostedDaemonEndpoint>;
  readonly relay: RemoteRelayConnection;
  /** Serializes pairing work on the endpoint until the bridge owns it. */
  tail: Promise<void>;
  claimHash?: string;
  /** A Welcome the endpoint created whose publication has not succeeded yet. */
  welcome?: {
    readonly claimHash: string;
    readonly publication: Parameters<HostedPairingClient["publishWelcome"]>[0];
  };
  bridge?: WindowsRemoteE2eeBridge;
  /** Shared with the device as soon as it activates this pairing. */
  shareOnPair?: SessionId;
}

/** A fresh UUIDv7: 48-bit millisecond time, version 7, variant 10, random remainder. */
function uuidV7(): OperationId {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return parseOperationId(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

const operation = (): Uint8Array => uuidToBytes(uuidV7());

/** The one typed field a released native result carries. */
function released<T>(result: DaemonWitnessResult, name: string): T {
  const value = (result as unknown as Record<string, unknown>)[name];
  if (value === undefined || value === null) {
    throw new Error(`Daemon endpoint released ${result.tag} where ${name} was expected`);
  }
  return value as T;
}

async function readHostState(root: string): Promise<HostState | undefined> {
  try {
    const value = JSON.parse(await readFile(join(root, "host.json"), "utf8")) as HostState;
    if (value.version !== STATE_VERSION) return undefined;
    return {
      version: STATE_VERSION,
      cryptoSessionId: parseCryptoSessionId(value.cryptoSessionId),
      deviceId: parseDeviceId(value.deviceId),
      phase: value.phase === "paired" ? "paired" : "pairing",
    };
  } catch {
    return undefined;
  }
}

export class HostedRemoteHost implements RemotePairingService {
  readonly #config: HostedRemoteSettings;
  readonly #root: string;
  readonly #authority: RemoteDeviceAuthorityStore;
  readonly #witness: HostedDaemonWitnessTransport;
  readonly #pairing: HostedPairingClient;
  readonly #devices: RemoteDeviceControlPlane;
  readonly #output: (message: string) => void;
  readonly #logPath: string;
  #logWrites: Promise<void> = Promise.resolve();
  #lastError: { readonly message: string; readonly at: number } | undefined;
  #daemon: AxlDaemon | undefined;
  #session: Session | undefined;
  #starting: Promise<RemotePairingStartResult> | undefined;
  #restoreTimer: ReturnType<typeof setTimeout> | undefined;
  /** The restore in progress; a new pairing waits for it so it cannot revive a replaced session. */
  #restoreRun: Promise<void> = Promise.resolve();
  /** Set by `close`: a closed host never restores or retries again. */
  #closed = false;
  #restoring = false;
  /** A failed `/remote` interrupted a pairing it never replaced; restore it once the start settles. */
  #restoreAfterStart = false;
  /** The device of the completed pairing, whether or not its session is being served yet. */
  #paired: DeviceId | undefined;
  /** This daemon's claim on remote access, held while it has a session open. */
  #claim: RemoteAccessClaim | undefined;

  private constructor(
    config: HostedRemoteSettings,
    root: string,
    authority: RemoteDeviceAuthorityStore,
    log: (message: string) => void,
  ) {
    this.#config = config;
    this.#root = root;
    this.#authority = authority;
    this.#output = log;
    this.#logPath = join(root, "remote.log");
    this.#witness = new HostedDaemonWitnessTransport({
      controlPlaneOrigin: config.origin,
      authenticationHeaders: () => this.#headers(),
    });
    this.#pairing = new HostedPairingClient({
      origin: config.origin,
      authorization: () => config.accessToken(),
    });
    this.#devices = new RemoteDeviceControlPlane({
      controlPlaneOrigin: config.origin,
      authenticationHeaders: () => this.#headers(),
    });
  }

  /** Open the host with its state in `root`, which holds nothing but this host's state. */
  static async open(
    settings: HostedRemoteSettings,
    root: string,
    log: (message: string) => void = () => undefined,
  ): Promise<HostedRemoteHost> {
    await mkdir(join(root, "sessions"), { recursive: true, mode: 0o700 });
    const authority = await RemoteDeviceAuthorityStore.open(root, settings.installationId);
    return new HostedRemoteHost(settings, root, authority, log);
  }

  get authority(): RemoteDeviceAuthorityStore {
    return this.#authority;
  }

  /** Attach the running daemon and restore a completed pairing, if one exists. */
  async attach(daemon: AxlDaemon): Promise<void> {
    this.#daemon = daemon;
    const state = await this.#readState();
    if (state?.phase === "paired") this.#paired = state.deviceId;
    this.#restoreRun = this.#restore(0);
    await this.#restoreRun;
  }

  status(): RemoteStatusResult {
    const session = this.#session;
    const deviceOnline =
      session?.relay.routes.some(
        (peer) => peer.role === "device" && peer.deviceId === session.deviceId,
      ) ?? false;
    const witness = session?.bridge?.witnessStatus?.state;
    return {
      phase:
        session?.bridge !== undefined || this.#restoring
          ? "paired"
          : session === undefined
            ? "unpaired"
            : "pairing",
      relay: session?.relay.state ?? "disconnected",
      deviceOnline,
      ...(session === undefined ? {} : { cryptoSessionId: session.id, deviceId: session.deviceId }),
      ...(witness === undefined ? {} : { witness }),
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
      logPath: this.#logPath,
    };
  }

  /** Reopen a completed pairing, retrying with backoff until it succeeds or a new pairing starts. */
  async #restore(attempt: number): Promise<void> {
    this.#restoreTimer = undefined;
    if (this.#closed || this.#session !== undefined || this.#starting !== undefined) return;
    const state = await this.#readState();
    if (state?.phase !== "paired") return;
    this.#restoring = true;
    try {
      await this.#config.prepare?.();
      const session = await this.#openSession(state.cryptoSessionId, state.deviceId);
      await session.endpoint.reopen();
      await this.#serve(session);
      this.#restoring = false;
      if (this.#session !== session) return;
      this.#log(`remote: restored paired session ${state.cryptoSessionId}`);
    } catch (cause) {
      await this.#closeSession();
      if (this.#closed) return;
      const delay = Math.min(RESTORE_RETRY_MAX_MS, 2_000 * 2 ** attempt);
      this.#fail(
        `remote: could not restore the paired session, retrying in ${Math.round(delay / 1_000)} s: ${describe(cause)}`,
      );
      this.#restoreTimer = setTimeout(() => {
        this.#restoreRun = this.#restore(attempt + 1);
      }, delay);
      this.#restoreTimer.unref?.();
    }
  }

  #cancelRestore(): void {
    if (this.#restoreTimer !== undefined) clearTimeout(this.#restoreTimer);
    this.#restoreTimer = undefined;
    this.#restoring = false;
  }

  /** Log a failure and remember it for `remote.status`. */
  #fail(message: string): void {
    this.#lastError = { message: message.slice(0, 1_024), at: Date.now() };
    this.#log(message);
  }

  /** Write to the host's output and its private, size-bounded log file. */
  #log(message: string): void {
    this.#output(message);
    const line = `${new Date().toISOString()} ${message}\n`;
    const path = this.#logPath;
    this.#logWrites = this.#logWrites
      .then(async () => {
        const size = await stat(path).then(
          (info) => info.size,
          () => 0,
        );
        if (size > MAX_LOG_BYTES) await rename(path, `${path}.1`);
        await appendFile(path, line, { mode: 0o600 });
      })
      .catch(() => undefined);
  }

  start(options: { readonly shareSessionId?: SessionId } = {}): Promise<RemotePairingStartResult> {
    this.#starting ??= this.#start(options.shareSessionId).finally(() => {
      this.#starting = undefined;
      if (this.#restoreAfterStart) {
        this.#restoreAfterStart = false;
        this.#restoreRun = this.#restore(0);
      }
    });
    return this.#starting;
  }

  pairedDevice(): DeviceId | undefined {
    return this.#paired;
  }

  /**
   * Remove the paired device: revoke it in the control plane and the authority store, which ends
   * its shares, and forget the pairing so it is not restored. A pairing still waiting for its
   * device is abandoned too.
   */
  async unpair(): Promise<boolean> {
    await this.#starting?.catch(() => undefined);
    this.#cancelRestore();
    await this.#restoreRun;
    await this.#closeSession();
    const state = await this.#readState();
    this.#paired = undefined;
    if (state === undefined) return false;
    await this.#retire(state.deviceId);
    await rm(join(this.#root, "host.json"), { force: true });
    await this.#prune();
    this.#log(`remote: device ${state.deviceId} unpaired`);
    return state.phase === "paired";
  }

  /** Stop retrying and close the current session. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelRestore();
    // A restore already under way finishes, without retrying, before its session is closed.
    await this.#restoreRun;
    await this.#closeSession();
    await this.#logWrites;
  }

  async #headers(): Promise<Readonly<Record<string, string>>> {
    return { authorization: `Bearer ${await this.#config.accessToken()}` };
  }

  async #start(shareOnPair: SessionId | undefined): Promise<RemotePairingStartResult> {
    if (this.#daemon === undefined) throw new Error("The remote host is not attached");
    this.#cancelRestore();
    // `/remote` can arrive while the daemon is still restoring the previous pairing at startup.
    await this.#restoreRun;
    await this.#closeSession();
    // One pairing at a time: the device of the pairing this one replaces loses access for good.
    try {
      await this.#config.prepare?.();
      // Before the current pairing is replaced: another daemon serving remote access keeps it.
      await this.#acquireClaim();
    } catch (cause) {
      this.#fail(`remote: pairing could not start: ${describe(cause)}`);
      // Nothing about the current pairing has changed yet, so go back to serving it.
      this.#restoreAfterStart = true;
      throw startFailure(cause, this.#config.origin, this.#logPath);
    }
    const previous = await this.#readState();
    if (previous !== undefined) {
      this.#paired = undefined;
      await this.#retire(previous.deviceId);
      // Its session is pruned next, so a pairing that fails to start must not restore it.
      await rm(join(this.#root, "host.json"), { force: true });
    }
    const cryptoSessionId = parseCryptoSessionId(uuidV7());
    const deviceId = parseDeviceId(uuidV7());
    const enrollmentSecret = createRemoteDeviceEnrollmentSecret();
    await this.#prune(cryptoSessionId);
    try {
      const session = await this.#openSession(cryptoSessionId, deviceId);
      if (shareOnPair !== undefined) session.shareOnPair = shareOnPair;
      await this.#devices.invite(this.#config.installationId, deviceId, enrollmentSecret);
      const issued = await session.barrier.complete(await session.endpoint.issue(operation()));
      const invitation = released<{ readonly bytes: Uint8Array; readonly expiresAtMs: bigint }>(
        issued,
        "publication",
      );
      // The first fresh read after registration moves an empty hosted witness out of bootstrap.
      await session.barrier.recover();
      await this.#writeState({
        version: STATE_VERSION,
        cryptoSessionId,
        deviceId,
        phase: "pairing",
      });
      await session.relay.start();
      this.#log(`remote: pairing session ${cryptoSessionId} is waiting for a device`);
      const full = encodeRemotePairingLink(`${this.#config.origin}${this.#config.pagePath}`, {
        invitation: invitation.bytes,
        accountId: this.#config.accountId,
        installationId: this.#config.installationId,
        deviceId,
        cryptoSessionId,
        ...(this.#config.linkAccessToken === undefined
          ? {}
          : { accessToken: this.#config.linkAccessToken }),
        enrollmentSecret,
      });
      return {
        link: await this.#shortLink(full, Number(invitation.expiresAtMs)),
        cryptoSessionId,
        deviceId,
        expiresAt: Number(invitation.expiresAtMs),
      };
    } catch (cause) {
      this.#fail(`remote: pairing could not start: ${describe(cause)}`);
      await this.#closeSession();
      throw startFailure(cause, this.#config.origin, this.#logPath);
    }
  }

  /**
   * Revoke a replaced pairing's device in the control plane (no more relay tickets) and in the
   * daemon's authority store (no more requests). Failures are logged, not fatal: the device's
   * session is already gone, and the control plane refuses a device it no longer knows.
   */
  async #retire(deviceId: DeviceId): Promise<void> {
    await this.#devices.revoke(this.#config.installationId, deviceId).catch((cause: unknown) => {
      if ((cause as { readonly code?: unknown }).code === "device_not_found") return;
      this.#fail(`remote: could not revoke device ${deviceId}: ${describe(cause)}`);
    });
    if (this.#authority.snapshot(deviceId) !== undefined) {
      await this.#authority.revokeLocalDevice(deviceId).catch((cause: unknown) => {
        this.#fail(`remote: could not revoke device ${deviceId} locally: ${describe(cause)}`);
      });
    }
    this.#log(`remote: device ${deviceId} revoked`);
  }

  async #acquireClaim(): Promise<void> {
    if (this.#claim === undefined) this.#claim = await this.#config.claim?.();
  }

  async #releaseClaim(): Promise<void> {
    const claim = this.#claim;
    this.#claim = undefined;
    await claim?.release().catch(() => undefined);
  }

  async #openSession(cryptoSessionId: CryptoSessionId, deviceId: DeviceId): Promise<Session> {
    await this.#acquireClaim();
    const endpoint = await this.#config.endpoint(
      join(this.#root, "sessions", cryptoSessionId),
      uuidToBytes(this.#config.accountId),
      uuidToBytes(this.#config.installationId),
      uuidToBytes(cryptoSessionId),
    );
    const relay = new RemoteRelayConnection({
      tickets: new HttpRelayTicketProvider({
        controlPlaneOrigin: this.#config.origin,
        request: { installationId: this.#config.installationId, role: "daemon" },
        authenticationHeaders: () => this.#headers(),
        proof: { create: (ticket) => this.#config.possession(ticket.ticket) },
      }),
      reconnect: { maximumAttempts: 1_000, maximumDelayMs: 30_000 },
      heartbeatMs: RELAY_HEARTBEAT_MS,
    });
    const session: Session = {
      id: cryptoSessionId,
      deviceId,
      endpoint,
      barrier: new DaemonWitnessBarrier(endpoint, this.#witness),
      relay,
      tail: Promise.resolve(),
    };
    relay.onDelivery((delivery) => this.#deliver(session, delivery));
    relay.onFailure((failure) => this.#log(`remote: relay failure ${JSON.stringify(failure)}`));
    relay.onState((state) => this.#log(`remote: relay ${state}`));
    this.#session = session;
    return session;
  }

  /**
   * The link to show: a short one that names the sealed full link parked on the control plane, so
   * the QR code stays small. A control plane that cannot park it gets the full link instead.
   */
  async #shortLink(full: string, expiresAt: number): Promise<string> {
    try {
      const sealed = await sealRemotePairingLink(full);
      await this.#pairing.publishLink({
        version: 1,
        linkId: sealed.linkId,
        sealed: sealed.sealed,
        expiresAt,
      });
      return sealed.shortLink;
    } catch (cause) {
      this.#log(`remote: showing the full pairing link: ${describe(cause)}`);
      return full;
    }
  }

  #deliver(session: Session, delivery: RelayDelivery): void {
    if (session.bridge !== undefined) {
      // The device resends its activation until a request is answered; the first one paired it.
      if (isActivation(delivery.opaquePayload)) return;
      void this.#receive(session, session.bridge, delivery).catch((cause) => {
        const message = `remote: request failed: ${describe(cause)}`;
        // A request the daemon refused was already answered with its reason; it is no fault.
        if ((cause as { readonly name?: unknown }).name === "DaemonError") this.#log(message);
        else this.#fail(message);
      });
      return;
    }
    const run = session.tail.then(() => this.#pairingStep(session, delivery));
    session.tail = run.catch((cause) =>
      this.#fail(`remote: pairing step failed: ${describe(cause)}`),
    );
  }

  /**
   * Hand one request to the bridge. A witness that is recovering (a restarted control plane)
   * refuses it before anything is committed, and the device resends only when its connection
   * changes, so the request is received again once the witness recovers, exactly as a resend
   * would be.
   */
  async #receive(
    session: Session,
    bridge: WindowsRemoteE2eeBridge,
    delivery: RelayDelivery,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await bridge.receive({
          sourceRouteId: delivery.sourceRouteId,
          opaqueEnvelope: delivery.opaquePayload,
        });
        return;
      } catch (cause) {
        const unavailable =
          cause instanceof DaemonWitnessError && cause.code === "witness_unavailable";
        if (!unavailable || attempt >= WITNESS_RECEIVE_ATTEMPTS || this.#session !== session) {
          throw cause;
        }
        await whenWitnessSettles(bridge, WITNESS_RECEIVE_WAIT_MS);
        if (this.#session !== session) throw cause;
      }
    }
  }

  async #pairingStep(session: Session, delivery: RelayDelivery): Promise<void> {
    if (this.#session !== session) return;
    if (session.bridge !== undefined) {
      // Queued behind the activation that handed the endpoint to the bridge.
      if (isActivation(delivery.opaquePayload)) return;
      await session.bridge.receive({
        sourceRouteId: delivery.sourceRouteId,
        opaqueEnvelope: delivery.opaquePayload,
      });
      return;
    }
    const claimHash = parseRemotePairingNotice(delivery.opaquePayload);
    if (claimHash !== undefined) {
      await this.#acceptClaim(session, claimHash);
      return;
    }
    const envelope = parseRemoteE2eeEnvelope(delivery.opaquePayload);
    if (envelope.messageClass === "application_request" && session.claimHash !== undefined) {
      // The device sends its first request right behind its activation and resends both until a
      // request is answered. One that arrives first, because the relay lost the activation, is
      // dropped here and comes again after the activation.
      return;
    }
    if (envelope.messageClass !== "pair_activation" || session.claimHash === undefined) {
      throw new Error(`Unexpected ${envelope.messageClass} before pairing completed`);
    }
    released(
      await session.barrier.mutate((endpoint) =>
        endpoint.acceptActivation(
          uuidToBytes(envelope.operationId),
          uuidToBytes(envelope.logicalMessageId),
          envelope.ciphertext,
        ),
      ),
      "activation",
    );
    await this.#writeState({
      version: STATE_VERSION,
      cryptoSessionId: session.id,
      deviceId: session.deviceId,
      phase: "paired",
    });
    this.#paired = session.deviceId;
    this.#log(`remote: device ${session.deviceId} paired`);
    // Shared before the bridge serves the device, so its first request already sees the session.
    if (session.shareOnPair !== undefined) {
      await this.#authority
        .shareSession(session.deviceId, session.shareOnPair)
        .catch((cause: unknown) =>
          this.#fail(`remote: could not share the session with the new device: ${describe(cause)}`),
        );
    }
    await this.#serve(session);
  }

  /** Reserve the noticed claim, verify it in the endpoint, and publish the Welcome. */
  async #acceptClaim(session: Session, claimHash: Uint8Array): Promise<void> {
    const hashText = Buffer.from(claimHash).toString("hex");
    if (session.claimHash !== undefined) {
      // One claim per pairing session; a repeated notice for it needs no work.
      if (session.claimHash !== hashText) throw new Error("A different claim was already accepted");
      return;
    }
    if (session.welcome !== undefined) {
      // The endpoint already holds this claim's Welcome; only its publication is retried.
      if (session.welcome.claimHash !== hashText) {
        throw new Error("A different claim was already accepted");
      }
      await this.#publishWelcome(session);
      return;
    }
    const reservationId = uuidV7();
    const binding = {
      version: 1 as const,
      installationId: this.#config.installationId,
      deviceId: session.deviceId,
      cryptoSessionId: session.id,
      claimHash,
      reservationId,
    };
    const reservation = await this.#pairing.reserveClaim(binding);
    const submitted = released<{ readonly hash: Uint8Array }>(
      await session.barrier.mutate((endpoint) =>
        endpoint.submitClaim(operation(), reservation.claim),
      ),
      "publication",
    );
    await session.barrier.mutate((endpoint) =>
      endpoint.confirmClaim(operation(), submitted.hash, uuidToBytes(reservationId)),
    );
    const welcome = released<{ readonly bytes: Uint8Array }>(
      await session.barrier.mutate((endpoint) =>
        endpoint.createWelcome(operation(), uuidToBytes(reservationId)),
      ),
      "welcome",
    );
    await this.#authority.registerLocalDevice(session.deviceId, DEVICE_SCOPES);
    await this.#authority.applyHostedGrant(
      session.deviceId,
      HOSTED_GRANT_GENERATION,
      DEVICE_SCOPES,
    );
    session.welcome = {
      claimHash: hashText,
      publication: {
        ...binding,
        welcome: welcome.bytes,
        welcomeHash: new Uint8Array(createHash("sha384").update(welcome.bytes).digest()),
      },
    };
    await this.#publishWelcome(session);
  }

  async #publishWelcome(session: Session): Promise<void> {
    const pending = session.welcome;
    if (pending === undefined) return;
    await this.#pairing.publishWelcome(pending.publication);
    session.claimHash = pending.claimHash;
    delete session.welcome;
    this.#log("remote: claim accepted and Welcome published");
  }

  /** Hand the paired endpoint to the E2EE bridge and serve the device's requests. */
  async #serve(session: Session): Promise<void> {
    const daemon = this.#daemon;
    if (daemon === undefined) throw new Error("The remote host is not attached");
    const bridge = new WindowsRemoteE2eeBridge({
      daemon,
      deviceId: session.deviceId,
      authority: this.#authority,
      endpoint: session.endpoint,
      witness: this.#witness,
      sender: {
        // Wait out a short relay reconnect instead of dropping the reply; the device resends
        // unanswered requests, and the bridge replays cached replies, if the wait runs out.
        send: async (route, envelope) => {
          await whenConnected(session.relay, RELAY_RECONNECT_WAIT_MS);
          session.relay.send(route, parseTransportAttemptId(randomUUID()), envelope);
        },
      },
      onError: (error) => this.#fail(`remote: ${error.message}`),
      onRecoveryFailure: (error) =>
        this.#log(`remote: witness recovery failed, retrying: ${describe(error)}`),
    });
    session.bridge = bridge;
    session.relay.onRoutes((peers) => bridge.observeRelayRoutes(peers));
    bridge.observeRelayRoutes(session.relay.routes);
    await bridge.start();
    // A session replaced while its bridge started must not reconnect a second daemon route.
    if (this.#session !== session) {
      await bridge.shutdown();
      return;
    }
    await session.relay.start();
  }

  async #closeSession(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    if (session !== undefined) {
      session.relay.close();
      if (session.bridge === undefined) session.endpoint.close();
      else await session.bridge.shutdown();
    }
    await this.#releaseClaim();
  }

  /** Forget every session directory except `keep`. */
  async #prune(keep?: CryptoSessionId): Promise<void> {
    const sessions = join(this.#root, "sessions");
    for (const entry of await readdir(sessions).catch(() => [] as string[])) {
      if (entry !== keep) await rm(join(sessions, entry), { recursive: true, force: true });
    }
  }

  async #readState(): Promise<HostState | undefined> {
    return readHostState(this.#root);
  }

  /**
   * Forget the pairing stored in `root` while no daemon serves it: revoke its device in the
   * authority store, which ends its shares, and remove the pairing so it is never restored.
   * Resolves whether a device had paired.
   */
  static async forget(root: string, installationId: InstallationId): Promise<boolean> {
    const state = await readHostState(root);
    if (state === undefined) return false;
    const authority = await RemoteDeviceAuthorityStore.open(root, installationId);
    if (authority.snapshot(state.deviceId) !== undefined) {
      await authority.revokeLocalDevice(state.deviceId);
    }
    await rm(join(root, "host.json"), { force: true });
    await rm(join(root, "sessions"), { recursive: true, force: true });
    return state.phase === "paired";
  }

  async #writeState(state: HostState): Promise<void> {
    const path = join(this.#root, "host.json");
    const staging = `${path}.next`;
    await writeFile(staging, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(staging, path);
  }
}
