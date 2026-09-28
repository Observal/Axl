// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Remote host for the hosted deployment-test stack.
 *
 * It is enabled only when `AXL_REMOTE_DEPLOYMENT_TEST` names a configuration file, and it is not a
 * production remote host: the stack has one account, one installation, one device identity, and
 * shared test credentials, and the daemon endpoint comes from the deployment-test Node artifact
 * (build-pinned hosted witness trust, owner-only file keys).
 *
 * `/remote` (`remote.pairing.start`) creates a fresh crypto session and daemon endpoint, registers
 * it with the hosted witness, and returns a link for the device page. The daemon then waits on the
 * relay for the device's pairing notice, reserves and verifies the claim, publishes the Welcome,
 * and accepts the device's MLS-protected activation. Only then does the ordinary E2EE bridge take
 * over the endpoint and serve the device's requests. Starting a new pairing replaces the previous
 * session; a completed pairing survives daemon restarts, and a restore that fails (the network or
 * the witness is briefly unreachable) is retried with backoff.
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
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type AxlDaemon,
  DaemonWitnessBarrier,
  type DaemonWitnessOutcome,
  type DaemonWitnessPending,
  type DaemonWitnessResult,
  HostedDaemonWitnessTransport,
  type NativeDaemonE2eeEndpoint,
  RemoteDeviceAuthorityStore,
  type RemotePairingService,
  WindowsRemoteE2eeBridge,
} from "@axl/daemon";
import {
  type CryptoSessionId,
  type DeviceId,
  type InstallationId,
  type OperationId,
  parseCryptoSessionId,
  parseDeviceId,
  parseInstallationId,
  parseOperationId,
  parseRemoteE2eeEnvelope,
  parseTransportAttemptId,
  type RelayDelivery,
  type RemoteDeviceScope,
  type RemotePairingStartResult,
  type RemoteStatusResult,
} from "@axl/protocol";
import {
  createRemoteDeviceEnrollmentSecret,
  encodeRemotePairingLink,
  HostedPairingClient,
  HttpRelayTicketProvider,
  parseRemotePairingNotice,
  RemoteDeviceControlPlane,
  RemoteRelayConnection,
  uuidToBytes,
} from "@axl/sdk";

const CONFIG_VERSION = 1;
/** Version 2 records the device ID minted for each pairing. */
const STATE_VERSION = 2;
const DEVICE_SCOPES: readonly RemoteDeviceScope[] = ["observe", "steer"];
const HOSTED_GRANT_GENERATION = 1;
/** Probe the relay this often, so a socket that died while the laptop slept is replaced. */
const RELAY_HEARTBEAT_MS = 30_000;
/** A reply waits this long for the relay to reconnect before it is dropped; the device resends. */
const RELAY_RECONNECT_WAIT_MS = 15_000;
const RESTORE_RETRY_MAX_MS = 60_000;
const MAX_LOG_BYTES = 1024 * 1024;

function isActivation(payload: Uint8Array): boolean {
  try {
    return parseRemoteE2eeEnvelope(payload).messageClass === "pair_activation";
  } catch {
    return false;
  }
}

/** An error for the log, with the code and HTTP status that `String()` would drop. */
function describe(cause: unknown): string {
  const { code, status } = (cause ?? {}) as { readonly code?: unknown; readonly status?: unknown };
  const detail = [code, status].filter(
    (part) => typeof part === "string" || typeof part === "number",
  );
  return detail.length === 0 ? String(cause) : `${String(cause)} (${detail.join(" ")})`;
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

export interface DeploymentTestRemoteConfig {
  /** HTTPS origin of the stack: control plane, witness, relay tickets, and the device page. */
  readonly origin: string;
  /** Path of the device page under `origin`, for example `/remote/`. */
  readonly pagePath: string;
  readonly accountId: string;
  readonly installationId: InstallationId;
  readonly accessToken: string;
  /** The daemon's relay possession proof. Each device proves its own key instead. */
  readonly possessionProof: Uint8Array;
  /** Path of the deployment-test Node binding loader (`dist/deployment-test/loader/index.js`). */
  readonly binding: string;
}

function text(value: unknown, name: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`Remote deployment-test configuration ${name} is invalid`);
  }
  return value;
}

export async function loadDeploymentTestRemoteConfig(
  path: string,
): Promise<DeploymentTestRemoteConfig> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (value.version !== CONFIG_VERSION) {
    throw new TypeError("Remote deployment-test configuration version is unsupported");
  }
  const origin = new URL(text(value.origin, "origin"));
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new TypeError("Remote deployment-test origin must be a bare HTTPS origin");
  }
  const pagePath = text(value.pagePath, "pagePath");
  if (!pagePath.startsWith("/") || !pagePath.endsWith("/")) {
    throw new TypeError("Remote deployment-test pagePath must start and end with /");
  }
  const binding = text(value.binding, "binding");
  return {
    origin: origin.origin,
    pagePath,
    accountId: text(value.accountId, "accountId", 36),
    installationId: parseInstallationId(value.installationId),
    accessToken: text(value.accessToken, "accessToken"),
    possessionProof: new Uint8Array(
      Buffer.from(text(value.possessionProof, "possessionProof"), "base64"),
    ),
    binding: isAbsolute(binding) ? binding : resolve(path, "..", binding),
  };
}

/** The deployment-test daemon endpoint surface this host drives. */
interface DeploymentTestDaemonEndpoint extends NativeDaemonE2eeEndpoint {
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

interface DeploymentTestBinding {
  deploymentTestDaemonEndpoint(
    root: string,
    accountId: Uint8Array,
    installationId: Uint8Array,
    cryptoSessionId: Uint8Array,
  ): DeploymentTestDaemonEndpoint;
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
  readonly endpoint: DeploymentTestDaemonEndpoint;
  readonly barrier: DaemonWitnessBarrier<DeploymentTestDaemonEndpoint>;
  readonly relay: RemoteRelayConnection;
  /** Serializes pairing work on the endpoint until the bridge owns it. */
  tail: Promise<void>;
  claimHash?: string;
  bridge?: WindowsRemoteE2eeBridge;
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

export class DeploymentTestRemoteHost implements RemotePairingService {
  readonly #config: DeploymentTestRemoteConfig;
  readonly #root: string;
  readonly #authority: RemoteDeviceAuthorityStore;
  readonly #witness: HostedDaemonWitnessTransport;
  readonly #pairing: HostedPairingClient;
  readonly #devices: RemoteDeviceControlPlane;
  readonly #output: (message: string) => void;
  readonly #logPath: string;
  #logWrites: Promise<void> = Promise.resolve();
  #lastError: { readonly message: string; readonly at: number } | undefined;
  #binding: Promise<DeploymentTestBinding> | undefined;
  #daemon: AxlDaemon | undefined;
  #session: Session | undefined;
  #starting: Promise<RemotePairingStartResult> | undefined;
  #restoreTimer: ReturnType<typeof setTimeout> | undefined;
  /** The restore in progress; a new pairing waits for it so it cannot revive a replaced session. */
  #restoreRun: Promise<void> = Promise.resolve();
  #restoring = false;

  private constructor(
    config: DeploymentTestRemoteConfig,
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
      authenticationHeaders: async () => this.#headers(),
    });
    this.#pairing = new HostedPairingClient({
      origin: config.origin,
      authorization: async () => config.accessToken,
    });
    this.#devices = new RemoteDeviceControlPlane({
      controlPlaneOrigin: config.origin,
      authenticationHeaders: async () => this.#headers(),
    });
  }

  static async open(
    config: DeploymentTestRemoteConfig,
    stateDirectory: string,
    log: (message: string) => void = () => undefined,
  ): Promise<DeploymentTestRemoteHost> {
    const root = join(stateDirectory, "remote-deployment-test");
    await mkdir(join(root, "sessions"), { recursive: true, mode: 0o700 });
    const authority = await RemoteDeviceAuthorityStore.open(root, config.installationId);
    return new DeploymentTestRemoteHost(config, root, authority, log);
  }

  get authority(): RemoteDeviceAuthorityStore {
    return this.#authority;
  }

  /** Attach the running daemon and restore a completed pairing, if one exists. */
  async attach(daemon: AxlDaemon): Promise<void> {
    this.#daemon = daemon;
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
    if (this.#session !== undefined || this.#starting !== undefined) return;
    const state = await this.#readState();
    if (state?.phase !== "paired") return;
    this.#restoring = true;
    try {
      const session = await this.#openSession(state.cryptoSessionId, state.deviceId);
      await session.endpoint.reopen();
      await this.#serve(session);
      this.#restoring = false;
      if (this.#session !== session) return;
      this.#log(`remote: restored paired session ${state.cryptoSessionId}`);
    } catch (cause) {
      await this.#closeSession();
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

  start(): Promise<RemotePairingStartResult> {
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  /** Stop retrying and close the current session. */
  async close(): Promise<void> {
    this.#cancelRestore();
    await this.#closeSession();
    await this.#logWrites;
  }

  #headers(): Readonly<Record<string, string>> {
    return { authorization: `Bearer ${this.#config.accessToken}` };
  }

  async #start(): Promise<RemotePairingStartResult> {
    if (this.#daemon === undefined) throw new Error("The remote host is not attached");
    this.#cancelRestore();
    // `/remote` can arrive while the daemon is still restoring the previous pairing at startup.
    await this.#restoreRun;
    await this.#closeSession();
    // One pairing at a time: the device of the pairing this one replaces loses access for good.
    const previous = await this.#readState();
    if (previous !== undefined) await this.#retire(previous.deviceId);
    const cryptoSessionId = parseCryptoSessionId(uuidV7());
    const deviceId = parseDeviceId(uuidV7());
    const enrollmentSecret = createRemoteDeviceEnrollmentSecret();
    await this.#prune(cryptoSessionId);
    const session = await this.#openSession(cryptoSessionId, deviceId);
    try {
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
      return {
        link: encodeRemotePairingLink(`${this.#config.origin}${this.#config.pagePath}`, {
          invitation: invitation.bytes,
          accountId: this.#config.accountId,
          installationId: this.#config.installationId,
          deviceId,
          cryptoSessionId,
          accessToken: this.#config.accessToken,
          enrollmentSecret,
        }),
        cryptoSessionId,
        deviceId,
        expiresAt: Number(invitation.expiresAtMs),
      };
    } catch (cause) {
      this.#fail(`remote: pairing could not start: ${describe(cause)}`);
      await this.#closeSession();
      throw cause;
    }
  }

  #bindingModule(): Promise<DeploymentTestBinding> {
    this.#binding ??= import(
      pathToFileURL(this.#config.binding).href
    ) as Promise<DeploymentTestBinding>;
    return this.#binding;
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

  async #openSession(cryptoSessionId: CryptoSessionId, deviceId: DeviceId): Promise<Session> {
    const binding = await this.#bindingModule();
    const endpoint = binding.deploymentTestDaemonEndpoint(
      join(this.#root, "sessions", cryptoSessionId),
      uuidToBytes(this.#config.accountId),
      uuidToBytes(this.#config.installationId),
      uuidToBytes(cryptoSessionId),
    );
    const proof = this.#config.possessionProof;
    const relay = new RemoteRelayConnection({
      tickets: new HttpRelayTicketProvider({
        controlPlaneOrigin: this.#config.origin,
        request: { installationId: this.#config.installationId, role: "daemon" },
        authenticationHeaders: async () => this.#headers(),
        proof: {
          create: async () => ({ connectionNonce: randomUUID(), possessionProof: proof.slice() }),
        },
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

  #deliver(session: Session, delivery: RelayDelivery): void {
    if (session.bridge !== undefined) {
      // The device resends its activation until a request is answered; the first one paired it.
      if (isActivation(delivery.opaquePayload)) return;
      void session.bridge
        .receive({ sourceRouteId: delivery.sourceRouteId, opaqueEnvelope: delivery.opaquePayload })
        .catch((cause) => {
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
    this.#log(`remote: device ${session.deviceId} paired`);
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
    await this.#pairing.publishWelcome({
      ...binding,
      welcome: welcome.bytes,
      welcomeHash: new Uint8Array(createHash("sha384").update(welcome.bytes).digest()),
    });
    session.claimHash = hashText;
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
    if (session === undefined) return;
    session.relay.close();
    if (session.bridge === undefined) session.endpoint.close();
    else await session.bridge.shutdown();
  }

  /** Forget every session directory except `keep`. */
  async #prune(keep: CryptoSessionId): Promise<void> {
    const sessions = join(this.#root, "sessions");
    for (const entry of await readdir(sessions).catch(() => [] as string[])) {
      if (entry !== keep) await rm(join(sessions, entry), { recursive: true, force: true });
    }
  }

  async #readState(): Promise<HostState | undefined> {
    try {
      const value = JSON.parse(await readFile(join(this.#root, "host.json"), "utf8")) as HostState;
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

  async #writeState(state: HostState): Promise<void> {
    const path = join(this.#root, "host.json");
    const staging = `${path}.next`;
    await writeFile(staging, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(staging, path);
  }
}
