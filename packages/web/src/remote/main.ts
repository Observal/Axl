// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Deployment-test phone page for remote access.
 *
 * `/remote` in the terminal prints a link to this page. The link fragment carries the daemon's
 * pairing invitation and this pairing's fresh device ID with a one-time enrollment secret; the page
 * stores it in this browser's own storage and removes it from the address bar. When the stack
 * offers phone sign-in (`sign-in.json` next to this page), the person signs in with Google first
 * and the page uses those tokens, which only reach the routes a phone needs; otherwise the link
 * also carries the stack's deployment-test access token. It creates this device's own signing key (kept in IndexedDB,
 * never exported), enrolls it, pairs the browser binding's device endpoint with the daemon, and
 * then drives sessions through end-to-end encrypted requests over the relay. Every relay
 * connection is admitted with a signature by that key. Replica trust is pinned into the binding
 * build, never taken from the link.
 *
 * The phone reaches only the sessions the terminal shares with it (`/remote` in a session). The
 * daemon sends the whole shared set whenever it changes: a new share opens at once, or shows a
 * banner while another conversation is open, and a conversation whose share ended closes.
 *
 * An open conversation renders with the desktop client's transcript renderer, and the reply the
 * model is producing streams in as it arrives. A prompt shows at once and settles when the daemon
 * records it, since every encrypted round trip costs witness calls on both ends.
 *
 * Phones suspend pages and drop sockets, so the page keeps its own connection honest: it probes
 * the relay on a heartbeat and whenever it becomes visible again, the session resends requests
 * the daemon has not answered, and an open conversation resumes from its last acknowledged cursor
 * after any reconnect. One tab owns the pairing at a time, and the tab opened last wins: it asks
 * older tabs to let go of the endpoint, takes it from one that never answers (a tab the phone
 * suspended in the background), and marks itself the owner, so an older tab that wakes up later
 * stops instead of reconnecting over it. "Use this tab" reloads, which makes that tab the newest.
 */

import {
  type BrowserDeviceEndpoint,
  type CanonicalEvent,
  ConversationProjector,
  createRemoteDeviceKeyPair,
  fetchRemotePairingLink,
  HostedPairingClient,
  HttpRelayTicketProvider,
  openRemotePairingLink,
  pairRemoteBrowserDevice,
  parseRemotePairingLink,
  parseShortRemotePairingFragment,
  type RelayAdmissionCredential,
  type RelayTicketProvider,
  type RemoteBrowserPairingStep,
  RemoteBrowserSession,
  RemoteDeviceControlPlane,
  type RemoteDeviceCryptoKeyPair,
  type RemoteDeviceKey,
  type RemotePairingLink,
  RemoteRelayConnection,
  type RemoteShare,
  type RemoteSharesResult,
  remoteDeviceKeyFromPair,
  remoteDevicePossession,
  type ServerMessage,
  uuidToBytes,
} from "@axl/sdk";

import "@axl/ui/theme.css";
import "./remote.css";

import { loadSignInConfig, PhoneSignIn, SignInRequiredError } from "./sign-in.ts";
import type { PendingPrompt, ThreadRenderer } from "./thread-view.tsx";
import { elapsed, turnStage, turnStartedAt } from "./turn.ts";

// The transcript renderer is most of the page's weight; fetch it while pairing and listing run.
const threadView = import("./thread-view.tsx");

interface DeviceBinding {
  getBindingInfo(): Promise<unknown>;
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
  takeOverDeviceEndpoint(session: { readonly cryptoSessionId: Uint8Array }): Promise<void>;
}

/** What `session.subscribe` answers: the subscription and, for a fresh view, its snapshot. */
interface SessionSubscription {
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
}

interface StoredPairing {
  readonly fragment: string;
  readonly paired: boolean;
  /** This device's key is enrolled for the link's device ID. */
  readonly enrolled?: boolean;
}

const STORAGE_KEY = "axl.remote.deployment-test";
const KEY_DATABASE = "axl-remote-device-keys";
const SEND_TIMEOUT_MS = 30 * 60_000;
/** A prompt refused by a restarted daemon is sent again once, after reopening its session. */
const SEND_REOPEN_ATTEMPTS = 2;
/** Probe the relay this often; a suspended page's socket usually dies without a close event. */
const HEARTBEAT_MS = 25_000;
/** How long a new tab waits for an older one to release the endpoint before taking it. */
const HANDOFF_WAIT_MS = 4_000;
/** How long the pairing waits for the daemon to answer before resending its activation. */
const CONFIRM_TIMEOUT_MS = 5_000;
const TAB_CHANNEL = "axl-remote-tabs";
/** The tab that owns the pairing, as `<crypto session>/<tab>`; other tabs see it change. */
const OWNER_KEY = "axl.remote.owner";
const MOVED = "This pairing moved to another tab";
/**
 * Acknowledge a view's cursor this long after new events arrive. Every acknowledgement is a full
 * encrypted round trip through the phone's one witness queue, so it waits for any request the page
 * has in flight. The cursor it confirms only bounds what a reconnect replays, and stays valid for
 * minutes.
 */
const ACK_DELAY_MS = 10_000;
/** A sent prompt the transcript never showed stops being drawn as pending after this long. */
const PENDING_SETTLE_MS = 15_000;
const TAB_ID = crypto.randomUUID();
/** When this tab loaded; between tabs of one pairing, the later one wins. */
const TAB_STARTED = Date.now();
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
  title: element<HTMLHeadingElement>("title"),
  connection: element<HTMLSpanElement>("connection"),
  back: element<HTMLButtonElement>("back"),
  refresh: element<HTMLButtonElement>("refresh"),
  retry: element<HTMLButtonElement>("retry"),
  signIn: element<HTMLElement>("sign-in"),
  signInHint: element<HTMLParagraphElement>("sign-in-hint"),
  signInButton: element<HTMLButtonElement>("sign-in-button"),
  pairing: element<HTMLElement>("pairing"),
  steps: element<HTMLOListElement>("steps"),
  hint: element<HTMLParagraphElement>("pairing-hint"),
  banner: element<HTMLDivElement>("share-banner"),
  bannerText: element<HTMLSpanElement>("share-banner-text"),
  bannerOpen: element<HTMLButtonElement>("share-banner-open"),
  bannerClose: element<HTMLButtonElement>("share-banner-close"),
  sessions: element<HTMLElement>("sessions"),
  sessionList: element<HTMLUListElement>("session-list"),
  thread: element<HTMLElement>("thread"),
  transcript: element<HTMLDivElement>("transcript"),
  threadView: element<HTMLDivElement>("thread-view"),
  jump: element<HTMLButtonElement>("jump"),
  activity: element<HTMLParagraphElement>("activity"),
  composer: element<HTMLFormElement>("composer"),
  prompt: element<HTMLTextAreaElement>("prompt"),
  send: element<HTMLButtonElement>("send"),
  stop: element<HTMLButtonElement>("stop"),
};

/** The shared theme is dark unless told otherwise; follow the phone's setting. */
function followColorScheme(): void {
  const light = matchMedia("(prefers-color-scheme: light)");
  const apply = () => {
    document.documentElement.dataset.theme = light.matches ? "light" : "dark";
  };
  apply();
  light.addEventListener("change", apply);
}

function connection(state: "online" | "connecting" | "offline"): void {
  view.connection.dataset.state = state;
}

/** Set once this tab has let go of the pairing; whatever was in flight then fails quietly. */
let letGo = false;

function status(text: string, tone: "normal" | "error" = "normal", final = false): void {
  // Requests cut off when the tab let go must not replace the reason it shows.
  if (letGo && !final) return;
  view.status.textContent = text;
  view.status.classList.toggle("error", tone === "error");
}

function show(section: "sign-in" | "pairing" | "sessions" | "thread"): void {
  view.signIn.hidden = section !== "sign-in";
  view.pairing.hidden = section !== "pairing";
  view.sessions.hidden = section !== "sessions";
  view.thread.hidden = section !== "thread";
  view.back.hidden = section !== "thread";
  view.refresh.hidden = section !== "sessions";
  if (section === "sessions") view.title.textContent = "Shared sessions";
  else if (section === "pairing") view.title.textContent = "Axl Remote";
}

/** "now", "5m", "3h", "2d", or a date, for the session list. */
function ago(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The last path segment of a working directory, which is what tells sessions apart. */
function shortPath(cwd: string): string {
  const parts = cwd.split(/[\\/]/u).filter((part) => part.length > 0);
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join("/")}`;
}

/** What the list and the header call a shared session. */
function shareLabel(share: RemoteShare): string {
  return share.title ?? share.preview ?? shortPath(share.cwd);
}

function contentText(
  content: readonly { readonly type: string; readonly text?: string }[],
): string {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
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
async function currentPairing(): Promise<StoredPairing | undefined> {
  const stored = load();
  let fragment = location.hash.slice(1);
  if (fragment.length === 0) return stored;
  // Keep credentials out of the address bar, history, and screenshots.
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  // A short link names the full link sealed on the control plane; its key opens it here.
  const short = parseShortRemotePairingFragment(fragment);
  if (short !== undefined) {
    status("Opening the pairing link");
    const published = await fetchRemotePairingLink({ origin: location.origin }, short.linkId);
    fragment = await openRemotePairingLink(published.sealed, short.linkId, short.key);
  }
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

/** Whether the tab that loaded at `started` came after this one. */
function newerTab(started: unknown, tab: unknown): boolean {
  return (
    typeof started === "number" &&
    typeof tab === "string" &&
    (started > TAB_STARTED || (started === TAB_STARTED && tab > TAB_ID))
  );
}

function markOwner(link: RemotePairingLink): void {
  try {
    localStorage.setItem(
      OWNER_KEY,
      JSON.stringify({ session: link.cryptoSessionId, tab: TAB_ID, started: TAB_STARTED }),
    );
  } catch {
    // Without storage, the tab channel and the endpoint lock still keep one owner.
  }
}

/** The tab marked as owning this pairing, if one is. */
function owner(
  link: RemotePairingLink,
): { readonly tab?: unknown; readonly started?: unknown } | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(OWNER_KEY) ?? "null") as {
      readonly session?: unknown;
      readonly tab?: unknown;
      readonly started?: unknown;
    } | null;
    return value?.session === link.cryptoSessionId ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether another tab has taken this pairing since this one did. */
function ownedElsewhere(link: RemotePairingLink): boolean {
  const current = owner(link);
  return current !== undefined && current.tab !== TAB_ID;
}

/** Whether a tab opened after this one already owns the pairing. */
function ownedByNewer(link: RemotePairingLink): boolean {
  const current = owner(link);
  return current !== undefined && newerTab(current.started, current.tab);
}

/**
 * Open the endpoint, first asking any older tab holding this pairing to let go. The binding keeps
 * one exclusive lock per pairing. The request repeats while this tab waits, for a tab that was
 * still starting when it was first sent; a tab that never answers, because the phone suspended it,
 * loses the lock to this one, and its endpoint fails closed. Resolves undefined, having taken
 * nothing, once a newer tab wants the pairing.
 */
async function openExclusive(
  binding: DeviceBinding,
  link: RemotePairingLink,
  channel: BroadcastChannel | undefined,
  superseded: () => boolean,
): Promise<BrowserDeviceEndpoint | undefined> {
  const deadline = Date.now() + HANDOFF_WAIT_MS;
  // Set once this tab takes the endpoint: the lock manager may see the taken lock's release
  // after the worker's next request, so the tab keeps trying (and taking) until this passes.
  let takeoverDeadline: number | undefined;
  for (let round = 0; ; round += 1) {
    if (superseded() || ownedByNewer(link)) return undefined;
    if (round % 4 === 0) {
      channel?.postMessage({
        type: "takeover",
        session: link.cryptoSessionId,
        tab: TAB_ID,
        started: TAB_STARTED,
      });
    }
    try {
      return await openEndpoint(binding, link);
    } catch (cause) {
      if ((cause as { readonly code?: unknown }).code !== "lifecycle_busy") throw cause;
      const now = Date.now();
      if (takeoverDeadline !== undefined && now > takeoverDeadline) throw cause;
      if (now > deadline && (takeoverDeadline === undefined || round % 4 === 0)) {
        if (takeoverDeadline === undefined) {
          trace("another tab did not let go of the pairing; taking it over");
          status("Taking over from another tab");
          takeoverDeadline = now + HANDOFF_WAIT_MS;
        }
        await binding.takeOverDeviceEndpoint({
          cryptoSessionId: uuidToBytes(link.cryptoSessionId),
        });
      }
      await sleep(250);
    }
  }
}

/** Show that another tab has this pairing now, with a button to take it back. */
function showMoved(): void {
  letGo = true;
  connection("offline");
  show("pairing");
  view.steps.replaceChildren();
  status(MOVED, "normal", true);
  view.hint.textContent = "Tap the button to use this pairing here instead.";
  view.retry.textContent = "Use this tab";
  view.retry.hidden = false;
}

/** This device's key for `deviceId`, created on first use and kept in IndexedDB. */
async function deviceKey(deviceId: string): Promise<RemoteDeviceKey> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(KEY_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      const transaction = database.transaction("keys", mode);
      const request = work(transaction.objectStore("keys"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  try {
    const stored = () => run("readonly", (store) => store.get(deviceId)) as Promise<unknown>;
    let pair = (await stored()) as RemoteDeviceCryptoKeyPair | undefined;
    if (pair === undefined) {
      // add() refuses to overwrite, so when two tabs race the first key stored wins for both.
      const created = await createRemoteDeviceKeyPair();
      await run("readwrite", (store) => store.add(created, deviceId)).catch(() => undefined);
      pair = (await stored()) as RemoteDeviceCryptoKeyPair | undefined;
      if (pair === undefined) throw new Error("This browser cannot keep a device key");
    }
    return await remoteDeviceKeyFromPair(pair);
  } finally {
    database.close();
  }
}

/** Refusals that mean the enrollment itself is settled, so retrying cannot help. */
const FINAL_ENROLLMENT = new Set([400, 401, 403, 404, 409, 410]);

/** Enroll this device's key for the pairing's device ID once; a retry with the same key is fine. */
async function enroll(
  link: RemotePairingLink,
  key: RemoteDeviceKey,
  token: () => Promise<string>,
): Promise<void> {
  const devices = new RemoteDeviceControlPlane({
    controlPlaneOrigin: location.origin,
    authenticationHeaders: async () => ({ authorization: `Bearer ${await token()}` }),
  });
  for (let delay = 1_000; ; delay = Math.min(delay * 2, 15_000)) {
    try {
      await devices.enroll(link.installationId, link.deviceId, link.enrollmentSecret, key);
      return;
    } catch (cause) {
      if (FINAL_ENROLLMENT.has((cause as { readonly status?: number }).status ?? 0)) throw cause;
      trace(`enrollment failed, retrying: ${describe(cause)}`);
      status("Registering this device (retrying)");
      await sleep(delay);
    }
  }
}

/** Time a prefetched relay ticket must still have left for the relay's first connect to use it. */
const TICKET_MARGIN_MS = 10_000;

/**
 * Start fetching the relay's first ticket at once, so it arrives while the encryption module loads,
 * and hand it to the first connect. Later connects, and a first connect that finds the early ticket
 * failed or close to expiry, fetch their own.
 */
function prefetched(provider: RelayTicketProvider): RelayTicketProvider {
  let early: Promise<RelayAdmissionCredential | undefined> | undefined = provider
    .acquire()
    .catch(() => undefined);
  return {
    async acquire() {
      const ticket = await early;
      early = undefined;
      if (ticket !== undefined && ticket.expiresAt - Date.now() > TICKET_MARGIN_MS) return ticket;
      return provider.acquire();
    },
  };
}

function relayFor(
  link: RemotePairingLink,
  key: RemoteDeviceKey,
  token: () => Promise<string>,
): RemoteRelayConnection {
  return new RemoteRelayConnection({
    tickets: prefetched(
      new HttpRelayTicketProvider({
        controlPlaneOrigin: location.origin,
        request: { installationId: link.installationId, role: "device", deviceId: link.deviceId },
        authenticationHeaders: async () => ({ authorization: `Bearer ${await token()}` }),
        proof: remoteDevicePossession(key),
      }),
    ),
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
  route_forbidden:
    "this phone is no longer paired, because the daemon was paired again. Run /remote to pair it.",
  device_conflict:
    "this pairing link was already used on another device. Run /remote again for a new one.",
  enrollment_expired: "this pairing link expired. Run /remote again for a new one.",
  enrollment_denied: "this pairing link is not valid. Run /remote again for a new one.",
  timeout: "the daemon did not answer in time.",
  session_not_shared: "this session is no longer shared. Run /remote in it to share it again.",
  lifecycle_busy:
    "this pairing is open in another tab or window that did not let go. Close it, then tap Retry.",
};

function describe(cause: unknown): string {
  const code = (cause as { readonly code?: unknown }).code;
  if (typeof code === "string" && REFUSALS[code] !== undefined) return REFUSALS[code];
  return cause instanceof Error ? cause.message : String(cause);
}

class RemotePage {
  readonly #session: RemoteBrowserSession;
  #renderer: ThreadRenderer | undefined;
  #projector: ConversationProjector | undefined;
  #subscriptionId: string | undefined;
  #sessionId: string | undefined;
  #share: RemoteShare | undefined;
  #ackTimer: ReturnType<typeof setTimeout> | undefined;
  #lastCursor: string | undefined;
  /** The newest cursor the daemon confirmed; only an acknowledged cursor can resume a view. */
  #ackedCursor: string | undefined;
  /** The share list request in flight; refreshes and reconnects share it. */
  #listing: Promise<void> | undefined;
  /** The shared sessions, newest share first, from the newest set the daemon sent. */
  #shares: readonly RemoteShare[] = [];
  #generation = -1;
  /** Sessions the page has seen shared; unset until the first set arrives. */
  #seen: Set<string> | undefined;
  /** A share announced while another conversation is open. */
  #banner: RemoteShare | undefined;
  /** Prompts sent from this page that the transcript does not show yet. */
  #pending: PendingPrompt[] = [];
  /** Redraws the running turn's elapsed time while one is running. */
  #ticker: ReturnType<typeof setInterval> | undefined;
  /** Requests the page is waiting on (not prompts, which run a whole turn); acknowledgements wait. */
  #inFlight = 0;

  constructor(session: RemoteBrowserSession) {
    this.#session = session;
    session.onServerMessage((message) => this.#onMessage(message));
    session.onError((error) => status(error.message, "error"));
    session.onReconnect(() => void this.#resume());
    view.refresh.addEventListener("click", () => void this.listSessions());
    view.back.addEventListener("click", () => void this.leaveThread());
    view.bannerOpen.addEventListener("click", () => {
      const share = this.#banner;
      this.#hideBanner();
      if (share !== undefined) void this.openThread(share);
    });
    view.bannerClose.addEventListener("click", () => this.#hideBanner());
    view.jump.addEventListener("click", () => this.#renderer?.jumpToLatest());
    view.composer.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#send();
    });
    view.prompt.addEventListener("input", () => this.#fitComposer());
    view.prompt.addEventListener("keydown", (event) => {
      // A hardware keyboard sends with Enter; a touch keyboard's Enter adds a line.
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      if (matchMedia("(pointer: coarse)").matches) return;
      event.preventDefault();
      view.composer.requestSubmit();
    });
    view.stop.addEventListener("click", () => void this.#interrupt());
    this.#fitComposer();
  }

  /** Grow the prompt with its text, and keep the jump button clear of the composer. */
  #fitComposer(): void {
    view.prompt.style.height = "auto";
    view.prompt.style.height = `${view.prompt.scrollHeight + 2}px`;
    view.send.disabled = view.prompt.value.trim().length === 0;
    view.thread.style.setProperty("--composer-height", `${view.composer.offsetHeight}px`);
  }

  /** Show the shared sessions, reading the current set from the daemon. */
  listSessions(): Promise<void> {
    show("sessions");
    this.#listing ??= this.#loadShares().finally(() => {
      this.#listing = undefined;
    });
    return this.#listing;
  }

  async #loadShares(): Promise<void> {
    status("Loading shared sessions");
    if (view.sessionList.childElementCount === 0) {
      view.sessionList.replaceChildren(
        ...[0, 1, 2].map(() => {
          const item = document.createElement("li");
          item.className = "remote-skeleton";
          return item;
        }),
      );
    }
    try {
      await this.#fetchShares();
      status(this.#shares.length === 0 ? "Nothing shared yet" : "Connected");
    } catch (cause) {
      status(`Could not load shared sessions: ${describe(cause)}`, "error");
    }
  }

  async #fetchShares(): Promise<void> {
    this.#applyShares((await this.#request("remote.shares", {})) as RemoteSharesResult);
  }

  /**
   * Take a shared set, from a reply or a notice; one older than the page has is ignored. A session
   * shared since the last set opens at once, or shows a banner while another conversation is open.
   * On the first set, the newest share opens. A conversation whose share ended closes.
   */
  #applyShares(result: RemoteSharesResult): void {
    if (result.generation < this.#generation) return;
    this.#generation = result.generation;
    const seen = this.#seen;
    this.#shares = [...result.shares].sort((left, right) => right.sharedAt - left.sharedAt);
    const shared = new Set<string>(this.#shares.map((share) => share.sessionId));
    this.#seen = new Set([...(seen ?? []), ...shared]);
    this.#renderShares();
    if (this.#banner !== undefined && !shared.has(this.#banner.sessionId)) this.#hideBanner();
    const current = this.#sessionId;
    if (current !== undefined && !shared.has(current)) {
      this.#closeThread("That session is no longer shared");
    }
    const fresh = this.#shares.find((share) => seen === undefined || !seen.has(share.sessionId));
    if (fresh === undefined) return;
    if (this.#sessionId === undefined) void this.openThread(fresh);
    else if (fresh.sessionId !== this.#sessionId) this.#showBanner(fresh);
  }

  #renderShares(): void {
    if (this.#shares.length === 0) {
      const empty = document.createElement("li");
      empty.className = "remote-empty";
      empty.textContent = "Run /remote in a session to open it here.";
      view.sessionList.replaceChildren(empty);
      return;
    }
    view.sessionList.replaceChildren(
      ...this.#shares.map((share) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "remote-session";
        const title = document.createElement("span");
        title.className = "remote-session-title";
        title.textContent = shareLabel(share);
        const time = document.createElement("time");
        time.className = "remote-session-time";
        time.dateTime = new Date(share.updatedAt).toISOString();
        time.textContent = ago(share.updatedAt);
        const detail = document.createElement("span");
        detail.className = "remote-session-detail";
        detail.textContent = shortPath(share.cwd);
        button.append(title, time, detail);
        button.addEventListener("click", () => void this.openThread(share));
        item.append(button);
        return item;
      }),
    );
  }

  #showBanner(share: RemoteShare): void {
    this.#banner = share;
    view.bannerText.textContent = `Shared from your computer: ${shareLabel(share)}`;
    view.banner.hidden = false;
  }

  #hideBanner(): void {
    this.#banner = undefined;
    view.banner.hidden = true;
  }

  /** Leave a conversation the daemon no longer shares; its subscription already ended there. */
  #closeThread(reason: string): void {
    this.#subscriptionId = undefined;
    this.#sessionId = undefined;
    this.#share = undefined;
    this.#ackedCursor = undefined;
    this.#projector = undefined;
    this.#pending = [];
    this.#renderActivity();
    show("sessions");
    status(reason);
  }

  async openThread(share: RemoteShare): Promise<void> {
    // Take over the view before any round trip, so a prompt sent while the thread reopens after a
    // reconnect goes to this session instead of being dropped.
    const previous = this.#subscriptionId;
    this.#subscriptionId = undefined;
    this.#sessionId = share.sessionId;
    this.#share = share;
    if (this.#banner?.sessionId === share.sessionId) this.#hideBanner();
    this.#ackedCursor = undefined;
    this.#projector = new ConversationProjector(share.sessionId);
    this.#pending = [];
    if (previous !== undefined) {
      void this.#request("session.unsubscribe", { subscriptionId: previous }).catch(
        () => undefined,
      );
    }
    show("thread");
    view.title.textContent = shareLabel(share);
    status("Opening session");
    this.#renderer ??= new (await threadView).ThreadRenderer(
      view.threadView,
      view.transcript,
      (following) => {
        view.jump.hidden = following;
      },
      (interactionId, action, content) => this.#respond(interactionId, action, content),
    );
    this.#renderer.clear();
    this.#renderActivity();
    try {
      const subscribe = async () =>
        (await this.#request("session.subscribe", {
          sessionId: share.sessionId,
        })) as SessionSubscription;
      let subscribed: SessionSubscription;
      try {
        // A session still open on the laptop needs no reopening, which saves a round trip.
        subscribed = await subscribe();
      } catch (cause) {
        if ((cause as { readonly code?: unknown }).code !== "unknown_session") throw cause;
        // Sessions close when the daemon restarts; reopening needs steer, so an observe-only phone
        // skips it and can still watch sessions that are open on the laptop.
        await this.#request("session.resume", { sessionId: share.sessionId }).catch(
          (cause: unknown) => {
            const code = (cause as { readonly code?: unknown }).code;
            if (code !== "unsafe_remote_forbidden" && code !== "scope_forbidden") throw cause;
          },
        );
        subscribed = await subscribe();
      }
      this.#subscriptionId = subscribed.subscriptionId;
      const snapshot = subscribed.snapshot;
      if (snapshot !== undefined) {
        let page = snapshot.page;
        for (;;) {
          for (const event of page.events) this.#projector.applyEvent(event);
          if (page.complete || page.nextPageCursor === undefined) break;
          const next = (await this.#request("session.history", {
            snapshotId: snapshot.snapshotId,
            pageCursor: page.nextPageCursor,
          })) as { readonly page: typeof page };
          page = next.page;
        }
        this.#render();
        // The daemon streams live events only after the snapshot boundary is acknowledged.
        this.#lastCursor = snapshot.boundaryCursor;
        await this.#request("session.ack", {
          subscriptionId: subscribed.subscriptionId,
          cursor: snapshot.boundaryCursor,
        });
        this.#ackedCursor = snapshot.boundaryCursor;
      }
      this.#render();
      status("Connected");
    } catch (cause) {
      if (this.#sessionId !== share.sessionId) return;
      if ((cause as { readonly code?: unknown }).code === "session_not_shared") {
        this.#closeThread("That session is no longer shared");
        void this.#fetchShares().catch(() => undefined);
        return;
      }
      status(`Could not open the session: ${describe(cause)}`, "error");
    }
  }

  async leaveThread(): Promise<void> {
    const subscriptionId = this.#subscriptionId;
    this.#subscriptionId = undefined;
    this.#sessionId = undefined;
    this.#share = undefined;
    this.#ackedCursor = undefined;
    this.#projector = undefined;
    this.#pending = [];
    this.#renderActivity();
    // Switch at once; the unsubscribe is a full encrypted round trip.
    const listed = this.listSessions();
    if (subscriptionId !== undefined) {
      await this.#request("session.unsubscribe", { subscriptionId }).catch(() => undefined);
    }
    await listed;
  }

  #onMessage(message: ServerMessage): void {
    trace(
      `server ${"kind" in message ? message.kind : "?"} ${"subscriptionId" in message ? (message.subscriptionId === this.#subscriptionId ? "current" : "other") : "-"} ${"event" in message ? message.event.type : ""}`,
    );
    if (!("kind" in message)) return;
    if (message.kind === "remote_shares") {
      this.#applyShares(message);
      return;
    }
    if (this.#projector === undefined) return;
    if (message.kind === "event" && message.subscriptionId === this.#subscriptionId) {
      this.#projector.applyEvent(message.event);
      this.#settlePending(message.event);
      this.#lastCursor = message.cursor;
      this.#scheduleAck();
      this.#render();
    } else if (message.kind === "activity" && message.subscriptionId === this.#subscriptionId) {
      this.#projector.applyActivity(message.frame);
      this.#render();
    }
  }

  /** A prompt the transcript now shows is no longer drawn as pending. */
  #settlePending(event: CanonicalEvent): void {
    if (event.type !== "user.message" && event.type !== "queue.enqueued") return;
    const text = contentText(event.payload.content).trim();
    const index = this.#pending.findIndex((prompt) => prompt.text === text);
    if (index >= 0) this.#pending = this.#pending.filter((_, position) => position !== index);
  }

  #request(...args: Parameters<RemoteBrowserSession["request"]>): Promise<unknown> {
    this.#inFlight += 1;
    return this.#session.request(...args).finally(() => {
      this.#inFlight -= 1;
    });
  }

  #scheduleAck(): void {
    if (this.#ackTimer !== undefined) return;
    this.#ackTimer = setTimeout(() => {
      this.#ackTimer = undefined;
      if (this.#inFlight > 0) {
        this.#scheduleAck();
        return;
      }
      const subscriptionId = this.#subscriptionId;
      const cursor = this.#lastCursor;
      if (subscriptionId === undefined || cursor === undefined) return;
      void this.#session
        .request("session.ack", { subscriptionId, cursor })
        .then(() => {
          if (this.#subscriptionId === subscriptionId) this.#ackedCursor = cursor;
        })
        .catch(() => undefined);
    }, ACK_DELAY_MS);
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
    // A notice sent while the page was away is lost; read the set again behind the conversation.
    void this.#fetchShares().catch(() => undefined);
    const share = this.#share;
    const previous = this.#subscriptionId;
    const after = this.#ackedCursor;
    if (share === undefined) return;
    if (previous === undefined) {
      // Opening the session failed while the daemon was away; try again now that it is back.
      await this.openThread(share);
      return;
    }
    status("Catching up");
    try {
      if (after === undefined) throw new Error("No acknowledged cursor to resume from");
      const resumed = (await this.#request("session.subscribe", {
        sessionId: share.sessionId,
        after,
      })) as { readonly subscriptionId: string };
      if (this.#subscriptionId !== previous) {
        // The view changed while resuming; drop the subscription nobody reads.
        void this.#request("session.unsubscribe", { subscriptionId: resumed.subscriptionId }).catch(
          () => undefined,
        );
        return;
      }
      this.#subscriptionId = resumed.subscriptionId;
      trace(`resumed ${share.sessionId} after ${after}`);
      void this.#request("session.unsubscribe", { subscriptionId: previous }).catch(
        () => undefined,
      );
      status("Connected");
    } catch (cause) {
      trace(`resume from cursor failed: ${describe(cause)}`);
      if (this.#subscriptionId === previous) await this.openThread(share);
    }
  }

  #render(): void {
    const state = this.#projector?.state;
    if (state === undefined) return;
    this.#renderer?.render({ state, pending: this.#pending, now: Date.now() });
    this.#renderActivity();
  }

  #renderActivity(): void {
    const state = this.#projector?.state;
    const busy = state?.activeOperationId !== undefined;
    view.stop.hidden = !busy;
    view.send.setAttribute("aria-label", busy ? "Queue" : "Send");
    view.prompt.placeholder = busy ? "Queue a follow-up" : "Message Axl";
    if (state === undefined || !busy) {
      view.activity.hidden = true;
      if (this.#ticker !== undefined) clearInterval(this.#ticker);
      this.#ticker = undefined;
      return;
    }
    const started = turnStartedAt(state);
    const stage = turnStage(state) ?? "Working";
    view.activity.hidden = false;
    view.activity.textContent =
      started === undefined ? stage : `${stage} · ${elapsed(Date.now() - started)}`;
    // Keep the elapsed time moving between frames while the turn runs.
    this.#ticker ??= setInterval(() => this.#render(), 1_000);
    this.#fitComposer();
  }

  async #send(): Promise<void> {
    const text = view.prompt.value.trim();
    const sessionId = this.#sessionId;
    if (text.length === 0 || sessionId === undefined) return;
    const busy = this.#projector?.state.activeOperationId !== undefined;
    view.prompt.value = "";
    this.#fitComposer();
    // Show the prompt at once; the daemon's record of it replaces this.
    const pending: PendingPrompt = { id: crypto.randomUUID(), text };
    this.#pending = [...this.#pending, pending];
    this.#renderer?.jumpToLatest();
    this.#render();
    const params = {
      sessionId,
      content: [{ type: "text", text }],
      delivery: busy ? "follow_up" : "prompt",
    };
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          // A prompt stays unanswered until its turn ends, so it does not hold acknowledgements back.
          await this.#session.request("session.send", params, SEND_TIMEOUT_MS);
          break;
        } catch (cause) {
          // A daemon restart closes sessions, and a prompt resent before the thread reopens is
          // refused with unknown_session. Refused means it never ran, so reopen and send it again.
          const code = (cause as { readonly code?: unknown }).code;
          if (code !== "unknown_session" || attempt === SEND_REOPEN_ATTEMPTS) throw cause;
          trace("send refused by a restarted daemon; reopening the session");
          await this.#request("session.resume", { sessionId });
        }
      }
      // The recorded prompt normally arrives first; never leave one drawn as pending for good.
      setTimeout(() => {
        if (!this.#pending.some((prompt) => prompt.id === pending.id)) return;
        this.#pending = this.#pending.filter((prompt) => prompt.id !== pending.id);
        this.#render();
      }, PENDING_SETTLE_MS);
    } catch (cause) {
      const reason = describe(cause);
      this.#pending = this.#pending.map((prompt) =>
        prompt.id === pending.id ? { ...prompt, failed: reason } : prompt,
      );
      this.#render();
      status(`Send failed: ${reason}`, "error");
    }
  }

  /** Answer the agent's question; the card shows a refusal's reason and stays answerable. */
  async #respond(
    interactionId: string,
    action: "accept" | "decline" | "cancel",
    content?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const sessionId = this.#sessionId;
    if (sessionId === undefined) throw new Error("This session is no longer open");
    try {
      await this.#session.request(
        "session.interaction.respond",
        { sessionId, interactionId, action, ...(content === undefined ? {} : { content }) },
        SEND_TIMEOUT_MS,
      );
    } catch (cause) {
      throw new Error(`Could not send the answer: ${describe(cause)}`);
    }
  }

  async #interrupt(): Promise<void> {
    const sessionId = this.#sessionId;
    if (sessionId === undefined) return;
    try {
      await this.#request("session.interrupt", { sessionId });
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

/** Show the sign-in button; it leaves for the provider and comes back to this page. */
function offerSignIn(signIn: PhoneSignIn, message: string, tone: "normal" | "error" = "normal") {
  show("sign-in");
  connection("offline");
  status(tone === "error" ? message : "Signed out", tone);
  view.signInHint.textContent =
    tone === "error" ? "Sign in again to keep using this phone." : message;
  view.signInButton.onclick = () => {
    view.signInButton.disabled = true;
    status("Opening sign-in");
    void signIn
      .authorizeUrl(location.hash)
      .then((url) => location.assign(url))
      .catch((cause: unknown) => {
        view.signInButton.disabled = false;
        status(`Could not start sign-in: ${describe(cause)}`, "error");
      });
  };
}

/**
 * Sign in when the stack asks for it. Returns the signed-in session, undefined when the stack has
 * no phone sign-in, or null when the page is waiting for the person to sign in.
 */
async function startSignIn(): Promise<PhoneSignIn | undefined | null> {
  const config = await loadSignInConfig(new URL(location.href));
  if (config === undefined) return undefined;
  const signIn = new PhoneSignIn({
    config,
    redirectUri: `${location.origin}${location.pathname}`,
    local: localStorage,
    session: sessionStorage,
  });
  try {
    status("Signing in");
    const returned = await signIn.complete(location.search);
    // Put the pairing link's fragment back where the pairing code looks for it.
    if (returned !== undefined)
      history.replaceState(null, "", `${location.pathname}${returned.fragment}`);
  } catch (cause) {
    history.replaceState(null, "", location.pathname);
    trace(`sign-in failed: ${describe(cause)}`);
    offerSignIn(signIn, cause instanceof Error ? cause.message : "Sign-in failed", "error");
    return null;
  }
  if (!signIn.signedIn) {
    offerSignIn(signIn, "Sign in to use this phone with Axl.");
    return null;
  }
  try {
    await signIn.accessToken();
  } catch (cause) {
    if (!(cause instanceof SignInRequiredError)) throw cause;
    offerSignIn(signIn, cause.message, "error");
    return null;
  }
  return signIn;
}

/** The bearer token for this phone: the signed-in session's, else the link's own. */
function tokenFor(signIn: PhoneSignIn | undefined, link: RemotePairingLink): () => Promise<string> {
  if (signIn !== undefined) return () => signIn.accessToken();
  const accessToken = link.accessToken;
  if (accessToken === undefined) {
    throw new Error("This pairing link needs a sign-in this page does not offer");
  }
  return async () => accessToken;
}

let bindingLoad: Promise<DeviceBinding> | undefined;

/**
 * The encryption module, imported once. Its worker fetches and verifies the wasm as soon as it
 * exists, so asking for the binding info starts that download while sign-in is still running.
 */
function loadBinding(): Promise<DeviceBinding> {
  bindingLoad ??= (
    import(
      /* @vite-ignore */ new URL("./e2ee/loader/index.js", location.href).href
    ) as Promise<DeviceBinding>
  ).then((binding) => {
    void binding.getBindingInfo().catch(() => undefined);
    return binding;
  });
  return bindingLoad;
}

async function main(): Promise<void> {
  followColorScheme();
  void loadBinding().catch(() => undefined);
  const signIn = await startSignIn();
  if (signIn === null) return;
  let stored: StoredPairing | undefined;
  try {
    stored = await currentPairing();
  } catch (cause) {
    show("pairing");
    trace(`pairing link rejected: ${describe(cause)}`);
    status("This pairing link expired or can no longer be opened", "error");
    view.hint.textContent = "Run /remote in the Axl terminal again and scan the new code.";
    return;
  }
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
  // A newer tab for this pairing may ask for it at any point, even while this one is starting.
  const channel = tabChannel();
  let superseded = false;
  let onTakeover = () => {
    superseded = true;
  };
  if (channel !== undefined) {
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as {
        type?: unknown;
        session?: unknown;
        tab?: unknown;
        started?: unknown;
      };
      // Only a newer tab takes the pairing; an older one that is still starting waits for this
      // tab's owner mark and gives up.
      if (
        message.type === "takeover" &&
        message.session === link.cryptoSessionId &&
        newerTab(message.started, message.tab)
      ) {
        onTakeover();
      }
    };
  }
  // Enrollment comes first: a link already used on another device must be refused before this
  // browser touches any E2EE or witness state for its device ID.
  const token = tokenFor(signIn, link);
  const key = await deviceKey(link.deviceId);
  if (stored.enrolled !== true) {
    status("Registering this device");
    await enroll(link, key, token);
    save({ ...stored, enrolled: true });
  }
  // The relay's first ticket is fetched while the encryption module loads and the endpoint opens.
  const relay = relayFor(link, key, token);
  status("Loading the encryption module");
  const binding = await loadBinding();
  await binding.authorizeWitness(`Bearer ${await token()}`);
  if (signIn !== undefined) {
    // Each refreshed access token goes to the witness too. Checking every minute (and when the
    // page wakes) refreshes it before it expires, even while nothing else asks for it.
    signIn.onToken((accessToken) => void binding.authorizeWitness(`Bearer ${accessToken}`));
    const keepFresh = () =>
      void signIn.accessToken().catch((cause: unknown) => {
        if (cause instanceof SignInRequiredError) offerSignIn(signIn, cause.message, "error");
        else trace(`token refresh failed: ${describe(cause)}`);
      });
    setInterval(keepFresh, 60_000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") keepFresh();
    });
  }
  status("Opening this device's keys");
  const opened = await openExclusive(binding, link, channel, () => superseded);
  if (opened === undefined || superseded) {
    // A newer tab asked for the pairing while this one was starting.
    relay.close();
    await opened?.close().catch(() => undefined);
    showMoved();
    return;
  }
  markOwner(link);
  const endpoint = traced(opened);
  const session = new RemoteBrowserSession({ endpoint, relay, ...link, trace });

  // A newer tab for the same pairing takes over; this one lets go of the endpoint and its lock.
  let released = false;
  const release = async (moved: boolean) => {
    if (released) return;
    released = true;
    letGo = true;
    session.close();
    relay.close();
    await endpoint.close().catch(() => undefined);
    if (moved) {
      showMoved();
      return;
    }
    show("pairing");
    view.steps.replaceChildren();
    status("Paused", "normal", true);
    view.hint.textContent = "Tap the button to use this pairing here instead.";
    view.retry.textContent = "Use this tab";
    view.retry.hidden = false;
  };
  onTakeover = () => void release(true);
  // A tab that missed the request, because the phone had suspended it, sees the new owner here.
  addEventListener("storage", (event) => {
    if (event.key === OWNER_KEY && ownedElsewhere(link)) void release(true);
  });
  // A page restored from the back-forward cache let go of everything when it was hidden.
  addEventListener("pagehide", () => void release(false));
  addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });

  relay.onState((state) => {
    trace(`relay ${state}`);
    if (released) return;
    // Another tab connecting replaces this one's relay route; reconnecting would replace it back.
    if (state !== "connected" && ownedElsewhere(link)) {
      void release(true);
      return;
    }
    connection(state === "connected" ? "online" : "connecting");
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
    if (relay.state === "connected") connection(online ? "online" : "offline");
    if (!online && relay.state === "connected") status(DAEMON_OFFLINE);
    else if (online && view.status.textContent === DAEMON_OFFLINE) status("Connected");
  });
  // A phone that wakes the page or regains its network checks the socket at once, rather than
  // waiting for the next heartbeat to notice it died while suspended.
  const wake = () => {
    if (document.visibilityState !== "visible" || released) return;
    if (ownedElsewhere(link)) void release(true);
    else void relay.checkAlive();
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
        authorization: token,
      }),
      relay,
      // Any answered request proves the daemon accepted the activation.
      confirm: async () => {
        await session.request("remote.shares", {}, CONFIRM_TIMEOUT_MS);
      },
      onStep: renderSteps,
    });
    save({ fragment: stored.fragment, paired: true, enrolled: true });
  }
  const page = new RemotePage(session);
  await page.listSessions();
}

// A new link opened in an already open tab only changes the fragment; start over with it.
addEventListener("hashchange", () => location.reload());
view.retry.addEventListener("click", () => location.reload());

main().catch((cause: unknown) => {
  // A tab that handed the pairing over already says so; what it was doing then was cut off.
  if (letGo) return;
  connection("offline");
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
