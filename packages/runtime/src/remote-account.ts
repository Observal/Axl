// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * The daemon's remote-access account: who it signed in as, its installation, and the two secrets
 * it holds, the account's refresh token and the installation's P-256 key.
 *
 * `axl remote login` writes `~/.axl/remote/account.json` (owner-only). Both secrets in it are sealed
 * by the same platform store that keeps the E2EE envelope keys, so a copy of the file opened by
 * another user or on another machine cannot use them:
 *
 * - in WSL, Windows DPAPI for the signed-in Windows user, through `axl-dpapi-helper.exe`; and
 * - on a Linux desktop, AES-256-GCM under a key kept in the session's Secret Service (GNOME Keyring
 *   or KWallet 6), which the hosted Linux binding creates and reads.
 *
 * Each sealed value carries its purpose and account, so one cannot stand in for the other.
 *
 * At run time the refresh token gets short-lived access tokens from the user pool, and the key
 * signs each daemon relay admission (the same possession proof a device gives), registered once
 * with the control plane under the account.
 */

import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  encodeRemoteInstallationRegistrationRequest,
  type InstallationId,
  parseInstallationId,
  REMOTE_INSTALLATION_REGISTRATION_PATH,
  remoteDevicePossessionMessage,
} from "@axl/protocol";

const ACCOUNT_VERSION = 1;
const HELPER_PROTOCOL = "axl-dpapi-helper-v1";
const HELPER_MAX_PAYLOAD = 64 * 1024;
const SEAL_DOMAIN = "axl-remote-account-v1";
/** Refresh this long before the access token expires, so no request carries a stale one. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_TOKEN_CHARACTERS = 16_384;

/** Where `axl remote login` returns; registered with the user pool's daemon client. */
export const REMOTE_LOGIN_PORT = 47_813;
export const REMOTE_LOGIN_REDIRECT = `http://localhost:${REMOTE_LOGIN_PORT}/callback`;
/** The production stack, unless `axl remote login --origin` names another. */
export const DEFAULT_REMOTE_ORIGIN = "https://remote.observal.io";

export class RemoteAccountError extends Error {
  readonly code:
    | "helper_unavailable"
    | "sign_in_required"
    | "not_enabled"
    | "invalid_account"
    | "sign_in_failed";

  constructor(code: RemoteAccountError["code"], message: string) {
    super(message);
    this.name = "RemoteAccountError";
    this.code = code;
  }
}

/** `~/.axl/remote/account.json`. */
export function remoteAccountPath(axlHome: string): string {
  return join(axlHome, "remote", "account.json");
}

/** Whether this is a Linux kernel running under WSL 2. */
export function isWsl(): boolean {
  return process.platform === "linux" && /microsoft/iu.test(release());
}

/** The hosted Node binding this machine's daemon uses: WSL 2 or a Linux desktop. */
export function hostedBindingKind(): "hosted-wsl" | "hosted-linux" | undefined {
  if (process.platform !== "linux") return undefined;
  return isWsl() ? "hosted-wsl" : "hosted-linux";
}

/** The hosted Node binding built beside this checkout (`build.mjs hosted-wsl|hosted-linux`). */
export function defaultHostedBinding(kind = hostedBindingKind() ?? "hosted-wsl"): string {
  return fileURLToPath(
    new URL(`../../e2ee/bindings/node/dist/${kind}/loader/index.js`, import.meta.url),
  );
}

// ---- DPAPI helper -------------------------------------------------------------------------------

const STATUS_OK = 0;
const STATUS_DENIED = 2;
const OP_HELLO = 0;
const OP_PROTECT = 2;
const OP_UNPROTECT = 3;

/**
 * One helper process, spoken to with its framed protocol: `op u8 | length u32 | payload` in and
 * `status u8 | length u32 | payload` out.
 */
export class DpapiHelper implements AccountSealer {
  readonly #child: ChildProcessWithoutNullStreams;
  #buffer = Buffer.alloc(0);
  #waiting: ((frame: { status: number; payload: Buffer } | Error) => void) | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #failed: Error | undefined;

  private constructor(path: string) {
    this.#child = spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stderr.resume();
    this.#child.stdout.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#deliver();
    });
    const fail = (error: Error) => {
      this.#failed ??= error;
      const waiting = this.#waiting;
      this.#waiting = undefined;
      waiting?.(this.#failed);
    };
    this.#child.on("error", fail);
    this.#child.on("exit", () =>
      fail(new RemoteAccountError("helper_unavailable", "The DPAPI helper stopped")),
    );
  }

  /** Start the helper at `path` and check that it speaks this protocol. */
  static async open(path: string): Promise<DpapiHelper> {
    const helper = new DpapiHelper(path);
    try {
      const hello = await helper.#request(OP_HELLO, Buffer.alloc(0));
      if (hello.toString("utf8") !== HELPER_PROTOCOL) throw new Error("unexpected protocol");
    } catch (cause) {
      helper.close();
      throw new RemoteAccountError(
        "helper_unavailable",
        `The DPAPI helper at ${path} is not available: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    return helper;
  }

  #deliver(): void {
    if (this.#waiting === undefined || this.#buffer.byteLength < 5) return;
    const length = this.#buffer.readUInt32BE(1);
    if (this.#buffer.byteLength < 5 + length) return;
    const status = this.#buffer[0] as number;
    const payload = Buffer.from(this.#buffer.subarray(5, 5 + length));
    this.#buffer = Buffer.from(this.#buffer.subarray(5 + length));
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting({ status, payload });
  }

  #request(op: number, payload: Buffer): Promise<Buffer> {
    if (payload.byteLength > HELPER_MAX_PAYLOAD) {
      return Promise.reject(new RangeError("The value is too large to seal"));
    }
    const run = this.#tail.then(
      () =>
        new Promise<Buffer>((resolve, reject) => {
          if (this.#failed !== undefined) {
            reject(this.#failed);
            return;
          }
          this.#waiting = (frame) => {
            if (frame instanceof Error) reject(frame);
            else if (frame.status === STATUS_OK) resolve(frame.payload);
            else if (frame.status === STATUS_DENIED) {
              reject(
                new RemoteAccountError(
                  "sign_in_required",
                  "Windows refused to unseal the remote account for this user",
                ),
              );
            } else {
              reject(
                new RemoteAccountError(
                  "helper_unavailable",
                  `The DPAPI helper answered status ${frame.status}`,
                ),
              );
            }
          };
          const header = Buffer.alloc(5);
          header[0] = op;
          header.writeUInt32BE(payload.byteLength, 1);
          this.#child.stdin.write(Buffer.concat([header, payload]));
          this.#deliver();
        }),
    );
    this.#tail = run.catch(() => undefined);
    return run;
  }

  protect(value: Buffer): Promise<Buffer> {
    return this.#request(OP_PROTECT, value);
  }

  unprotect(value: Buffer): Promise<Buffer> {
    return this.#request(OP_UNPROTECT, value);
  }

  close(): void {
    this.#child.stdin.end();
  }
}

// ---- Secret Service key -------------------------------------------------------------------------

/** The hosted Linux binding's account-key and service-detection exports. */
interface HostedLinuxSealing {
  hostedLinuxSecretService(): string;
  hostedLinuxAccountKey(implementation: string, create: boolean): Uint8Array;
}

const KEY_SEAL_VERSION = 1;
const KEY_SEAL_NONCE_BYTES = 12;
const KEY_SEAL_TAG_BYTES = 16;
const KEY_SEAL_AAD = Buffer.from("axl-remote-account-key-seal-v1", "utf8");

/** AES-256-GCM under a 32-byte key: `version u8 | nonce | ciphertext | tag`. */
export class KeySealer implements AccountSealer {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new RangeError("An account key is 32 bytes");
    this.#key = Buffer.from(key);
  }

  async protect(value: Buffer): Promise<Buffer> {
    const nonce = randomBytes(KEY_SEAL_NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(KEY_SEAL_AAD);
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    return Buffer.concat([Buffer.of(KEY_SEAL_VERSION), nonce, ciphertext, cipher.getAuthTag()]);
  }

  async unprotect(sealed: Buffer): Promise<Buffer> {
    const header = 1 + KEY_SEAL_NONCE_BYTES;
    if (sealed.byteLength < header + KEY_SEAL_TAG_BYTES || sealed[0] !== KEY_SEAL_VERSION) {
      throw new RemoteAccountError("invalid_account", "A sealed account value is malformed");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#key, sealed.subarray(1, header));
    decipher.setAAD(KEY_SEAL_AAD);
    decipher.setAuthTag(sealed.subarray(sealed.byteLength - KEY_SEAL_TAG_BYTES));
    try {
      return Buffer.concat([
        decipher.update(sealed.subarray(header, sealed.byteLength - KEY_SEAL_TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw new RemoteAccountError(
        "sign_in_required",
        "The keyring's account key does not open the remote account",
      );
    }
  }

  close(): void {
    this.#key.fill(0);
  }
}

async function hostedLinuxBinding(binding: string): Promise<HostedLinuxSealing> {
  try {
    return (await import(pathToFileURL(binding).href)) as HostedLinuxSealing;
  } catch (cause) {
    throw new RemoteAccountError(
      "helper_unavailable",
      `The hosted Linux binding at ${binding} is not available: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** Why the desktop keyring refused, as an account error. */
function keyringError(cause: unknown): RemoteAccountError {
  const code = (cause as { readonly code?: unknown } | undefined)?.code;
  if (code === "key_record_missing") {
    return new RemoteAccountError(
      "sign_in_required",
      "The desktop keyring holds no remote account key; run axl remote login",
    );
  }
  return new RemoteAccountError(
    "helper_unavailable",
    `The desktop keyring is not available (${typeof code === "string" ? code : String(cause)}). Remote access needs an unlocked GNOME Keyring or KWallet 6 in a graphical session.`,
  );
}

/** The tested Secret Service implementation serving this desktop session. */
export async function detectSecretService(binding: string): Promise<SecretServiceImplementation> {
  const module = await hostedLinuxBinding(binding);
  let found: string;
  try {
    found = module.hostedLinuxSecretService();
  } catch (cause) {
    throw keyringError(cause);
  }
  return parseImplementation(found);
}

// ---- Sealing ------------------------------------------------------------------------------------

/** Seals and opens the account's secrets for this machine's user. */
export interface AccountSealer {
  protect(value: Buffer): Promise<Buffer>;
  unprotect(value: Buffer): Promise<Buffer>;
  close(): void;
}

export type SecretServiceImplementation = "gnome-keyring" | "kwallet6";

/**
 * Where an account's secrets are sealed: through the Windows user's `axl-dpapi-helper.exe` (a WSL
 * path), or under a key in the Linux desktop session's Secret Service.
 */
export type RemoteAccountSealer =
  | { readonly kind: "dpapi"; readonly helper: string }
  | { readonly kind: "secret-service"; readonly implementation: SecretServiceImplementation };

function parseImplementation(value: unknown): SecretServiceImplementation {
  if (value === "gnome-keyring" || value === "kwallet6") return value;
  throw new RemoteAccountError("invalid_account", "Remote account keyring is not supported");
}

/** Open the account's sealer. Only login creates a missing keyring key. */
export async function openAccountSealer(
  sealer: RemoteAccountSealer,
  binding: string,
  options: { readonly create?: boolean } = {},
): Promise<AccountSealer> {
  if (sealer.kind === "dpapi") return DpapiHelper.open(sealer.helper);
  const module = await hostedLinuxBinding(binding);
  let key: Uint8Array;
  try {
    key = module.hostedLinuxAccountKey(sealer.implementation, options.create ?? false);
  } catch (cause) {
    throw keyringError(cause);
  }
  const opened = new KeySealer(key);
  key.fill(0);
  return opened;
}

function sameSealer(left: RemoteAccountSealer, right: RemoteAccountSealer): boolean {
  return left.kind === "dpapi"
    ? right.kind === "dpapi" && left.helper === right.helper
    : right.kind === "secret-service" && left.implementation === right.implementation;
}

type SealPurpose = "refresh-token" | "installation-key";

function sealContext(purpose: SealPurpose, accountId: string): Buffer {
  return Buffer.from(`${SEAL_DOMAIN}\0${purpose}\0${accountId}\0`, "utf8");
}

async function seal(
  helper: AccountSealer,
  purpose: SealPurpose,
  accountId: string,
  value: Buffer,
): Promise<string> {
  const sealed = await helper.protect(Buffer.concat([sealContext(purpose, accountId), value]));
  return sealed.toString("base64");
}

async function unseal(
  helper: AccountSealer,
  purpose: SealPurpose,
  accountId: string,
  sealed: string,
): Promise<Buffer> {
  const opened = await helper.unprotect(Buffer.from(sealed, "base64"));
  const context = sealContext(purpose, accountId);
  if (
    opened.byteLength <= context.byteLength ||
    !opened.subarray(0, context.byteLength).equals(context)
  ) {
    opened.fill(0);
    throw new RemoteAccountError("invalid_account", `The sealed ${purpose} belongs elsewhere`);
  }
  const value = Buffer.from(opened.subarray(context.byteLength));
  opened.fill(0);
  return value;
}

/**
 * The helper installed for this Windows user, `%LOCALAPPDATA%\Axl\bin\axl-dpapi-helper.exe`, as a
 * WSL path. Undefined outside WSL or when Windows cannot be asked.
 */
export async function defaultDpapiHelper(): Promise<string | undefined> {
  if (process.platform !== "linux" || process.env.WSL_DISTRO_NAME === undefined) return undefined;
  const run = promisify(execFile);
  try {
    // cmd.exe refuses a WSL working directory, so start it from the Windows drive.
    const { stdout } = await run("cmd.exe", ["/d", "/c", "echo %LOCALAPPDATA%"], {
      cwd: "/mnt/c",
      timeout: 10_000,
    });
    const windowsPath = stdout.trim();
    if (!/^[A-Za-z]:\\/u.test(windowsPath)) return undefined;
    const { stdout: linuxPath } = await run("wslpath", ["-u", windowsPath], { timeout: 10_000 });
    return join(linuxPath.trim(), "Axl", "bin", "axl-dpapi-helper.exe");
  } catch {
    return undefined;
  }
}

// ---- Account file -------------------------------------------------------------------------------

export interface RemoteAccountFile {
  readonly version: typeof ACCOUNT_VERSION;
  /** HTTPS origin of the stack: control plane, relay tickets, and the phone page. */
  readonly origin: string;
  readonly pagePath: string;
  /** Origin of the user pool's hosted domain. */
  readonly authority: string;
  readonly clientId: string;
  /** The user pool's `sub` for the signed-in person. */
  readonly accountId: string;
  readonly email?: string;
  readonly installationId: InstallationId;
  /**
   * Where the secrets are sealed. Stored as `helper` alone for DPAPI, as before, so a WSL account
   * file reads the same in older daemons.
   */
  readonly sealer: RemoteAccountSealer;
  /** The hosted Node binding loader. */
  readonly binding: string;
  /** Base64 of the sealed refresh token. */
  readonly refreshToken: string;
  /** Base64 of the sealed PKCS#8 installation key. */
  readonly installationKey: string;
}

function parseSealer(record: Record<string, unknown>): RemoteAccountSealer {
  if (record.sealer === undefined) return { kind: "dpapi", helper: text(record.helper, "helper") };
  const sealer = (
    typeof record.sealer === "object" && record.sealer !== null ? record.sealer : {}
  ) as Record<string, unknown>;
  if (sealer.kind === "secret-service" && record.helper === undefined) {
    return { kind: "secret-service", implementation: parseImplementation(sealer.implementation) };
  }
  throw new RemoteAccountError("invalid_account", "Remote account sealer is invalid");
}

/** The account as stored: DPAPI accounts keep the original `helper` field. */
function storedAccount(account: RemoteAccountFile): Record<string, unknown> {
  const { sealer, ...rest } = account;
  return sealer.kind === "dpapi" ? { ...rest, helper: sealer.helper } : { ...rest, sealer };
}

function text(value: unknown, name: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new RemoteAccountError("invalid_account", `Remote account ${name} is invalid`);
  }
  return value;
}

function httpsOrigin(value: unknown, name: string): string {
  let url: URL;
  try {
    url = new URL(text(value, name));
  } catch {
    throw new RemoteAccountError("invalid_account", `Remote account ${name} is invalid`);
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new RemoteAccountError(
      "invalid_account",
      `Remote account ${name} must be an HTTPS origin`,
    );
  }
  return url.origin;
}

export function parseRemoteAccountFile(value: unknown): RemoteAccountFile {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  if (record.version !== ACCOUNT_VERSION) {
    throw new RemoteAccountError("invalid_account", "Remote account version is unsupported");
  }
  const pagePath = text(record.pagePath, "pagePath");
  if (!pagePath.startsWith("/") || !pagePath.endsWith("/")) {
    throw new RemoteAccountError("invalid_account", "Remote account pagePath is invalid");
  }
  const accountId = text(record.accountId, "accountId", 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(accountId)) {
    throw new RemoteAccountError("invalid_account", "Remote account accountId is invalid");
  }
  return {
    version: ACCOUNT_VERSION,
    origin: httpsOrigin(record.origin, "origin"),
    pagePath,
    authority: httpsOrigin(record.authority, "authority"),
    clientId: text(record.clientId, "clientId", 256),
    accountId,
    ...(typeof record.email === "string" && record.email.length <= 320
      ? { email: record.email }
      : {}),
    installationId: parseInstallationId(record.installationId),
    sealer: parseSealer(record),
    binding: text(record.binding, "binding"),
    refreshToken: text(record.refreshToken, "refreshToken", 65_536),
    installationKey: text(record.installationKey, "installationKey", 65_536),
  };
}

/** The stored account, or undefined when this machine has not signed in. */
export async function loadRemoteAccount(axlHome: string): Promise<RemoteAccountFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(remoteAccountPath(axlHome), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  return parseRemoteAccountFile(JSON.parse(raw));
}

async function writeRemoteAccount(axlHome: string, account: RemoteAccountFile): Promise<void> {
  const path = remoteAccountPath(axlHome);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staging = `${path}.${randomUUID()}.next`;
  await writeFile(staging, `${JSON.stringify(storedAccount(account), null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(staging, path);
}

export async function removeRemoteAccount(axlHome: string): Promise<boolean> {
  const path = remoteAccountPath(axlHome);
  try {
    await rm(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

// ---- Sign-in ------------------------------------------------------------------------------------

export interface DaemonSignInConfig {
  readonly authority: string;
  readonly clientId: string;
  readonly provider: string;
}

/** Where the stack's daemon signs in, from `daemon-sign-in.json` beside the phone page. */
export async function loadDaemonSignInConfig(
  origin: string,
  pagePath: string,
  fetcher: typeof fetch = fetch,
): Promise<DaemonSignInConfig> {
  const response = await fetcher(new URL(`${pagePath}daemon-sign-in.json`, origin));
  if (!response.ok) {
    throw new RemoteAccountError(
      "sign_in_failed",
      `${origin} does not offer daemon sign-in (HTTP ${response.status})`,
    );
  }
  const value = (await response.json()) as Record<string, unknown>;
  return {
    authority: httpsOrigin(value.authority, "authority"),
    clientId: text(value.clientId, "clientId", 256),
    provider:
      typeof value.provider === "string" && value.provider.length > 0 ? value.provider : "Google",
  };
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** The claims of a JWT from the token endpoint, which answered over TLS; not a verification. */
function claims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (payload === undefined) throw new RemoteAccountError("sign_in_failed", "Malformed token");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

interface TokenAnswer {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly refreshToken?: string;
  readonly idToken?: string;
}

function tokenAnswer(value: unknown, now: number): TokenAnswer {
  const body = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const { access_token: accessToken, expires_in: expiresIn } = body;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    accessToken.length > MAX_TOKEN_CHARACTERS ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new RemoteAccountError("sign_in_failed", "Sign-in answered without an access token");
  }
  return {
    accessToken,
    expiresAt: now + expiresIn * 1000,
    ...(typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? { refreshToken: body.refresh_token }
      : {}),
    ...(typeof body.id_token === "string" ? { idToken: body.id_token } : {}),
  };
}

async function tokenRequest(
  authority: string,
  form: Record<string, string>,
  fetcher: typeof fetch,
  now: number,
): Promise<TokenAnswer> {
  const response = await fetcher(new URL("/oauth2/token", authority), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (response.status === 400 || response.status === 401) {
    throw new RemoteAccountError(
      "sign_in_required",
      "The remote sign-in expired or was revoked. Run axl remote login again.",
    );
  }
  if (!response.ok) {
    throw new RemoteAccountError("sign_in_failed", `Sign-in failed with HTTP ${response.status}`);
  }
  return tokenAnswer(await response.json(), now);
}

/** A sign-in started in the browser; `complete` waits for its loopback redirect. */
export interface PendingRemoteSignIn {
  /** Open this in a browser. */
  readonly url: string;
  /** Resolve with the tokens once the browser returns, or reject after `timeoutMs`. */
  complete(timeoutMs?: number): Promise<TokenAnswer>;
  cancel(): void;
}

const RESPONSE_PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Axl</title><body style="font:16px system-ui;margin:3em">${message}</body>`;

/** Start the authorization code flow with PKCE, listening on the loopback redirect. */
export async function startRemoteSignIn(options: {
  readonly config: DaemonSignInConfig;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly port?: number;
}): Promise<PendingRemoteSignIn> {
  const { createServer } = await import("node:http");
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const port = options.port ?? REMOTE_LOGIN_PORT;
  const redirectUri = `http://localhost:${port}/callback`;
  const state = base64Url(randomBytes(16));
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());

  let settle: ((result: { code: string } | Error) => void) | undefined;
  const answered = new Promise<{ code: string } | Error>((resolve) => {
    settle = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", redirectUri);
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const matches = url.searchParams.get("state") === state;
    const ok = matches && code !== null && error === null;
    response.writeHead(ok ? 200 : 400, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      RESPONSE_PAGE(
        ok
          ? "Signed in. You can close this tab and return to the terminal."
          : "Sign-in did not complete. Return to the terminal and try again.",
      ),
    );
    if (!matches) return;
    settle?.(
      ok
        ? { code: code as string }
        : new RemoteAccountError(
            "sign_in_failed",
            error === "access_denied" ? "Sign-in was cancelled" : "Sign-in failed",
          ),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (cause: NodeJS.ErrnoException) =>
      reject(
        cause.code === "EADDRINUSE"
          ? new RemoteAccountError(
              "sign_in_failed",
              `Port ${port} is in use; close whatever holds it and try again`,
            )
          : cause,
      ),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  const close = () => server.close();

  const url = new URL("/oauth2/authorize", options.config.authority);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: options.config.clientId,
    redirect_uri: redirectUri,
    scope: "openid email",
    identity_provider: options.config.provider,
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  }).toString();

  return {
    url: url.toString(),
    cancel: () => {
      settle?.(new RemoteAccountError("sign_in_failed", "Sign-in was cancelled"));
      close();
    },
    async complete(timeoutMs = 5 * 60_000) {
      const timer = setTimeout(
        () => settle?.(new RemoteAccountError("sign_in_failed", "Sign-in timed out")),
        timeoutMs,
      );
      try {
        const result = await answered;
        if (result instanceof Error) throw result;
        return await tokenRequest(
          options.config.authority,
          {
            grant_type: "authorization_code",
            client_id: options.config.clientId,
            code: result.code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
          },
          fetcher,
          now(),
        );
      } finally {
        clearTimeout(timer);
        close();
      }
    },
  };
}

/** A UUIDv7: 48-bit millisecond time, version 7, variant 10, random remainder. */
function uuidV7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Store the signed-in account: a new installation and key unless this machine already has one for
 * the same account and stack, with both secrets sealed by `sealer`.
 */
export async function saveRemoteAccount(options: {
  readonly axlHome: string;
  readonly origin: string;
  readonly pagePath: string;
  readonly config: DaemonSignInConfig;
  readonly tokens: TokenAnswer;
  readonly sealer: RemoteAccountSealer;
  readonly binding: string;
}): Promise<RemoteAccountFile> {
  const refreshToken = options.tokens.refreshToken;
  if (refreshToken === undefined) {
    throw new RemoteAccountError("sign_in_failed", "Sign-in answered without a refresh token");
  }
  const access = claims(options.tokens.accessToken);
  const accountId = text(access.sub, "account", 36);
  const email =
    options.tokens.idToken === undefined ? undefined : claims(options.tokens.idToken).email;
  const previous = await loadRemoteAccount(options.axlHome).catch(() => undefined);
  const helper = await openAccountSealer(options.sealer, options.binding, { create: true });
  try {
    // Keep the installation (and its paired phone) when the same person signs in again.
    const keep =
      previous !== undefined &&
      previous.accountId === accountId &&
      previous.origin === options.origin &&
      sameSealer(previous.sealer, options.sealer);
    let installationId: InstallationId;
    let installationKey: string;
    if (keep) {
      installationId = previous.installationId;
      installationKey = previous.installationKey;
      // Unsealing proves the kept key still opens for this user.
      (await unseal(helper, "installation-key", accountId, installationKey)).fill(0);
    } else {
      installationId = parseInstallationId(uuidV7());
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
      installationKey = await seal(helper, "installation-key", accountId, pkcs8);
      pkcs8.fill(0);
    }
    const account: RemoteAccountFile = {
      version: ACCOUNT_VERSION,
      origin: options.origin,
      pagePath: options.pagePath,
      authority: options.config.authority,
      clientId: options.config.clientId,
      accountId,
      ...(typeof email === "string" ? { email } : {}),
      installationId,
      sealer: options.sealer,
      binding: options.binding,
      refreshToken: await seal(helper, "refresh-token", accountId, Buffer.from(refreshToken)),
      installationKey,
    };
    await writeRemoteAccount(options.axlHome, parseRemoteAccountFile(storedAccount(account)));
    return account;
  } finally {
    helper.close();
  }
}

// ---- Run time -----------------------------------------------------------------------------------

/**
 * The daemon's live credentials for a stored account: access tokens from the sealed refresh token,
 * relay possession proofs from the sealed installation key, and the installation's registration.
 */
export class RemoteAccountSession {
  readonly account: RemoteAccountFile;
  readonly #axlHome: string;
  readonly #key: KeyObject;
  #refreshToken: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #access: { readonly token: string; readonly expiresAt: number } | undefined;
  #refreshing: Promise<string> | undefined;
  #registered = false;

  private constructor(
    axlHome: string,
    account: RemoteAccountFile,
    refreshToken: string,
    key: KeyObject,
    fetcher: typeof fetch,
    now: () => number,
  ) {
    this.#axlHome = axlHome;
    this.account = account;
    this.#refreshToken = refreshToken;
    this.#key = key;
    this.#fetch = fetcher;
    this.#now = now;
  }

  /** Unseal the stored account's secrets for this run. */
  static async open(
    axlHome: string,
    account: RemoteAccountFile,
    options: { readonly fetch?: typeof fetch; readonly now?: () => number } = {},
  ): Promise<RemoteAccountSession> {
    const helper = await openAccountSealer(account.sealer, account.binding);
    try {
      const refreshToken = await unseal(
        helper,
        "refresh-token",
        account.accountId,
        account.refreshToken,
      );
      const pkcs8 = await unseal(
        helper,
        "installation-key",
        account.accountId,
        account.installationKey,
      );
      const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
      pkcs8.fill(0);
      if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
        throw new RemoteAccountError("invalid_account", "The installation key is not P-256");
      }
      const session = new RemoteAccountSession(
        axlHome,
        account,
        refreshToken.toString("utf8"),
        key,
        options.fetch ?? fetch,
        options.now ?? Date.now,
      );
      refreshToken.fill(0);
      return session;
    } finally {
      helper.close();
    }
  }

  /** A current access token, refreshed shortly before it expires. */
  accessToken(): Promise<string> {
    const current = this.#access;
    if (current !== undefined && current.expiresAt - REFRESH_MARGIN_MS > this.#now()) {
      return Promise.resolve(current.token);
    }
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<string> {
    const answer = await tokenRequest(
      this.account.authority,
      {
        grant_type: "refresh_token",
        client_id: this.account.clientId,
        refresh_token: this.#refreshToken,
      },
      this.#fetch,
      this.#now(),
    );
    this.#access = { token: answer.accessToken, expiresAt: answer.expiresAt };
    if (answer.refreshToken !== undefined && answer.refreshToken !== this.#refreshToken) {
      // A rotated refresh token replaces the stored one, sealed again.
      this.#refreshToken = answer.refreshToken;
      const helper = await openAccountSealer(this.account.sealer, this.account.binding);
      try {
        const account = {
          ...this.account,
          refreshToken: await seal(
            helper,
            "refresh-token",
            this.account.accountId,
            Buffer.from(answer.refreshToken),
          ),
        };
        await writeRemoteAccount(this.#axlHome, account);
      } finally {
        helper.close();
      }
    }
    return answer.accessToken;
  }

  /** Revoke the refresh token and the access tokens it issued. */
  async revoke(): Promise<void> {
    const response = await this.#fetch(new URL("/oauth2/revoke", this.account.authority), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: this.#refreshToken,
        client_id: this.account.clientId,
      }).toString(),
    });
    if (!response.ok) throw new Error(`Token revocation failed with HTTP ${response.status}`);
    this.#access = undefined;
  }

  /** The installation's public key as DER SubjectPublicKeyInfo. */
  publicKey(): Uint8Array {
    return new Uint8Array(
      createPublicKey(this.#key).export({ format: "der", type: "spki" }) as Buffer,
    );
  }

  /** A daemon relay admission proof: the installation key's signature over ticket and nonce. */
  proof(ticket: string): {
    readonly connectionNonce: string;
    readonly possessionProof: Uint8Array;
  } {
    const connectionNonce = randomUUID();
    return {
      connectionNonce,
      possessionProof: new Uint8Array(
        sign("sha256", remoteDevicePossessionMessage(ticket, connectionNonce), {
          key: this.#key,
          dsaEncoding: "ieee-p1363",
        }),
      ),
    };
  }

  /**
   * Register the installation's key under the account; idempotent. A control plane that refuses
   * the account (not in the remote group) is reported as `not_enabled`.
   */
  async register(): Promise<void> {
    if (this.#registered) return;
    const response = await this.#fetch(
      new URL(REMOTE_INSTALLATION_REGISTRATION_PATH, this.account.origin),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          encodeRemoteInstallationRegistrationRequest({
            version: 1,
            installationId: this.account.installationId,
            publicKey: this.publicKey(),
          }),
        ),
      },
    );
    if (response.status === 401) {
      // A token issued before the person was added to the remote group lacks the claim; the next
      // attempt gets a fresh one.
      this.#access = undefined;
      throw new RemoteAccountError(
        "not_enabled",
        `Remote access is not enabled for ${this.account.email ?? this.account.accountId}`,
      );
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as
        | { readonly error?: { readonly code?: unknown } }
        | undefined;
      const code = typeof body?.error?.code === "string" ? body.error.code : response.status;
      throw new Error(`Installation registration failed (${code})`);
    }
    this.#registered = true;
  }
}
