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
 *
 * Phones suspend pages and drop sockets, so the page keeps its own connection honest: it probes
 * the relay on a heartbeat and whenever it becomes visible again, the session resends requests
 * the daemon has not answered, and an open conversation resumes from its last acknowledged cursor
 * after any reconnect. One tab owns the pairing at a time; a newer tab asks the older one to let
 * go of the endpoint instead of failing on its lock.
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
/** A prompt refused by a restarted daemon is sent again once, after reopening its session. */
const SEND_REOPEN_ATTEMPTS = 2;
/** Probe the relay this often; a suspended page's socket usually dies without a close event. */
const HEARTBEAT_MS = 25_000;
/** How long a new tab waits for an older one to release the endpoint. */
const HANDOFF_WAIT_MS = 5_000;
/** How long the pairing waits for the daemon to answer before resending its activation. */
const CONFIRM_TIMEOUT_MS = 5_000;
const TAB_CHANNEL = "axl-remote-tabs";
const TAB_ID = crypto.randomUUID();
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
  retry: element<HTMLButtonElement>("retry"),
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

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function tabChannel(): BroadcastChannel | undefined {
  return typeof BroadcastChannel === "function" ? new BroadcastChannel(TAB_CHANNEL) : undefined;
}

/**
 * Open the endpoint, first asking any older tab holding this pairing to let go. The binding keeps
 * one exclusive lock per pairing, so without the handoff a second tab fails with lifecycle_busy.
 */
async function openExclusive(
  binding: DeviceBinding,
  link: RemotePairingLink,
  channel: BroadcastChannel | undefined,
): Promise<BrowserDeviceEndpoint> {
  channel?.postMessage({ type: "takeover", session: link.cryptoSessionId, tab: TAB_ID });
  const deadline = Date.now() + HANDOFF_WAIT_MS;
  for (;;) {
    try {
      return await openEndpoint(binding, link);
    } catch (cause) {
      if ((cause as { readonly code?: unknown }).code !== "lifecycle_busy") throw cause;
      if (Date.now() > deadline) throw cause;
      await sleep(250);
    }
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
    heartbeatMs: HEARTBEAT_MS,
  });
}

/** Daemon refusals the phone can explain; anything else keeps the daemon's safe message. */
const REFUSALS: Readonly<Record<string, string>> = {
  unsafe_remote_forbidden:
    "this daemon runs with --unsafe, so the phone can watch sessions but not change them.",
  scope_forbidden: "this phone is not allowed to do that.",
  device_revoked: "this phone was removed. Run /remote again to pair it.",
  timeout: "the daemon did not answer in time.",
  lifecycle_busy:
    "this pairing is open in another tab or window that did not let go. Close it, then tap Retry.",
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
  #summary: SessionSummary | undefined;
  #ackTimer: ReturnType<typeof setTimeout> | undefined;
  #lastCursor: string | undefined;
  /** The newest cursor the daemon confirmed; only an acknowledged cursor can resume a view. */
  #ackedCursor: string | undefined;
  /** The session list request in flight; refreshes and reconnects share it. */
  #listing: Promise<void> | undefined;

  constructor(session: RemoteBrowserSession) {
    this.#session = session;
    session.onServerMessage((message) => this.#onMessage(message));
    session.onError((error) => status(error.message, "error"));
    session.onReconnect(() => void this.#resume());
    view.refresh.addEventListener("click", () => void this.listSessions());
    view.back.addEventListener("click", () => void this.leaveThread());
    view.composer.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#send();
    });
    view.stop.addEventListener("click", () => void this.#interrupt());
  }

  listSessions(): Promise<void> {
    show("sessions");
    this.#listing ??= this.#listSessions().finally(() => {
      this.#listing = undefined;
    });
    return this.#listing;
  }

  async #listSessions(): Promise<void> {
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
    // Take over the view before any round trip, so a prompt sent while the thread reopens after a
    // reconnect goes to this session instead of being dropped.
    const previous = this.#subscriptionId;
    this.#subscriptionId = undefined;
    this.#sessionId = summary.sessionId;
    this.#summary = summary;
    this.#ackedCursor = undefined;
    this.#projector = new ConversationProjector(summary.sessionId);
    if (previous !== undefined) {
      void this.#session
        .request("session.unsubscribe", { subscriptionId: previous })
        .catch(() => undefined);
    }
    show("thread");
    view.title.textContent = summary.title ?? summary.cwd;
    view.records.replaceChildren();
    status("Opening session");
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
        this.#ackedCursor = snapshot.boundaryCursor;
      }
      this.#render();
      status("Connected");
    } catch (cause) {
      status(`Could not open the session: ${describe(cause)}`, "error");
    }
  }

  async leaveThread(): Promise<void> {
    const subscriptionId = this.#subscriptionId;
    this.#subscriptionId = undefined;
    this.#sessionId = undefined;
    this.#summary = undefined;
    this.#ackedCursor = undefined;
    this.#projector = undefined;
    if (subscriptionId !== undefined) {
      await this.#session.request("session.unsubscribe", { subscriptionId }).catch(() => undefined);
    }
    await this.listSessions();
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
      void this.#session
        .request("session.ack", { subscriptionId, cursor })
        .then(() => {
          if (this.#subscriptionId === subscriptionId) this.#ackedCursor = cursor;
        })
        .catch(() => undefined);
    }, 500);
  }

  /**
   * Deliveries sent while the phone or the daemon was away are lost. Subscribing again after the
   * last acknowledged cursor replays exactly what was missed in one round trip, and the projector
   * drops events it already applied. A cursor the daemon no longer knows (it restarted, or the
   * gap outgrew its buffer) falls back to reopening the session with a fresh snapshot.
   */
  async #resume(): Promise<void> {
    if (!view.sessions.hidden) {
      await this.listSessions();
      return;
    }
    const summary = this.#summary;
    const previous = this.#subscriptionId;
    const after = this.#ackedCursor;
    if (summary === undefined) return;
    if (previous === undefined) {
      // Opening the session failed while the daemon was away; try again now that it is back.
      await this.openThread(summary);
      return;
    }
    status("Catching up");
    try {
      if (after === undefined) throw new Error("No acknowledged cursor to resume from");
      const resumed = (await this.#session.request("session.subscribe", {
        sessionId: summary.sessionId,
        after,
      })) as { readonly subscriptionId: string };
      if (this.#subscriptionId !== previous) {
        // The view changed while resuming; drop the subscription nobody reads.
        void this.#session
          .request("session.unsubscribe", { subscriptionId: resumed.subscriptionId })
          .catch(() => undefined);
        return;
      }
      this.#subscriptionId = resumed.subscriptionId;
      trace(`resumed ${summary.sessionId} after ${after}`);
      void this.#session
        .request("session.unsubscribe", { subscriptionId: previous })
        .catch(() => undefined);
      status("Connected");
    } catch (cause) {
      trace(`resume from cursor failed: ${describe(cause)}`);
      if (this.#subscriptionId === previous) await this.openThread(summary);
    }
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
    const params = {
      sessionId,
      content: [{ type: "text", text }],
      delivery: busy ? "follow_up" : "prompt",
    };
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await this.#session.request("session.send", params, SEND_TIMEOUT_MS);
          return;
        } catch (cause) {
          // A daemon restart closes sessions, and a prompt resent before the thread reopens is
          // refused with unknown_session. Refused means it never ran, so reopen and send it again.
          const code = (cause as { readonly code?: unknown }).code;
          if (code !== "unknown_session" || attempt === SEND_REOPEN_ATTEMPTS) throw cause;
          trace("send refused by a restarted daemon; reopening the session");
          await this.#session.request("session.resume", { sessionId });
        }
      }
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
  const channel = tabChannel();
  status("Opening this device's keys");
  const endpoint = traced(await openExclusive(binding, link, channel));
  const relay = relayFor(link);
  const session = new RemoteBrowserSession({ endpoint, relay, ...link, trace });

  // A newer tab for the same pairing takes over; this one lets go of the endpoint and its lock.
  let released = false;
  const release = async (reason: string) => {
    if (released) return;
    released = true;
    session.close();
    relay.close();
    await endpoint.close().catch(() => undefined);
    show("pairing");
    view.steps.replaceChildren();
    status(reason);
    view.hint.textContent = "Tap the button to use this pairing here instead.";
    view.retry.textContent = "Use this tab";
    view.retry.hidden = false;
  };
  if (channel !== undefined) {
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as { type?: unknown; session?: unknown; tab?: unknown };
      if (
        message.type === "takeover" &&
        message.session === link.cryptoSessionId &&
        message.tab !== TAB_ID
      ) {
        void release("This pairing moved to another tab");
      }
    };
  }
  // A page restored from the back-forward cache let go of everything when it was hidden.
  addEventListener("pagehide", () => void release("Paused"));
  addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });

  relay.onState((state) => {
    trace(`relay ${state}`);
    if (state === "reconnecting") status("Reconnecting to the relay");
    else if (state === "connected" && view.status.textContent === "Reconnecting to the relay") {
      status("Connected");
    }
  });
  relay.onDelivery((delivery) => trace(`delivery ${delivery.opaquePayload.byteLength} bytes`));
  relay.onFailure((failure) => trace(`relay failure ${JSON.stringify(failure)}`));
  const DAEMON_OFFLINE = "The daemon is offline; waiting for it to come back";
  relay.onRoutes((peers) => {
    const online = peers.some((peer) => peer.role === "daemon");
    if (!online && relay.state === "connected") status(DAEMON_OFFLINE);
    else if (online && view.status.textContent === DAEMON_OFFLINE) status("Connected");
  });
  // A phone that wakes the page or regains its network checks the socket at once, rather than
  // waiting for the next heartbeat to notice it died while suspended.
  const wake = () => {
    if (document.visibilityState === "visible" && !released) void relay.checkAlive();
  };
  document.addEventListener("visibilitychange", wake);
  addEventListener("online", wake);

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
      // Any answered request proves the daemon accepted the activation.
      confirm: async () => {
        await session.request(
          "session.list",
          { scope: "all_local", order: "recent", pageSize: 1 },
          CONFIRM_TIMEOUT_MS,
        );
      },
      onStep: renderSteps,
    });
    save({ fragment: stored.fragment, paired: true });
  }
  const page = new RemotePage(session);
  await page.listSessions();
}

// A new link opened in an already open tab only changes the fragment; start over with it.
addEventListener("hashchange", () => location.reload());
view.retry.addEventListener("click", () => location.reload());

main().catch((cause: unknown) => {
  const code = (cause as { readonly code?: unknown }).code;
  const known = typeof code === "string" && REFUSALS[code] !== undefined;
  status(
    known
      ? `Could not start: ${describe(cause)}`
      : `${cause instanceof Error ? cause.message : String(cause)}${typeof code === "string" ? ` (${code})` : ""}`,
    "error",
  );
  view.retry.textContent = "Retry";
  view.retry.hidden = false;
});
