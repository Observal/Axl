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
 * session; a completed pairing survives daemon restarts.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
} from "@axl/protocol";
import {
  encodeRemotePairingLink,
  HostedPairingClient,
  HttpRelayTicketProvider,
  parseRemotePairingNotice,
  RemoteRelayConnection,
  uuidToBytes,
} from "@axl/sdk";

const CONFIG_VERSION = 1;
const STATE_VERSION = 1;
const DEVICE_SCOPES: readonly RemoteDeviceScope[] = ["observe", "steer"];
const HOSTED_GRANT_GENERATION = 1;

export interface DeploymentTestRemoteConfig {
  /** HTTPS origin of the stack: control plane, witness, relay tickets, and the device page. */
  readonly origin: string;
  /** Path of the device page under `origin`, for example `/remote/`. */
  readonly pagePath: string;
  readonly accountId: string;
  readonly installationId: InstallationId;
  readonly deviceId: DeviceId;
  readonly accessToken: string;
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
    deviceId: parseDeviceId(value.deviceId),
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
  readonly phase: "pairing" | "paired";
}

interface Session {
  readonly id: CryptoSessionId;
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
  readonly #log: (message: string) => void;
  #binding: Promise<DeploymentTestBinding> | undefined;
  #daemon: AxlDaemon | undefined;
  #session: Session | undefined;
  #starting: Promise<RemotePairingStartResult> | undefined;

  private constructor(
    config: DeploymentTestRemoteConfig,
    root: string,
    authority: RemoteDeviceAuthorityStore,
    log: (message: string) => void,
  ) {
    this.#config = config;
    this.#root = root;
    this.#authority = authority;
    this.#log = log;
    this.#witness = new HostedDaemonWitnessTransport({
      controlPlaneOrigin: config.origin,
      authenticationHeaders: async () => this.#headers(),
    });
    this.#pairing = new HostedPairingClient({
      origin: config.origin,
      authorization: async () => config.accessToken,
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
    const state = await this.#readState();
    if (state?.phase !== "paired") return;
    try {
      const session = await this.#openSession(state.cryptoSessionId);
      await session.endpoint.reopen();
      await this.#serve(session);
      this.#log(`remote: restored paired session ${state.cryptoSessionId}`);
    } catch (cause) {
      await this.#closeSession();
      this.#log(`remote: could not restore the paired session: ${String(cause)}`);
    }
  }

  start(): Promise<RemotePairingStartResult> {
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async close(): Promise<void> {
    await this.#closeSession();
  }

  #headers(): Readonly<Record<string, string>> {
    return { authorization: `Bearer ${this.#config.accessToken}` };
  }

  async #start(): Promise<RemotePairingStartResult> {
    if (this.#daemon === undefined) throw new Error("The remote host is not attached");
    await this.#closeSession();
    const cryptoSessionId = parseCryptoSessionId(uuidV7());
    await this.#prune(cryptoSessionId);
    const session = await this.#openSession(cryptoSessionId);
    try {
      const issued = await session.barrier.complete(await session.endpoint.issue(operation()));
      const invitation = released<{ readonly bytes: Uint8Array; readonly expiresAtMs: bigint }>(
        issued,
        "publication",
      );
      // The first fresh read after registration moves an empty hosted witness out of bootstrap.
      await session.barrier.recover();
      await this.#writeState({ version: STATE_VERSION, cryptoSessionId, phase: "pairing" });
      await session.relay.start();
      this.#log(`remote: pairing session ${cryptoSessionId} is waiting for a device`);
      return {
        link: encodeRemotePairingLink(`${this.#config.origin}${this.#config.pagePath}`, {
          invitation: invitation.bytes,
          accountId: this.#config.accountId,
          installationId: this.#config.installationId,
          deviceId: this.#config.deviceId,
          cryptoSessionId,
          accessToken: this.#config.accessToken,
          possessionProof: this.#config.possessionProof,
        }),
        cryptoSessionId,
        deviceId: this.#config.deviceId,
        expiresAt: Number(invitation.expiresAtMs),
      };
    } catch (cause) {
      this.#log(`remote: pairing could not start: ${String(cause)}`);
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

  async #openSession(cryptoSessionId: CryptoSessionId): Promise<Session> {
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
    });
    const session: Session = {
      id: cryptoSessionId,
      endpoint,
      barrier: new DaemonWitnessBarrier(endpoint, this.#witness),
      relay,
      tail: Promise.resolve(),
    };
    relay.onDelivery((delivery) => this.#deliver(session, delivery));
    relay.onFailure((failure) => this.#log(`remote: relay failure ${JSON.stringify(failure)}`));
    this.#session = session;
    return session;
  }

  #deliver(session: Session, delivery: RelayDelivery): void {
    if (session.bridge !== undefined) {
      void session.bridge
        .receive({ sourceRouteId: delivery.sourceRouteId, opaqueEnvelope: delivery.opaquePayload })
        .catch((cause) => this.#log(`remote: request failed: ${String(cause)}`));
      return;
    }
    const run = session.tail.then(() => this.#pairingStep(session, delivery));
    session.tail = run.catch((cause) => this.#log(`remote: pairing step failed: ${String(cause)}`));
  }

  async #pairingStep(session: Session, delivery: RelayDelivery): Promise<void> {
    if (this.#session !== session) return;
    if (session.bridge !== undefined) {
      // Queued behind the activation that handed the endpoint to the bridge.
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
      phase: "paired",
    });
    this.#log(`remote: device ${this.#config.deviceId} paired`);
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
      deviceId: this.#config.deviceId,
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
    await this.#authority.registerLocalDevice(this.#config.deviceId, DEVICE_SCOPES);
    await this.#authority.applyHostedGrant(
      this.#config.deviceId,
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
      deviceId: this.#config.deviceId,
      authority: this.#authority,
      endpoint: session.endpoint,
      witness: this.#witness,
      sender: {
        send: (route, envelope) =>
          session.relay.send(route, parseTransportAttemptId(randomUUID()), envelope),
      },
      onError: (error) => this.#log(`remote: ${error.message}`),
    });
    session.bridge = bridge;
    session.relay.onRoutes((peers) => bridge.observeRelayRoutes(peers));
    bridge.observeRelayRoutes(session.relay.routes);
    await bridge.start();
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
