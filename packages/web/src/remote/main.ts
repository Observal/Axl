// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Deployment-test phone page for remote access.
 *
 * `/remote` in the terminal prints a link to this page. The link fragment carries the daemon's
 * pairing invitation and the deployment-test stack credentials; the page stores it in this
 * browser's own storage, removes it from the address bar, pairs the browser binding's device
 * endpoint with the daemon, and then drives sessions through end-to-end encrypted requests over
 * the relay. Replica trust is pinned into the binding build, never taken from the link.
 */

import {
  type BrowserDeviceEndpoint,
  type CanonicalEvent,
  ConversationProjector,
  type ConversationRecord,
  HostedPairingClient,
  HttpRelayTicketProvider,
  pairRemoteBrowserDevice,
  parseRemotePairingLink,
  type RemoteBrowserPairingStep,
  RemoteBrowserSession,
  type RemotePairingLink,
  RemoteRelayConnection,
  type ServerMessage,
  type SessionSummary,
  uuidToBytes,
} from "@axl/sdk";

import "./remote.css";

interface DeviceBinding {
  authorizeWitness(authorization: string): Promise<null>;
  createDeviceEndpoint(identity: {
    readonly accountId: Uint8Array;
    readonly installationId: Uint8Array;
    readonly deviceId: Uint8Array;
    readonly cryptoSessionId: Uint8Array;
    readonly operationId: Uint8Array;
  }): Promise<BrowserDeviceEndpoint>;
  openDeviceEndpoint(session: {
    readonly cryptoSessionId: Uint8Array;
  }): Promise<BrowserDeviceEndpoint>;
}

interface StoredPairing {
  readonly fragment: string;
  readonly paired: boolean;
}

const STORAGE_KEY = "axl.remote.deployment-test";
const SEND_TIMEOUT_MS = 30 * 60_000;
const STEP_LABELS: Readonly<Record<RemoteBrowserPairingStep, string>> = {
  claim: "Create this device's pairing claim",
  notice: "Reach the daemon through the relay",
  welcome: "Wait for the daemon to accept the claim",
  join: "Join the encrypted session",
  activation: "Confirm the pairing with the daemon",
  paired: "Paired",
};

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing #${id}`);
  return value as T;
}

const view = {
  status: element<HTMLParagraphElement>("status"),
  pairing: element<HTMLElement>("pairing"),
  steps: element<HTMLOListElement>("steps"),
  hint: element<HTMLParagraphElement>("pairing-hint"),
  sessions: element<HTMLElement>("sessions"),
  sessionList: element<HTMLUListElement>("session-list"),
  refresh: element<HTMLButtonElement>("refresh"),
  thread: element<HTMLElement>("thread"),
  back: element<HTMLButtonElement>("back"),
  title: element<HTMLHeadingElement>("thread-title"),
  records: element<HTMLOListElement>("records"),
  activity: element<HTMLParagraphElement>("activity"),
  composer: element<HTMLFormElement>("composer"),
  prompt: element<HTMLTextAreaElement>("prompt"),
  send: element<HTMLButtonElement>("send"),
  stop: element<HTMLButtonElement>("stop"),
};

function status(text: string, tone: "normal" | "error" = "normal"): void {
  view.status.textContent = text;
  view.status.classList.toggle("error", tone === "error");
}

function show(section: "pairing" | "sessions" | "thread"): void {
  view.pairing.hidden = section !== "pairing";
  view.sessions.hidden = section !== "sessions";
  view.thread.hidden = section !== "thread";
}

function load(): StoredPairing | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as StoredPairing | null;
    return value !== null && typeof value.fragment === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function save(value: StoredPairing): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Without storage the page pairs again after a reload.
  }
}

/** The pairing to use: a new link in the address bar wins over the stored one. */
function currentPairing(): StoredPairing | undefined {
  const stored = load();
  const fragment = location.hash.slice(1);
  if (fragment.length === 0) return stored;
  // Keep credentials out of the address bar, history, and screenshots.
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  if (stored?.fragment === fragment) return stored;
  const fresh = { fragment, paired: false };
  save(fresh);
  return fresh;
}

function renderSteps(active: RemoteBrowserPairingStep): void {
  const order = Object.keys(STEP_LABELS) as RemoteBrowserPairingStep[];
  const index = order.indexOf(active);
  view.steps.replaceChildren(
    ...order.map((step, position) => {
      const item = document.createElement("li");
      item.textContent = STEP_LABELS[step];
      item.className = position < index ? "done" : position === index ? "active" : "";
      return item;
    }),
  );
}

async function openEndpoint(binding: DeviceBinding, link: RemotePairingLink) {
  const cryptoSessionId = uuidToBytes(link.cryptoSessionId);
  try {
    return await binding.createDeviceEndpoint({
      accountId: uuidToBytes(link.accountId),
      installationId: uuidToBytes(link.installationId),
      deviceId: uuidToBytes(link.deviceId),
      cryptoSessionId,
      operationId: cryptoSessionId.slice(),
    });
  } catch (cause) {
    if ((cause as { readonly code?: unknown }).code !== "already_exists") throw cause;
    return binding.openDeviceEndpoint({ cryptoSessionId });
  }
}

function relayFor(link: RemotePairingLink): RemoteRelayConnection {
  return new RemoteRelayConnection({
    tickets: new HttpRelayTicketProvider({
      controlPlaneOrigin: location.origin,
      request: { installationId: link.installationId, role: "device", deviceId: link.deviceId },
      authenticationHeaders: async () => ({ authorization: `Bearer ${link.accessToken}` }),
      proof: {
        create: async () => ({
          connectionNonce: crypto.randomUUID(),
          possessionProof: link.possessionProof.slice(),
        }),
      },
    }),
    destinationCryptoSessionId: link.cryptoSessionId,
    reconnect: { maximumAttempts: 1_000, maximumDelayMs: 15_000 },
  });
}

/** Daemon refusals the phone can explain; anything else keeps the daemon's safe message. */
const REFUSALS: Readonly<Record<string, string>> = {
  unsafe_remote_forbidden:
    "this daemon runs with --unsafe, so the phone can watch sessions but not change them.",
  scope_forbidden: "this phone is not allowed to do that.",
  device_revoked: "this phone was removed. Run /remote again to pair it.",
  timeout: "the daemon did not answer in time.",
};

function describe(cause: unknown): string {
  const code = (cause as { readonly code?: unknown }).code;
  if (typeof code === "string" && REFUSALS[code] !== undefined) return REFUSALS[code];
  return cause instanceof Error ? cause.message : String(cause);
}

function textOf(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function renderRecord(record: ConversationRecord): HTMLLIElement | undefined {
  if (record.kind !== "event") return undefined;
  const event: CanonicalEvent = record.event;
  const item = document.createElement("li");
  switch (event.type) {
    case "user.message":
      item.className = "record user";
      item.textContent = textOf(event.payload.content);
      return item;
    case "assistant.message": {
      const text = textOf(event.payload.content);
      if (text.length === 0) {
        if (event.payload.stopReason === "aborted") {
          item.className = "record tool";
          item.textContent = "Stopped";
          return item;
        }
        if (event.payload.stopReason !== "error") return undefined;
        item.className = "record error";
        item.textContent = `The turn failed: ${event.payload.errorMessage ?? "unknown error"}`;
        return item;
      }
      item.className = "record assistant";
      item.textContent = text;
      return item;
    }
    case "tool.call":
      item.className = "record tool";
      item.textContent = `Tool: ${event.payload.name}`;
      return item;
    case "session.error":
      item.className = "record error";
      item.textContent = event.payload.message;
      return item;
    default:
      return undefined;
  }
}

class RemotePage {
  readonly #session: RemoteBrowserSession;
  #projector: ConversationProjector | undefined;
  #subscriptionId: string | undefined;
  #sessionId: string | undefined;
  #ackTimer: ReturnType<typeof setTimeout> | undefined;
  #lastCursor: string | undefined;

  constructor(session: RemoteBrowserSession) {
    this.#session = session;
    session.onServerMessage((message) => this.#onMessage(message));
    session.onError((error) => status(error.message, "error"));
    view.refresh.addEventListener("click", () => void this.listSessions());
    view.back.addEventListener("click", () => void this.leaveThread());
    view.composer.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#send();
    });
    view.stop.addEventListener("click", () => void this.#interrupt());
  }

  async listSessions(): Promise<void> {
    show("sessions");
    status("Loading sessions");
    try {
      const result = (await this.#session.request("session.list", {
        scope: "all_local",
        order: "recent",
        pageSize: 30,
      })) as { readonly sessions: readonly SessionSummary[] };
      view.sessionList.replaceChildren(
        ...result.sessions.map((summary) => {
          const item = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.className = "remote-session";
          const title = document.createElement("span");
          title.className = "remote-session-title";
          title.textContent =
            summary.title ?? summary.lastUserMessage ?? summary.firstUserMessage ?? "New session";
          const detail = document.createElement("span");
          detail.className = "remote-session-detail";
          detail.textContent = `${summary.cwd} · ${new Date(summary.updatedAt).toLocaleString()}`;
          button.append(title, detail);
          button.addEventListener("click", () => void this.openThread(summary));
          item.append(button);
          return item;
        }),
      );
      status(result.sessions.length === 0 ? "No sessions yet" : "Connected");
    } catch (cause) {
      status(`Could not list sessions: ${describe(cause)}`, "error");
    }
  }

  async openThread(summary: SessionSummary): Promise<void> {
    await this.leaveThread(false);
    show("thread");
    view.title.textContent = summary.title ?? summary.cwd;
    view.records.replaceChildren();
    status("Opening session");
    this.#sessionId = summary.sessionId;
    this.#projector = new ConversationProjector(summary.sessionId);
    try {
      // Sessions close when the daemon restarts; reopening needs steer, so an observe-only phone
      // skips it and can still watch sessions that are open on the laptop.
      await this.#session
        .request("session.resume", { sessionId: summary.sessionId })
        .catch((cause: unknown) => {
          const code = (cause as { readonly code?: unknown }).code;
          if (code !== "unsafe_remote_forbidden" && code !== "scope_forbidden") throw cause;
        });
      const subscribed = (await this.#session.request("session.subscribe", {
        sessionId: summary.sessionId,
      })) as {
        readonly subscriptionId: string;
        readonly snapshot?: {
          readonly snapshotId: string;
          readonly boundaryCursor: string;
          readonly page: {
            readonly events: readonly CanonicalEvent[];
            readonly nextPageCursor?: string;
            readonly complete: boolean;
          };
        };
      };
      this.#subscriptionId = subscribed.subscriptionId;
      const snapshot = subscribed.snapshot;
      if (snapshot !== undefined) {
        let page = snapshot.page;
        for (;;) {
          for (const event of page.events) this.#projector.applyEvent(event);
          if (page.complete || page.nextPageCursor === undefined) break;
          const next = (await this.#session.request("session.history", {
            snapshotId: snapshot.snapshotId,
            pageCursor: page.nextPageCursor,
          })) as { readonly page: typeof page };
          page = next.page;
        }
        this.#render();
        // The daemon streams live events only after the snapshot boundary is acknowledged.
        this.#lastCursor = snapshot.boundaryCursor;
        await this.#session.request("session.ack", {
          subscriptionId: subscribed.subscriptionId,
          cursor: snapshot.boundaryCursor,
        });
      }
      this.#render();
      status("Connected");
    } catch (cause) {
      status(`Could not open the session: ${describe(cause)}`, "error");
    }
  }

  async leaveThread(list = true): Promise<void> {
    const subscriptionId = this.#subscriptionId;
    this.#subscriptionId = undefined;
    this.#sessionId = undefined;
    this.#projector = undefined;
    if (subscriptionId !== undefined) {
      await this.#session.request("session.unsubscribe", { subscriptionId }).catch(() => undefined);
    }
    if (list) await this.listSessions();
  }

  #onMessage(message: ServerMessage): void {
    trace(
      `server ${"kind" in message ? message.kind : "?"} ${"subscriptionId" in message ? (message.subscriptionId === this.#subscriptionId ? "current" : "other") : "-"} ${"event" in message ? message.event.type : ""}`,
    );
    if (!("kind" in message) || this.#projector === undefined) return;
    if (message.kind === "event" && message.subscriptionId === this.#subscriptionId) {
      this.#projector.applyEvent(message.event);
      this.#lastCursor = message.cursor;
      this.#scheduleAck();
      this.#render();
    } else if (message.kind === "activity" && message.subscriptionId === this.#subscriptionId) {
      this.#projector.applyActivity(message.frame);
      this.#renderActivity();
    }
  }

  #scheduleAck(): void {
    if (this.#ackTimer !== undefined) return;
    this.#ackTimer = setTimeout(() => {
      this.#ackTimer = undefined;
      const subscriptionId = this.#subscriptionId;
      const cursor = this.#lastCursor;
      if (subscriptionId === undefined || cursor === undefined) return;
      void this.#session.request("session.ack", { subscriptionId, cursor }).catch(() => undefined);
    }, 500);
  }

  #render(): void {
    const state = this.#projector?.state;
    if (state === undefined) return;
    view.records.replaceChildren(
      ...state.records.flatMap((record) => {
        const item = renderRecord(record);
        return item === undefined ? [] : [item];
      }),
    );
    this.#renderActivity();
    view.records.lastElementChild?.scrollIntoView({ block: "end" });
  }

  #renderActivity(): void {
    const state = this.#projector?.state;
    const busy = state?.activeOperationId !== undefined;
    view.stop.hidden = !busy;
    view.send.textContent = busy ? "Queue" : "Send";
    const text = state?.activity?.text ?? "";
    view.activity.hidden = !busy;
    view.activity.textContent = text.length > 0 ? text : busy ? "Working" : "";
  }

  async #send(): Promise<void> {
    const text = view.prompt.value.trim();
    const sessionId = this.#sessionId;
    if (text.length === 0 || sessionId === undefined) return;
    const busy = this.#projector?.state.activeOperationId !== undefined;
    view.prompt.value = "";
    try {
      await this.#session.request(
        "session.send",
        {
          sessionId,
          content: [{ type: "text", text }],
          delivery: busy ? "follow_up" : "prompt",
        },
        SEND_TIMEOUT_MS,
      );
    } catch (cause) {
      status(`Send failed: ${describe(cause)}`, "error");
    }
  }

  async #interrupt(): Promise<void> {
    const sessionId = this.#sessionId;
    if (sessionId === undefined) return;
    try {
      await this.#session.request("session.interrupt", { sessionId });
    } catch (cause) {
      status(`Stop failed: ${describe(cause)}`, "error");
    }
  }
}

/** `?debug` logs relay traffic and endpoint call timing to the console; never message content. */
const debugging = new URLSearchParams(location.search).has("debug");

function trace(message: string): void {
  if (debugging) console.debug(`[axl-remote] ${message}`);
}

function traced(endpoint: BrowserDeviceEndpoint): BrowserDeviceEndpoint {
  if (!debugging) return endpoint;
  const wrap =
    <A extends unknown[], R>(name: string, run: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const started = performance.now();
      trace(`${name} started`);
      try {
        const result = await run(...args);
        trace(`${name} finished in ${Math.round(performance.now() - started)} ms`);
        return result;
      } catch (cause) {
        trace(`${name} failed: ${(cause as { readonly code?: string }).code ?? String(cause)}`);
        throw cause;
      }
    };
  return {
    pairingClaim: wrap("pairingClaim", endpoint.pairingClaim.bind(endpoint)),
    joinPublished: wrap("joinPublished", endpoint.joinPublished.bind(endpoint)),
    preparePairActivation: wrap(
      "preparePairActivation",
      endpoint.preparePairActivation.bind(endpoint),
    ),
    prepareApplication: wrap("prepareApplication", endpoint.prepareApplication.bind(endpoint)),
    receiveApplication: wrap("receiveApplication", endpoint.receiveApplication.bind(endpoint)),
    close: endpoint.close.bind(endpoint),
  };
}

async function main(): Promise<void> {
  const stored = currentPairing();
  if (stored === undefined) {
    show("pairing");
    status("Not paired");
    view.hint.textContent =
      "Run /remote in the Axl terminal and open the link it prints on this device.";
    return;
  }
  let link: RemotePairingLink;
  try {
    link = parseRemotePairingLink(stored.fragment);
  } catch (cause) {
    // A stored pairing from an older page cannot be resumed; a fresh link is needed.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing stored to forget.
    }
    show("pairing");
    trace(`stored pairing rejected: ${describe(cause)}`);
    status("This pairing link can no longer be used", "error");
    view.hint.textContent = "Run /remote in the Axl terminal again and open the new link.";
    return;
  }
  status("Loading the encryption module");
  const binding = (await import(
    /* @vite-ignore */ new URL("./e2ee/loader/index.js", location.href).href
  )) as DeviceBinding;
  await binding.authorizeWitness(`Bearer ${link.accessToken}`);
  const endpoint = traced(await openEndpoint(binding, link));
  const relay = relayFor(link);
  relay.onState((state) => {
    trace(`relay ${state}`);
    if (state === "reconnecting") status("Reconnecting to the relay");
    else if (state === "connected" && view.status.textContent === "Reconnecting to the relay") {
      status("Connected");
    }
  });
  relay.onDelivery((delivery) => trace(`delivery ${delivery.opaquePayload.byteLength} bytes`));
  relay.onFailure((failure) => trace(`relay failure ${JSON.stringify(failure)}`));
  status("Connecting to the relay");
  await relay.start();
  if (!stored.paired) {
    show("pairing");
    status("Pairing");
    await pairRemoteBrowserDevice({
      link,
      endpoint,
      pairing: new HostedPairingClient({
        origin: location.origin,
        authorization: async () => link.accessToken,
      }),
      relay,
      onStep: renderSteps,
    });
    save({ fragment: stored.fragment, paired: true });
  }
  const page = new RemotePage(new RemoteBrowserSession({ endpoint, relay, ...link, trace }));
  await page.listSessions();
}

// A new link opened in an already open tab only changes the fragment; start over with it.
addEventListener("hashchange", () => location.reload());

main().catch((cause: unknown) => {
  const code = (cause as { readonly code?: unknown }).code;
  status(
    `${cause instanceof Error ? cause.message : String(cause)}${typeof code === "string" ? ` (${code})` : ""}`,
    "error",
  );
});
