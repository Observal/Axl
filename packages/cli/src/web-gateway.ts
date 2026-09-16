// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection, type Socket } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  MAX_WIRE_MESSAGE_BYTES,
  type ProviderLoginMethod,
  parseProviderAuthenticationStatus,
  parseProviderIdParam,
  parseProviderLoginMethod,
  parseSessionId,
  parseWireRequest,
  type SessionOpenResult,
  WIRE_PROTOCOL_VERSION,
} from "@axl/protocol";
import { AxlClientError, type TrustedProviderHost } from "@axl/sdk";
import { connectUnixClient } from "@axl/sdk/unix";
import { type WebSocket, WebSocketServer } from "ws";

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-src http: https:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

interface AssetMetadata {
  readonly webAssetVersion: 1;
  readonly packageVersion: string;
  readonly sourceRevision: string;
  readonly wireVersion: number;
  readonly entrypoints: readonly string[];
  readonly sha256: Readonly<Record<string, string>>;
}

export interface WebGatewayOptions {
  readonly socketPath: string;
  readonly assetDirectory: string;
  readonly stateDirectory: string;
  readonly cwd: string;
  readonly packageVersion: string;
  readonly providerHost?: TrustedProviderHost;
  readonly launchToken?: Buffer;
  readonly pathToken?: Buffer;
  /** Test seams may shorten, but never widen, the fixed 60-second attachment idle limit. */
  readonly webSocketIdleTimeoutMs?: number;
}

const WEB_PANE_IDS = ["browser", "files", "changes", "terminal"] as const;
type WebPaneId = (typeof WEB_PANE_IDS)[number];

export interface WebPreferences {
  readonly sidebarWidth: number;
  readonly dockWidth: number;
  readonly sidebarCollapsed: boolean;
  readonly changesView: "files" | "all";
  readonly panes: readonly WebPaneId[];
  readonly adoptionDismissedScanGeneration?: string | undefined;
}

const MAX_WEB_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_WORKSPACE_REVIEW_DIFFS = 100;

const DEFAULT_WEB_PREFERENCES: WebPreferences = {
  sidebarWidth: 264,
  dockWidth: 680,
  sidebarCollapsed: false,
  changesView: "files",
  panes: ["browser", "files"],
};

function isWorkspaceDiffRequest(text: string): boolean {
  try {
    return parseWireRequest(JSON.parse(text)).method === "session.workspace.diff";
  } catch {
    return false;
  }
}

function parsePaneIds(value: unknown): readonly WebPaneId[] {
  if (!Array.isArray(value) || value.length > WEB_PANE_IDS.length)
    throw new Error("Web preferences are invalid");
  const seen = new Set<WebPaneId>();
  for (const pane of value) {
    if (!(WEB_PANE_IDS as readonly unknown[]).includes(pane) || seen.has(pane as WebPaneId))
      throw new Error("Web preferences are invalid");
    seen.add(pane as WebPaneId);
  }
  return WEB_PANE_IDS.filter((pane) => seen.has(pane));
}

function parsePreferences(value: unknown): WebPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Web preferences must be an object");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        ![
          "sidebarWidth",
          "dockWidth",
          "sidebarCollapsed",
          "changesView",
          "panes",
          "adoptionDismissedScanGeneration",
        ].includes(key),
    ) ||
    !Number.isInteger(record.sidebarWidth) ||
    Number(record.sidebarWidth) < 200 ||
    Number(record.sidebarWidth) > 420 ||
    !Number.isInteger(record.dockWidth) ||
    Number(record.dockWidth) < 380 ||
    Number(record.dockWidth) > 1200 ||
    typeof record.sidebarCollapsed !== "boolean" ||
    (record.adoptionDismissedScanGeneration !== undefined &&
      (typeof record.adoptionDismissedScanGeneration !== "string" ||
        Buffer.byteLength(record.adoptionDismissedScanGeneration, "utf8") > 128)) ||
    (record.changesView !== "files" && record.changesView !== "all")
  )
    throw new Error("Web preferences are invalid");
  return {
    sidebarWidth: record.sidebarWidth as number,
    dockWidth: record.dockWidth as number,
    sidebarCollapsed: record.sidebarCollapsed,
    changesView: record.changesView,
    panes: parsePaneIds(record.panes),
    ...(record.adoptionDismissedScanGeneration === undefined
      ? {}
      : { adoptionDismissedScanGeneration: record.adoptionDismissedScanGeneration }),
  };
}

export interface WebGateway {
  readonly origin: string;
  readonly launchUrl: string;
  close(): Promise<void>;
}

interface WebSessionArtifact {
  readonly format: "axl.web-session";
  readonly version: 1;
  readonly files: Readonly<Record<string, string>>;
}

function decodeBase64(value: unknown, path: string): Buffer {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) {
    throw new Error(`${path} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`${path} is not canonical base64`);
  return bytes;
}

function artifactManifest(bytes: Buffer): { readonly blobDigests: readonly string[] } {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("Artifact manifest is invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Artifact manifest is invalid");
  }
  const manifest = value as Record<string, unknown>;
  const keys = [
    "format",
    "version",
    "sourceSessionId",
    "sourceSha256",
    "eventCount",
    "blobDigests",
  ];
  if (
    Object.keys(manifest).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(manifest, key)) ||
    manifest.format !== "axl.session" ||
    manifest.version !== 1 ||
    typeof manifest.sourceSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(manifest.sourceSha256) ||
    !Number.isSafeInteger(manifest.eventCount) ||
    (manifest.eventCount as number) < 1 ||
    !Array.isArray(manifest.blobDigests) ||
    manifest.blobDigests.length > 10_000 ||
    new Set(manifest.blobDigests).size !== manifest.blobDigests.length ||
    manifest.blobDigests.some(
      (digest) => typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest),
    )
  ) {
    throw new Error("Artifact manifest is invalid");
  }
  try {
    parseSessionId(manifest.sourceSessionId, "manifest.sourceSessionId");
  } catch {
    throw new Error("Artifact manifest is invalid");
  }
  return { blobDigests: manifest.blobDigests as string[] };
}

export async function encodeWebSessionArtifact(directory: string): Promise<Buffer> {
  const manifestPath = join(directory, "manifest.json");
  const manifestInfo = await stat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.size > 1024 * 1024) {
    throw new Error("Artifact manifest is invalid");
  }
  const manifest = await readFile(manifestPath);
  const { blobDigests } = artifactManifest(manifest);
  let encodedSize = 1024 + Math.ceil(manifestInfo.size / 3) * 4;
  const readBounded = async (path: string): Promise<string> => {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("Artifact contains a non-file entry");
    encodedSize += Math.ceil(info.size / 3) * 4 + path.length + 8;
    if (encodedSize > MAX_WEB_ARTIFACT_BYTES) {
      throw new Error("Session artifact exceeds the 64 MiB browser limit");
    }
    return (await readFile(path)).toString("base64");
  };
  const files: Record<string, string> = {
    "manifest.json": manifest.toString("base64"),
    "events.jsonl": await readBounded(join(directory, "events.jsonl")),
  };
  for (const digest of blobDigests) {
    files[`blobs/${digest}`] = await readBounded(join(directory, "blobs", digest));
  }
  const bytes = Buffer.from(JSON.stringify({ format: "axl.web-session", version: 1, files }));
  if (bytes.byteLength > MAX_WEB_ARTIFACT_BYTES)
    throw new Error("Session artifact exceeds the 64 MiB browser limit");
  return bytes;
}

export async function writeWebSessionArtifact(bytes: Buffer, directory: string): Promise<void> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_WEB_ARTIFACT_BYTES) {
    throw new Error("Session artifact must be between 1 byte and 64 MiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("Session artifact is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Session artifact is invalid");
  }
  const archive = value as Partial<WebSessionArtifact>;
  if (
    Object.keys(archive).some((key) => !["format", "version", "files"].includes(key)) ||
    Object.keys(archive).length !== 3 ||
    archive.format !== "axl.web-session" ||
    archive.version !== 1 ||
    typeof archive.files !== "object" ||
    archive.files === null ||
    Array.isArray(archive.files)
  ) {
    throw new Error("Session artifact is invalid");
  }
  const manifest = decodeBase64(archive.files["manifest.json"], "manifest.json");
  const { blobDigests } = artifactManifest(manifest);
  const expected = new Set([
    "manifest.json",
    "events.jsonl",
    ...blobDigests.map((digest) => `blobs/${digest}`),
  ]);
  if (
    Object.keys(archive.files).length !== expected.size ||
    Object.keys(archive.files).some((path) => !expected.has(path))
  ) {
    throw new Error("Session artifact contains unexpected files");
  }
  const events = decodeBase64(archive.files["events.jsonl"], "events.jsonl");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "manifest.json"), manifest, { mode: 0o600 });
  await writeFile(join(directory, "events.jsonl"), events, { mode: 0o600 });
  if (blobDigests.length > 0) await mkdir(join(directory, "blobs"), { mode: 0o700 });
  for (const digest of blobDigests) {
    await writeFile(
      join(directory, "blobs", digest),
      decodeBase64(archive.files[`blobs/${digest}`], `blobs/${digest}`),
      { mode: 0o600 },
    );
  }
}

async function requestBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.byteLength;
    if (size > maximumBytes) throw new RangeError("Request body is too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function providerLoginRequestId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new Error("Invalid provider login request");
  }
  return value;
}

function providerLoginRequest(bytes: Buffer): {
  readonly requestId: string;
  readonly providerId: string;
  readonly method: ProviderLoginMethod;
} {
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid provider login request");
  }
  const request = value as Record<string, unknown>;
  if (
    Object.keys(request).length !== 3 ||
    !Object.hasOwn(request, "requestId") ||
    !Object.hasOwn(request, "providerId") ||
    !Object.hasOwn(request, "method")
  ) {
    throw new Error("Invalid provider login request");
  }
  return {
    requestId: providerLoginRequestId(request.requestId),
    providerId: parseProviderIdParam(request.providerId, "providerId"),
    method: parseProviderLoginMethod(request.method, "method"),
  };
}

function providerLoginCancellation(bytes: Buffer): string {
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid provider login cancellation");
  }
  const request = value as Record<string, unknown>;
  if (Object.keys(request).length !== 1 || !Object.hasOwn(request, "requestId")) {
    throw new Error("Invalid provider login cancellation");
  }
  return providerLoginRequestId(request.requestId);
}

function projectFolderRequest(bytes: Buffer): string {
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid project folder request");
  const request = value as Record<string, unknown>;
  if (
    Object.keys(request).length !== 1 ||
    typeof request.path !== "string" ||
    request.path.length === 0 ||
    request.path.length > 4096 ||
    request.path.includes("\0")
  )
    throw new Error("Invalid project folder request");
  return request.path;
}

function send(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  type = "text/plain; charset=utf-8",
): void {
  response.writeHead(status, { ...SECURITY_HEADERS, "content-type": type });
  response.end(body);
}

function safeEqual(actual: string, expected: Buffer): boolean {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(actual, "base64url");
  } catch {
    return false;
  }
  return decoded.length === expected.length && timingSafeEqual(decoded, expected);
}

function cookie(request: IncomingMessage, name: string): string | undefined {
  for (const part of request.headers.cookie?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function mime(path: string): string {
  return (
    (
      {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
      } as Record<string, string>
    )[extname(path)] ?? "application/octet-stream"
  );
}

export async function verifyWebAssets(
  directory: string,
  packageVersion?: string,
): Promise<AssetMetadata> {
  const metadata = JSON.parse(
    await readFile(resolve(directory, "asset-metadata.json"), "utf8"),
  ) as Partial<AssetMetadata>;
  if (
    metadata.webAssetVersion !== 1 ||
    typeof metadata.packageVersion !== "string" ||
    typeof metadata.sourceRevision !== "string" ||
    (packageVersion !== undefined && metadata.packageVersion !== packageVersion) ||
    metadata.wireVersion !== WIRE_PROTOCOL_VERSION ||
    !Array.isArray(metadata.entrypoints) ||
    metadata.entrypoints.length === 0 ||
    typeof metadata.sha256 !== "object" ||
    metadata.sha256 === null
  )
    throw new Error("Web assets are missing or incompatible");
  for (const [file, expected] of Object.entries(metadata.sha256)) {
    if (
      !/^[a-zA-Z0-9_./-]+$/.test(file) ||
      file.startsWith("/") ||
      file.split("/").includes("..") ||
      !/^[0-9a-f]{64}$/.test(expected)
    )
      throw new Error("Web asset metadata is invalid");
    const actual = createHash("sha256")
      .update(await readFile(resolve(directory, file)))
      .digest("hex");
    if (actual !== expected) throw new Error(`Web asset hash mismatch: ${file}`);
  }
  for (const entrypoint of metadata.entrypoints)
    if (!(entrypoint in metadata.sha256))
      throw new Error(`Web entrypoint is not declared: ${entrypoint}`);
  return metadata as AssetMetadata;
}

export async function startWebGateway(options: WebGatewayOptions): Promise<WebGateway> {
  const metadata = await verifyWebAssets(options.assetDirectory, options.packageVersion);
  const launchToken = options.launchToken ?? randomBytes(32);
  const pathToken = options.pathToken ?? randomBytes(16);
  const browserCredential = randomBytes(32);
  const webSocketIdleTimeoutMs = Math.min(options.webSocketIdleTimeoutMs ?? 60_000, 60_000);
  if (!Number.isSafeInteger(webSocketIdleTimeoutMs) || webSocketIdleTimeoutMs < 1)
    throw new Error("WebSocket idle timeout must be a positive integer");
  const prefix = `/a/${pathToken.toString("base64url")}/`;
  const cookieName = "axl_web";
  let launchAvailable = true;
  const launchExpiresAt = Date.now() + 60_000;
  const credentialExpiresAt = Date.now() + 12 * 60 * 60 * 1_000;
  const preferencesPath = join(options.stateDirectory, "web-preferences.json");
  let preferences = await readFile(preferencesPath, "utf8").then(
    (text) => {
      try {
        return parsePreferences(JSON.parse(text));
      } catch (cause) {
        throw new Error(
          `Stored web preferences at ${preferencesPath} are invalid; delete the file to reset them`,
          { cause },
        );
      }
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return DEFAULT_WEB_PREFERENCES;
      throw error;
    },
  );
  let preferenceWrites = Promise.resolve();
  let providerLogin:
    | { readonly requestId: string; readonly controller: AbortController }
    | undefined;
  let expectedHost = "";
  let expectedOrigin = "";
  const sockets = new Set<Socket>();
  const webSockets = new Set<WebSocket>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WIRE_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  const withArtifactClient = async <Result>(
    operation: (client: Awaited<ReturnType<typeof connectUnixClient>>) => Promise<Result>,
  ): Promise<Result> => {
    const client = await connectUnixClient(options.socketPath, {
      identity: { kind: "web-host", version: options.packageVersion, instanceId: randomUUID() },
    });
    try {
      return await operation(client);
    } finally {
      client.close();
    }
  };

  const authorized = (request: IncomingMessage): boolean =>
    Date.now() < credentialExpiresAt &&
    cookie(request, cookieName) !== undefined &&
    safeEqual(cookie(request, cookieName) ?? "", browserCredential);
  const validOrigin = (request: IncomingMessage): boolean =>
    request.headers.host === expectedHost && request.headers.origin === expectedOrigin;
  const server = createServer(async (request, response) => {
    request.once("end", () => request.socket.setTimeout(0));
    response.once("finish", () => request.socket.setTimeout(5_000));
    let relative = "";
    try {
      if (
        request.headers.host !== expectedHost ||
        request.url === undefined ||
        !request.url.startsWith(prefix)
      )
        return send(response, 404, "Not found");
      relative = request.url.slice(prefix.length).split("?", 1)[0] ?? "";
      if (request.method === "POST" && relative === "auth/exchange") {
        if (!validOrigin(request) || !launchAvailable || Date.now() >= launchExpiresAt)
          return send(response, 401, "Authentication failed");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const value = Buffer.from(chunk);
          size += value.length;
          if (size > 4096) return send(response, 413, "Request too large");
          chunks.push(value);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { token?: unknown };
        if (typeof body.token !== "string" || !safeEqual(body.token, launchToken))
          return send(response, 401, "Authentication failed");
        launchAvailable = false;
        response.setHeader(
          "set-cookie",
          `${cookieName}=${browserCredential.toString("base64url")}; Path=${prefix}; HttpOnly; SameSite=Strict; Max-Age=43200`,
        );
        return send(response, 200, "{}", "application/json; charset=utf-8");
      }
      if (request.method === "POST" && relative === "bootstrap") {
        if (!validOrigin(request) || !authorized(request))
          return send(response, 401, "Authentication required");
        return send(
          response,
          200,
          JSON.stringify({
            cwd: options.cwd,
            webSocketPath: `${prefix}ws`,
            preferences,
            hostCapabilities: [
              "project.folder.validate",
              ...(options.providerHost === undefined ? [] : ["provider.auth.login"]),
            ],
          }),
          "application/json; charset=utf-8",
        );
      }
      if (request.method === "POST" && relative === "host/project-folder/validate") {
        if (!validOrigin(request) || !authorized(request))
          return send(response, 401, "Authentication required");
        const requested = projectFolderRequest(await requestBody(request, 8192));
        let canonical: string;
        try {
          canonical = await realpath(resolve(options.cwd, requested));
          if (!(await stat(canonical)).isDirectory()) {
            return send(
              response,
              200,
              JSON.stringify({ valid: false, error: "Choose a folder, not a file" }),
              "application/json; charset=utf-8",
            );
          }
        } catch {
          return send(
            response,
            200,
            JSON.stringify({
              valid: false,
              error: "Project folder does not exist or cannot be accessed",
            }),
            "application/json; charset=utf-8",
          );
        }
        return send(
          response,
          200,
          JSON.stringify({ valid: true, path: canonical }),
          "application/json; charset=utf-8",
        );
      }
      if (request.method === "POST" && relative === "host/provider/login/cancel") {
        if (!validOrigin(request) || !authorized(request))
          return send(response, 401, "Authentication required");
        if (options.providerHost === undefined)
          return send(response, 403, "Provider login is unavailable in this host");
        const cancellation = providerLoginCancellation(await requestBody(request, 4096));
        const activeLogin = providerLogin;
        const cancelled = activeLogin?.requestId === cancellation;
        if (cancelled) activeLogin?.controller.abort();
        return send(
          response,
          200,
          JSON.stringify({ cancelled }),
          "application/json; charset=utf-8",
        );
      }
      if (request.method === "POST" && relative === "host/provider/login") {
        if (!validOrigin(request) || !authorized(request))
          return send(response, 401, "Authentication required");
        if (options.providerHost === undefined)
          return send(response, 403, "Provider login is unavailable in this host");
        const login = providerLoginRequest(await requestBody(request, 4096));
        if (providerLogin !== undefined)
          return send(response, 409, "Another provider login is active");
        const controller = new AbortController();
        providerLogin = { requestId: login.requestId, controller };
        try {
          const result = parseProviderAuthenticationStatus(
            await options.providerHost.loginProvider(login, { signal: controller.signal }),
            "providerLogin",
          );
          if (controller.signal.aborted || response.destroyed) return;
          return send(response, 200, JSON.stringify(result), "application/json; charset=utf-8");
        } finally {
          if (providerLogin?.controller === controller) providerLogin = undefined;
        }
      }
      if (request.method === "POST" && relative === "artifact/export") {
        if (!validOrigin(request) || !authorized(request))
          return send(response, 401, "Authentication required");
        const body = JSON.parse((await requestBody(request, 4096)).toString("utf8")) as {
          sessionId?: unknown;
        };
        const sessionId = parseSessionId(body.sessionId, "sessionId");
        await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
        const temporary = await mkdtemp(join(options.stateDirectory, "web-export-"));
        try {
          const outputDirectory = join(temporary, "artifact");
          await withArtifactClient((client) =>
            client.request("session.export", { sessionId, outputDirectory }),
          );
          const artifact = await encodeWebSessionArtifact(outputDirectory);
          response.setHeader(
            "content-disposition",
            `attachment; filename="axl-session-${sessionId}.json"`,
          );
          return send(response, 200, artifact, "application/json");
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      }
      if (request.method === "POST" && relative === "artifact/import") {
        if (!validOrigin(request) || !authorized(request))
          return send(response, 401, "Authentication required");
        const artifact = await requestBody(request, MAX_WEB_ARTIFACT_BYTES);
        await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
        const temporary = await mkdtemp(join(options.stateDirectory, "web-import-"));
        try {
          const inputDirectory = join(temporary, "artifact");
          await writeWebSessionArtifact(artifact, inputDirectory);
          const imported: SessionOpenResult = await withArtifactClient((client) =>
            client.request("session.import", { inputDirectory, cwd: options.cwd }),
          );
          return send(response, 200, JSON.stringify(imported), "application/json; charset=utf-8");
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      }
      if (request.method === "POST" && relative === "preferences") {
        if (!validOrigin(request) || !authorized(request))
          return send(response, 401, "Authentication required");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const value = Buffer.from(chunk);
          size += value.length;
          if (size > 4096) return send(response, 413, "Request too large");
          chunks.push(value);
        }
        const next = parsePreferences(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        preferences = next;
        preferenceWrites = preferenceWrites.then(async () => {
          await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
          const temporary = `${preferencesPath}.${process.pid}.tmp`;
          await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
          await rename(temporary, preferencesPath);
        });
        await preferenceWrites;
        return send(response, 200, "{}", "application/json; charset=utf-8");
      }
      if (request.method !== "GET") return send(response, 405, "Method not allowed");
      const file = relative === "" ? "index.html" : relative;
      if (!(file in metadata.sha256)) return send(response, 404, "Not found");
      if (file.startsWith("/") || file.split("/").includes(".."))
        return send(response, 404, "Not found");
      const path = resolve(options.assetDirectory, file);
      if (
        !path.startsWith(`${resolve(options.assetDirectory)}${sep}`) &&
        path !== resolve(options.assetDirectory, "index.html")
      )
        return send(response, 404, "Not found");
      const data = await readFile(path).catch(() => undefined);
      if (data === undefined) return send(response, 404, "Not found");
      response.writeHead(200, { ...SECURITY_HEADERS, "content-type": mime(path) });
      response.end(data);
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof RangeError) return send(response, 413, error.message);
      if (relative === "host/provider/login")
        return send(response, 400, "Provider login failed. Check the trusted host terminal.");
      if (error instanceof AxlClientError) {
        const action = relative === "artifact/export" ? "export" : "import";
        return send(response, 400, `Session ${action} failed (${error.code})`);
      }
      if (error instanceof Error && /^(Session artifact|Artifact )/u.test(error.message)) {
        return send(response, 400, error.message);
      }
      send(response, 400, "Invalid request");
    }
  });

  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.on("connection", (socket) => {
    socket.setTimeout(5_000, () => socket.destroy());
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    (socket as Socket).setTimeout(0);
    if (
      request.url !== `${prefix}ws` ||
      !validOrigin(request) ||
      !authorized(request) ||
      webSockets.size >= 16
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) =>
      wss.emit("connection", webSocket, request),
    );
  });
  wss.on("connection", (webSocket) => {
    webSockets.add(webSocket);
    const daemon = createConnection(options.socketPath);
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    let messages = 0;
    let workspaceDiffs = 0;
    let burstTokens = 20;
    let lastMessageAt = performance.now();
    let windowStarted = performance.now();
    let pendingMessages = 0;
    let pendingBytes = 0;
    let idleTimer = setTimeout(
      () => webSocket.close(1008, "Heartbeat timeout"),
      webSocketIdleTimeoutMs,
    );
    const resetIdleTimer = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => webSocket.close(1008, "Heartbeat timeout"),
        webSocketIdleTimeoutMs,
      );
    };
    const close = (): void => {
      clearTimeout(idleTimer);
      webSockets.delete(webSocket);
      daemon.destroy();
      if (webSocket.readyState < 2) webSocket.close(1000, "Attachment closed");
    };
    webSocket.on("message", (data, binary) => {
      resetIdleTimer();
      const text = data.toString();
      if (binary || Buffer.byteLength(text) > MAX_WIRE_MESSAGE_BYTES)
        return webSocket.close(1009, "Text message limit exceeded");
      const now = performance.now();
      if (now - windowStarted > 10_000) {
        windowStarted = now;
        messages = 0;
        workspaceDiffs = 0;
      }
      if (isWorkspaceDiffRequest(text)) {
        if (++workspaceDiffs > MAX_WORKSPACE_REVIEW_DIFFS)
          return webSocket.close(1008, "Rate limit exceeded");
      } else {
        burstTokens = Math.min(20, burstTokens + ((now - lastMessageAt) * 10) / 1_000);
        lastMessageAt = now;
        if (++messages > 100 || burstTokens < 1)
          return webSocket.close(1008, "Rate limit exceeded");
        burstTokens -= 1;
      }
      daemon.write(text);
    });
    daemon.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > MAX_WIRE_MESSAGE_BYTES && !buffer.includes("\n"))
        return webSocket.close(1009, "Daemon message limit exceeded");
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const lineBytes = Buffer.byteLength(line);
        if (
          lineBytes > MAX_WIRE_MESSAGE_BYTES ||
          pendingMessages >= 1_024 ||
          pendingBytes + lineBytes > 4 * 1024 * 1024
        )
          return webSocket.close(1009, "Attachment is too slow");
        pendingMessages += 1;
        pendingBytes += lineBytes;
        webSocket.send(line, () => {
          pendingMessages -= 1;
          pendingBytes -= lineBytes;
        });
      }
    });
    daemon.once("error", () => webSocket.close(1011, "Daemon connection failed"));
    daemon.once("close", close);
    webSocket.once("close", close);
    webSocket.once("error", close);
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Web gateway did not bind a TCP port");
  expectedHost = `127.0.0.1:${address.port}`;
  expectedOrigin = `http://${expectedHost}`;
  return {
    origin: `${expectedOrigin}${prefix}`,
    launchUrl: `${expectedOrigin}${prefix}#token=${launchToken.toString("base64url")}`,
    close: () =>
      new Promise((resolvePromise, reject) => {
        providerLogin?.controller.abort();
        for (const ws of webSockets) ws.close(1001, "Gateway stopped");
        for (const socket of sockets) socket.destroy();
        wss.close();
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}
