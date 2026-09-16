// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  type AdoptionEcosystem,
  type AdoptionManifest,
  type AdoptionOperationId,
  type AdoptionRevisionId,
  type AdoptionScope,
  parseAdoptionEcosystem,
  parseAdoptionId,
  parseAdoptionManifest,
  parseAdoptionOperationId,
  parseAdoptionOperationState,
  parseAdoptionRevisionId,
  parseAdoptionScope,
} from "@axl/protocol";

const STORE_VERSION = 1 as const;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const ARTIFACT_KINDS = [
  "source",
  "converted",
  "tests/upstream",
  "tests/generated",
  "overlays",
  "verification",
  "provenance",
] as const;

export type AdoptionArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type AdoptionStoreFailpoint =
  | "before-file-fsync"
  | "after-file-fsync"
  | "before-directory-fsync"
  | "after-directory-fsync"
  | "before-rename"
  | "after-rename";

export class AdoptionStoreError extends Error {
  readonly code: "corrupt" | "conflict" | "io" | "locked" | "immutable";

  constructor(code: AdoptionStoreError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdoptionStoreError";
    this.code = code;
  }
}

export interface AdoptionArtifact {
  readonly kind: AdoptionArtifactKind;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly executable?: boolean;
}

export interface PublishRevisionInput {
  readonly manifest: AdoptionManifest;
  readonly artifacts: readonly AdoptionArtifact[];
}

export interface PublishedRevision {
  readonly directory: string;
  readonly treeSha256: string;
  readonly manifest: AdoptionManifest;
}

export interface AdoptionOperationRecord {
  readonly version: typeof STORE_VERSION;
  readonly operationId: AdoptionOperationId;
  readonly state: ReturnType<typeof parseAdoptionOperationState>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revisionId?: AdoptionRevisionId;
}

export interface AdoptionRegistryEntry {
  readonly adoptionId: ReturnType<typeof parseAdoptionId>;
  readonly scope: AdoptionScope;
  readonly packageKey: string;
  readonly activeRevisionId: AdoptionRevisionId | null;
}

export interface AdoptionRegistry {
  readonly version: typeof STORE_VERSION;
  readonly generation: number;
  readonly entries: readonly AdoptionRegistryEntry[];
}

interface RevisionIndexFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly executable: boolean;
}

interface RevisionIndex {
  readonly version: typeof STORE_VERSION;
  readonly revisionId: AdoptionRevisionId;
  readonly treeSha256: string;
  readonly files: readonly RevisionIndexFile[];
}

export interface AdoptionStoreOptions {
  readonly fail?: (point: AdoptionStoreFailpoint) => void | Promise<void>;
  readonly lockAttempts?: number;
  readonly lockRetryMs?: number;
}

function fail(code: AdoptionStoreError["code"], message: string, cause?: unknown): never {
  throw new AdoptionStoreError(code, message, cause === undefined ? undefined : { cause });
}

function exactObject(
  value: unknown,
  name: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("corrupt", `${name} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!keys.includes(key)) fail("corrupt", `${name}.${key} is not allowed`);
  return record;
}

function boundedString(value: unknown, name: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximum)
    fail("corrupt", `${name} must be a bounded string`);
  return value;
}

function timestamp(value: unknown, name: string): string {
  const parsed = boundedString(value, name, 64);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(parsed) || Number.isNaN(Date.parse(parsed)))
    fail("corrupt", `${name} must be an ISO timestamp`);
  return parsed;
}

function canonicalRelativePath(value: string): string {
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    fail("corrupt", "artifact path must be canonical and relative");
  if (Buffer.byteLength(value, "utf8") > 4_096) fail("corrupt", "artifact path exceeds the limit");
  return value.normalize("NFC");
}

function within(path: string, root: string): boolean {
  const value = relative(root, path);
  return (
    value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.startsWith("/"))
  );
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function parseJson(bytes: Uint8Array, name: string): unknown {
  if (bytes.byteLength > MAX_JSON_BYTES) fail("corrupt", `${name} exceeds the JSON byte limit`);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    fail("corrupt", `${name} is not valid JSON`, error);
  }
}

export function encodeAdoptionPackageId(packageId: string): string {
  boundedString(packageId, "packageId", 512);
  const encoded = Buffer.from(packageId.normalize("NFC"), "utf8").toString("base64url");
  return `${encoded}--${sha256(packageId.normalize("NFC")).slice(0, 12)}`;
}

export function decodeAdoptionPackageId(encoded: string): string {
  if (!/^[A-Za-z0-9_-]+--[0-9a-f]{12}$/.test(encoded))
    fail("corrupt", "encoded package ID is invalid");
  const separator = encoded.lastIndexOf("--");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(encoded.slice(0, separator), "base64url"),
    );
  } catch (error) {
    fail("corrupt", "encoded package ID is not UTF-8", error);
  }
  if (encodeAdoptionPackageId(decoded) !== encoded)
    fail("corrupt", "encoded package ID hash does not match");
  return decoded;
}

function parseOperation(value: unknown): AdoptionOperationRecord {
  const input = exactObject(value, "operation", [
    "version",
    "operationId",
    "state",
    "createdAt",
    "updatedAt",
    "revisionId",
  ]);
  if (input.version !== STORE_VERSION) fail("corrupt", "operation.version is unsupported");
  const revisionId =
    input.revisionId === undefined
      ? undefined
      : parseAdoptionRevisionId(input.revisionId, "operation.revisionId");
  return Object.freeze({
    version: STORE_VERSION,
    operationId: parseAdoptionOperationId(input.operationId, "operation.operationId"),
    state: parseAdoptionOperationState(input.state, "operation.state"),
    createdAt: timestamp(input.createdAt, "operation.createdAt"),
    updatedAt: timestamp(input.updatedAt, "operation.updatedAt"),
    ...(revisionId === undefined ? {} : { revisionId }),
  });
}

function parseRegistry(value: unknown): AdoptionRegistry {
  const input = exactObject(value, "registry", ["version", "generation", "entries"]);
  if (
    input.version !== STORE_VERSION ||
    !Number.isSafeInteger(input.generation) ||
    (input.generation as number) < 0 ||
    !Array.isArray(input.entries) ||
    input.entries.length > 100_000
  )
    fail("corrupt", "registry header is invalid");
  const entries = input.entries.map((value, index) => {
    const entry = exactObject(value, `registry.entries[${index}]`, [
      "adoptionId",
      "scope",
      "packageKey",
      "activeRevisionId",
    ]);
    return Object.freeze({
      adoptionId: parseAdoptionId(entry.adoptionId, `registry.entries[${index}].adoptionId`),
      scope: parseAdoptionScope(entry.scope, `registry.entries[${index}].scope`),
      packageKey: boundedString(entry.packageKey, `registry.entries[${index}].packageKey`, 1_024),
      activeRevisionId:
        entry.activeRevisionId === null
          ? null
          : parseAdoptionRevisionId(
              entry.activeRevisionId,
              `registry.entries[${index}].activeRevisionId`,
            ),
    });
  });
  const keys = entries.map((entry) => `${entry.scope}:${entry.packageKey}`);
  if (new Set(keys).size !== keys.length)
    fail("corrupt", "registry contains duplicate package pointers");
  return Object.freeze({
    version: STORE_VERSION,
    generation: input.generation as number,
    entries: Object.freeze(entries),
  });
}

function parseRevisionIndex(value: unknown, expectedRevisionId: AdoptionRevisionId): RevisionIndex {
  const input = exactObject(value, "revision", ["version", "revisionId", "treeSha256", "files"]);
  if (
    input.version !== STORE_VERSION ||
    input.revisionId !== expectedRevisionId ||
    typeof input.treeSha256 !== "string" ||
    !SHA256.test(input.treeSha256) ||
    !Array.isArray(input.files) ||
    input.files.length > 100_000
  )
    fail("corrupt", "revision index header is invalid");
  const files = input.files.map((value, index) => {
    const file = exactObject(value, `revision.files[${index}]`, [
      "path",
      "sha256",
      "sizeBytes",
      "executable",
    ]);
    const path = canonicalRelativePath(boundedString(file.path, `revision.files[${index}].path`));
    if (
      typeof file.sha256 !== "string" ||
      !SHA256.test(file.sha256) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      (file.sizeBytes as number) < 0 ||
      typeof file.executable !== "boolean"
    )
      fail("corrupt", `revision.files[${index}] is invalid`);
    return Object.freeze({
      path,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes as number,
      executable: file.executable,
    });
  });
  if (new Set(files.map((file) => file.path)).size !== files.length)
    fail("corrupt", "revision index contains duplicate paths");
  return Object.freeze({
    version: STORE_VERSION,
    revisionId: expectedRevisionId,
    treeSha256: input.treeSha256,
    files: Object.freeze(files),
  });
}

async function syncDirectory(
  path: string,
  failpoint: (point: AdoptionStoreFailpoint) => Promise<void>,
): Promise<void> {
  await failpoint("before-directory-fsync");
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await failpoint("after-directory-fsync");
}

export class AdoptionStore {
  readonly root: string;
  readonly #options: AdoptionStoreOptions;
  #inProcessLock: Promise<void> = Promise.resolve();

  constructor(root: string, options: AdoptionStoreOptions = {}) {
    this.root = resolve(root);
    this.#options = options;
  }

  async #fail(point: AdoptionStoreFailpoint): Promise<void> {
    await this.#options.fail?.(point);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await realpath(this.root)) !== this.root)
      fail("corrupt", "adoption store root must not be a symbolic link");
    await chmod(this.root, 0o700);
    await mkdir(join(this.root, "operations"), { recursive: true, mode: 0o700 });
    await this.#assertDirectory(join(this.root, "operations"));
    await this.#reconcile(this.root, 0);
    try {
      await this.readRegistry();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#atomicJson(
        join(this.root, "registry.json"),
        { version: STORE_VERSION, generation: 0, entries: [] },
        true,
      );
    }
  }

  async #reconcile(directory: string, depth: number): Promise<void> {
    if (depth > 8) fail("corrupt", "adoption store nesting exceeds the limit");
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      fail("io", "cannot inspect adoption store", error);
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("corrupt", "adoption store contains a symbolic link");
      if (entry.name.startsWith(".staging-")) {
        await this.#removeTree(path);
        continue;
      }
      if (entry.isDirectory() && entry.name !== "registry.lock")
        await this.#reconcile(path, depth + 1);
    }
  }

  operationDirectory(operationId: AdoptionOperationId): string {
    return join(this.root, "operations", operationId);
  }

  revisionDirectory(
    ecosystem: AdoptionEcosystem,
    packageId: string,
    revisionId: AdoptionRevisionId,
  ): string {
    return join(this.root, ecosystem, encodeAdoptionPackageId(packageId), revisionId);
  }

  async publishOperation(recordValue: AdoptionOperationRecord): Promise<string> {
    const record = parseOperation(recordValue);
    const directory = this.operationDirectory(record.operationId);
    const staging = join(
      this.root,
      "operations",
      `.staging-${record.operationId}-${randomBytes(6).toString("hex")}`,
    );
    await mkdir(staging, { mode: 0o700 });
    try {
      await this.#atomicJson(join(staging, "operation.json"), record, false);
      await syncDirectory(staging, (point) => this.#fail(point));
      await this.#makeReadOnly(staging);
      await this.#syncTree(staging);
      await this.#fail("before-rename");
      await rename(staging, directory);
      await this.#fail("after-rename");
      await syncDirectory(dirname(directory), (point) => this.#fail(point));
      return directory;
    } catch (error) {
      await this.#removeTree(staging);
      if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        fail("immutable", "operation already exists", error);
      throw error;
    }
  }

  async readOperation(operationId: AdoptionOperationId): Promise<AdoptionOperationRecord> {
    return parseOperation(
      parseJson(
        await readFile(join(this.operationDirectory(operationId), "operation.json")),
        "operation.json",
      ),
    );
  }

  async publishRevision(input: PublishRevisionInput): Promise<PublishedRevision> {
    const manifest = parseAdoptionManifest(input.manifest);
    const finalDirectory = this.revisionDirectory(
      manifest.ecosystem,
      manifest.packageId,
      manifest.revisionId,
    );
    const packageDirectory = dirname(finalDirectory);
    await mkdir(packageDirectory, { recursive: true, mode: 0o700 });
    await this.#assertDirectory(packageDirectory);
    const staging = join(
      packageDirectory,
      `.staging-${manifest.revisionId}-${randomBytes(6).toString("hex")}`,
    );
    await mkdir(staging, { mode: 0o700 });
    try {
      const paths = new Set<string>();
      const indexFiles: RevisionIndexFile[] = [];
      for (const artifact of [...input.artifacts].sort((left, right) =>
        `${left.kind}/${left.path}`.localeCompare(`${right.kind}/${right.path}`),
      )) {
        if (!ARTIFACT_KINDS.includes(artifact.kind)) fail("corrupt", "artifact kind is invalid");
        const relativePath = `${artifact.kind}/${canonicalRelativePath(artifact.path)}`;
        if (paths.has(relativePath)) fail("conflict", `duplicate artifact ${relativePath}`);
        paths.add(relativePath);
        const path = resolve(staging, relativePath);
        if (!within(path, staging)) fail("corrupt", "artifact escapes staging root");
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await this.#writeDurable(
          path,
          artifact.bytes,
          artifact.executable === true ? 0o700 : 0o600,
        );
        indexFiles.push(
          Object.freeze({
            path: relativePath,
            sha256: sha256(artifact.bytes),
            sizeBytes: artifact.bytes.byteLength,
            executable: artifact.executable === true,
          }),
        );
      }
      const adoptionBytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
      await this.#writeDurable(join(staging, "adoption.json"), adoptionBytes, 0o600);
      indexFiles.push({
        path: "adoption.json",
        sha256: sha256(adoptionBytes),
        sizeBytes: adoptionBytes.byteLength,
        executable: false,
      });
      this.#verifyManifestFiles(manifest, indexFiles);
      indexFiles.sort((left, right) => left.path.localeCompare(right.path));
      const treeSha256 = sha256(canonicalJson(indexFiles));
      const index: RevisionIndex = {
        version: STORE_VERSION,
        revisionId: manifest.revisionId,
        treeSha256,
        files: indexFiles,
      };
      await this.#atomicJson(join(staging, "revision.json"), index, false);
      await this.#syncTree(staging);
      await this.#makeReadOnly(staging);
      await this.#syncTree(staging);
      await this.#fail("before-rename");
      try {
        await rename(staging, finalDirectory);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
        await this.#removeTree(staging);
        const existing = await this.readRevision(
          manifest.ecosystem,
          manifest.packageId,
          manifest.revisionId,
        );
        if (existing.treeSha256 !== treeSha256)
          fail("conflict", "revision ID already identifies different immutable content");
        return existing;
      }
      await this.#fail("after-rename");
      await syncDirectory(packageDirectory, (point) => this.#fail(point));
      return await this.readRevision(manifest.ecosystem, manifest.packageId, manifest.revisionId);
    } catch (error) {
      await this.#removeTree(staging);
      throw error;
    }
  }

  async #assertDirectory(path: string): Promise<void> {
    const value = await lstat(path);
    if (!value.isDirectory() || value.isSymbolicLink() || (await realpath(path)) !== path)
      fail("corrupt", "adoption store path is not a canonical directory");
  }

  async #removeTree(path: string): Promise<void> {
    try {
      await this.#makeWritable(path);
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async #makeWritable(path: string): Promise<void> {
    let value: Stats;
    try {
      value = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (value.isSymbolicLink()) fail("corrupt", "staging cleanup encountered a symbolic link");
    if (value.isDirectory()) {
      await chmod(path, 0o700);
      for (const entry of await readdir(path)) await this.#makeWritable(join(path, entry));
    } else if (value.isFile()) await chmod(path, 0o600);
    else fail("corrupt", "staging cleanup encountered a special file");
  }

  #verifyManifestFiles(manifest: AdoptionManifest, files: readonly RevisionIndexFile[]): void {
    const actual = new Map(files.map((file) => [file.path, file]));
    for (const [prefix, declared] of [
      ["source", manifest.sourceFiles],
      ["converted", manifest.generatedFiles],
    ] as const) {
      for (const file of declared) {
        const actualFile = actual.get(`${prefix}/${file.path}`);
        if (
          actualFile === undefined ||
          actualFile.sha256 !== file.sha256 ||
          actualFile.sizeBytes !== file.sizeBytes ||
          actualFile.executable !== file.executable
        )
          fail("corrupt", `manifest file ${prefix}/${file.path} does not match staged bytes`);
      }
      const declaredPaths = new Set(declared.map((file) => `${prefix}/${file.path}`));
      for (const file of files)
        if (file.path.startsWith(`${prefix}/`) && !declaredPaths.has(file.path))
          fail("corrupt", `staged file ${file.path} is absent from adoption.json`);
    }
  }

  async readRevision(
    ecosystemValue: AdoptionEcosystem,
    packageId: string,
    revisionIdValue: AdoptionRevisionId,
  ): Promise<PublishedRevision> {
    const ecosystem = parseAdoptionEcosystem(ecosystemValue);
    const revisionId = parseAdoptionRevisionId(revisionIdValue);
    const directory = this.revisionDirectory(ecosystem, packageId, revisionId);
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
      fail("corrupt", "revision is not a regular directory");
    const index = parseRevisionIndex(
      parseJson(await readFile(join(directory, "revision.json")), "revision.json"),
      revisionId,
    );
    const indexedPaths = new Set(index.files.map((file) => file.path));
    const presentPaths = await this.#listRevisionFiles(directory);
    if (
      presentPaths.length !== indexedPaths.size ||
      presentPaths.some((path) => !indexedPaths.has(path))
    )
      fail("corrupt", "revision contains unindexed files");
    const actualFiles: RevisionIndexFile[] = [];
    for (const expected of index.files) {
      const path = resolve(directory, expected.path);
      if (!within(path, directory)) fail("corrupt", "revision file escapes its root");
      const before = await lstat(path);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size !== expected.sizeBytes ||
        (before.mode & 0o111) !== (expected.executable ? 0o100 : 0)
      )
        fail("corrupt", `revision file ${expected.path} metadata is invalid`);
      const bytes = await readFile(path);
      const after = await lstat(path);
      if (!sameStat(before, after) || sha256(bytes) !== expected.sha256)
        fail("corrupt", `revision file ${expected.path} failed integrity verification`);
      actualFiles.push(expected);
    }
    if (sha256(canonicalJson(actualFiles)) !== index.treeSha256)
      fail("corrupt", "revision tree hash does not match");
    const manifest = parseAdoptionManifest(
      parseJson(await readFile(join(directory, "adoption.json")), "adoption.json"),
    );
    if (
      manifest.revisionId !== revisionId ||
      manifest.ecosystem !== ecosystem ||
      manifest.packageId !== packageId
    )
      fail("corrupt", "revision path does not match adoption.json identity");
    this.#verifyManifestFiles(manifest, actualFiles);
    return Object.freeze({ directory, treeSha256: index.treeSha256, manifest });
  }

  async readRegistry(): Promise<AdoptionRegistry> {
    return parseRegistry(
      parseJson(await readFile(join(this.root, "registry.json")), "registry.json"),
    );
  }

  async updateRegistry(
    expectedGeneration: number,
    entries: readonly AdoptionRegistryEntry[],
  ): Promise<AdoptionRegistry> {
    return this.#withRegistryLock(async () => {
      const current = await this.readRegistry();
      if (current.generation !== expectedGeneration)
        fail("conflict", "registry generation changed");
      const next = parseRegistry({
        version: STORE_VERSION,
        generation: current.generation + 1,
        entries,
      });
      await this.#atomicJson(join(this.root, "registry.json"), next, true);
      return next;
    });
  }

  async #withRegistryLock<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.#inProcessLock;
    let release!: () => void;
    this.#inProcessLock = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    let handle: FileHandle | undefined;
    const path = join(this.root, "registry.lock");
    try {
      const attempts = this.#options.lockAttempts ?? 100;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          handle = await open(
            path,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
          );
          await handle.writeFile(
            `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          );
          await handle.sync();
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await this.#removeStaleLock(path);
          if (attempt + 1 === attempts) fail("locked", "registry lock is held");
          await new Promise((resolvePromise) =>
            setTimeout(resolvePromise, this.#options.lockRetryMs ?? 10),
          );
        }
      }
      if (handle === undefined) fail("locked", "registry lock is held");
      return await callback();
    } finally {
      await handle?.close();
      if (handle !== undefined) {
        await unlink(path).catch(() => undefined);
        await syncDirectory(this.root, (point) => this.#fail(point));
      }
      release();
    }
  }

  async #removeStaleLock(path: string): Promise<void> {
    try {
      const parsed = parseJson(await readFile(path), "registry.lock") as { pid?: unknown };
      if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0)
        fail("corrupt", "registry lock is malformed");
      try {
        process.kill(parsed.pid as number, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          await unlink(path);
          return;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  async #writeDurable(path: string, bytes: Uint8Array, mode: number): Promise<void> {
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      mode,
    );
    try {
      await handle.writeFile(bytes);
      await this.#fail("before-file-fsync");
      await handle.sync();
      await this.#fail("after-file-fsync");
    } finally {
      await handle.close();
    }
  }

  async #atomicJson(path: string, value: unknown, replace: boolean): Promise<void> {
    const temporary = join(
      dirname(path),
      `.staging-${basename(path)}-${randomBytes(6).toString("hex")}`,
    );
    await this.#writeDurable(temporary, Buffer.from(`${canonicalJson(value)}\n`, "utf8"), 0o600);
    try {
      if (!replace) {
        try {
          await lstat(path);
          fail("immutable", `${basename(path)} already exists`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await this.#fail("before-rename");
      await rename(temporary, path);
      await this.#fail("after-rename");
      await syncDirectory(dirname(path), (point) => this.#fail(point));
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async #listRevisionFiles(root: string): Promise<readonly string[]> {
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) fail("corrupt", "revision contains a symbolic link");
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) {
          const relativePath = relative(root, path).split(sep).join("/");
          if (relativePath !== "revision.json") files.push(relativePath);
        } else fail("corrupt", "revision contains a special file");
      }
    };
    await visit(root);
    return files.sort();
  }

  async #syncTree(root: string): Promise<void> {
    const directories: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      directories.push(directory);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) fail("corrupt", "staging tree contains a symlink");
        if (entry.isDirectory()) await visit(path);
      }
    };
    await visit(root);
    for (const directory of directories.reverse())
      await syncDirectory(directory, (point) => this.#fail(point));
  }

  async #makeReadOnly(root: string): Promise<void> {
    const directories: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      directories.push(directory);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) {
          const value = await stat(path);
          await chmod(path, value.mode & 0o100 ? 0o500 : 0o400);
        } else fail("corrupt", "staging tree contains a special file");
      }
    };
    await visit(root);
    for (const directory of directories.reverse()) await chmod(directory, 0o500);
  }
}

function sameStat(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}
