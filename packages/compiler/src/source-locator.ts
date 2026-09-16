// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export type SourceLocator =
  | {
      readonly kind: "local";
      readonly canonicalPath: string;
      readonly origin: "discovered" | "explicit";
    }
  | {
      readonly kind: "npm";
      readonly registryOrigin: string;
      readonly packageName: string;
      readonly requested: string;
    }
  | { readonly kind: "git"; readonly repositoryUri: string; readonly requestedRef: string };

export type ImmutableSourceLock =
  | {
      readonly kind: "local-snapshot";
      readonly treeSha256: string;
      readonly fileCount: number;
      readonly sizeBytes: number;
    }
  | {
      readonly kind: "npm";
      readonly registryOrigin: string;
      readonly packageName: string;
      readonly version: string;
      readonly integrity: string;
      readonly tarballSha256: string;
    }
  | {
      readonly kind: "git";
      readonly repositoryUri: string;
      readonly commit: string;
      readonly treeSha256: string;
    };

export type ForeignHarness = "opencode" | "dsh" | "claude-code" | "pi";

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
const EXACT_VERSION =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SHA512_SRI = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHELL_SYNTAX = /[\0\r\n;&|`$<>]/u;

function bounded(value: string, name: string, maximum = 512): string {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > maximum || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${name} is empty, contains controls, or exceeds ${maximum} bytes`);
  }
  return value.normalize("NFC");
}

export function normalizeRegistryOrigin(value = "https://registry.npmjs.org"): string {
  const url = new URL(bounded(value, "registry origin", 2_048));
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new TypeError("registry origin must be a credential-free HTTPS origin");
  }
  return url.origin;
}

export function normalizeGitRepositoryUri(value: string): string {
  const candidate = bounded(value, "repository URI", 2_048);
  if (/^(?:git|ssh|ftp|file|ext)::?/iu.test(candidate) || /^[^/\s]+@[^:]+:/u.test(candidate)) {
    throw new TypeError("only credential-free HTTPS Git repositories are supported");
  }
  const url = new URL(candidate);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "Git repository must be a credential-free HTTPS URI without query or fragment",
    );
  }
  url.hostname = url.hostname.toLowerCase();
  url.protocol = "https:";
  if (url.port === "443") url.port = "";
  return url.toString();
}

function parseNpmSpecifier(value: string, registryOrigin?: string): SourceLocator {
  const specifier = value.startsWith("npm:") ? value.slice(4) : value;
  const splitAt = specifier.startsWith("@")
    ? specifier.indexOf("@", specifier.indexOf("/") + 1)
    : specifier.lastIndexOf("@");
  const packageName = splitAt > 0 ? specifier.slice(0, splitAt) : specifier;
  const requested = splitAt > 0 ? specifier.slice(splitAt + 1) : "latest";
  if (!PACKAGE_NAME.test(packageName) || requested.length === 0)
    throw new TypeError("invalid npm package specifier");
  return {
    kind: "npm",
    registryOrigin: normalizeRegistryOrigin(registryOrigin),
    packageName,
    requested: bounded(requested, "npm selector"),
  };
}

export async function localSourceLocator(
  path: string,
  origin: "discovered" | "explicit",
): Promise<SourceLocator> {
  const input = bounded(path, "local path", 4_096);
  if (origin === "explicit" && !isAbsolute(input))
    throw new TypeError("explicit local source path must be absolute");
  return { kind: "local", canonicalPath: await realpath(resolve(input)), origin };
}

export function npmSourceLocator(
  packageName: string,
  requested: string,
  registryOrigin?: string,
): SourceLocator {
  return parseNpmSpecifier(`${packageName}@${requested}`, registryOrigin);
}

export function gitSourceLocator(repositoryUri: string, requestedRef: string): SourceLocator {
  return {
    kind: "git",
    repositoryUri: normalizeGitRepositoryUri(repositoryUri),
    requestedRef: bounded(requestedRef, "Git ref"),
  };
}

export function resolvedNpmLock(input: {
  readonly registryOrigin: string;
  readonly packageName: string;
  readonly version: string;
  readonly integrity: string;
  readonly tarballSha256: string;
}): ImmutableSourceLock {
  if (!PACKAGE_NAME.test(input.packageName)) throw new TypeError("invalid npm package name");
  if (!EXACT_VERSION.test(input.version)) throw new TypeError("npm lock version must be exact");
  if (!SHA512_SRI.test(input.integrity)) throw new TypeError("npm lock requires SHA-512 SRI");
  if (!SHA256.test(input.tarballSha256)) throw new TypeError("invalid tarball SHA-256");
  return { ...input, registryOrigin: normalizeRegistryOrigin(input.registryOrigin), kind: "npm" };
}

export function resolvedGitLock(
  repositoryUri: string,
  commit: string,
  treeSha256: string,
): ImmutableSourceLock {
  if (!COMMIT.test(commit)) throw new TypeError("Git lock requires a full commit object ID");
  if (!SHA256.test(treeSha256)) throw new TypeError("invalid Git tree snapshot SHA-256");
  return {
    kind: "git",
    repositoryUri: normalizeGitRepositoryUri(repositoryUri),
    commit,
    treeSha256,
  };
}

function grammarFor(harness: ForeignHarness): readonly string[] {
  switch (harness) {
    case "opencode":
    case "pi":
      return [harness, "install"];
    case "dsh":
      return ["dsh", "install"];
    case "claude-code":
      return ["claude", "plugin", "install"];
  }
}

/** Parses already-tokenized foreign passthrough input. It never starts a process. */
export async function parseForeignInstall(
  harness: ForeignHarness,
  argv: readonly string[],
  options: { readonly registryOrigin?: string } = {},
): Promise<SourceLocator> {
  const prefix = grammarFor(harness);
  if (argv.length !== prefix.length + 1 || !prefix.every((part, index) => argv[index] === part)) {
    throw new TypeError(`unsupported ${harness} install grammar`);
  }
  const source = bounded(argv[prefix.length] ?? "", "source", 4_096);
  if (source.startsWith("-") || SHELL_SYNTAX.test(source))
    throw new TypeError("flags and shell syntax are not supported");
  if (source.startsWith("git+")) {
    const separator = source.lastIndexOf("#");
    if (separator < 5) throw new TypeError("Git source requires an explicit ref");
    return gitSourceLocator(source.slice(4, separator), source.slice(separator + 1));
  }
  if (source.startsWith("https://")) {
    const separator = source.lastIndexOf("#");
    if (separator < 8) throw new TypeError("Git source requires an explicit ref");
    return gitSourceLocator(source.slice(0, separator), source.slice(separator + 1));
  }
  if (source.startsWith("file:")) return localSourceLocator(source.slice(5), "explicit");
  if (isAbsolute(source)) return localSourceLocator(source, "explicit");
  return parseNpmSpecifier(source, options.registryOrigin);
}
