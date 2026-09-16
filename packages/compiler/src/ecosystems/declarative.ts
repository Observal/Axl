// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { dirname, join } from "node:path";
import {
  decodeUtf8,
  mergeLimits,
  snapshotTree,
  type BoundedFileSystem,
  type SnapshotFile,
  type TreeSnapshot,
} from "../filesystem.ts";
import { parseFrontmatter, parseJsoncObject, parseJsonObject, stringRecord } from "../parsing.ts";
import type { AdapterResult, SourceAdapter } from "../source-adapter.ts";
import type {
  DiscoveryCandidate,
  DiscoveryContext,
  DiscoveryDiagnostic,
  Ecosystem,
  PackageInventory,
  ResourceKind,
  ResourceSurface,
  Scope,
} from "../types.ts";
import { createCandidate, diagnosticsForError, inventoryExtensionSource } from "./common.ts";

interface Convention {
  readonly directory: string;
  readonly kind: ResourceKind;
  readonly executable: boolean;
  readonly suffixes: readonly string[];
}

interface DeclarativeAdapterOptions {
  readonly ecosystem: Exclude<Ecosystem, "pi">;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly sourceSchemaVersion: string;
  readonly globalRoot: (home: string) => string;
  readonly projectRoot: (project: string) => string;
  readonly conventions: readonly Convention[];
  readonly manifestNames: readonly string[];
  readonly configNames: readonly string[];
}

function matchesConvention(path: string, convention: Convention): boolean {
  if (!path.startsWith(`${convention.directory}/`)) return false;
  const rest = path.slice(convention.directory.length + 1);
  if (rest === "") return false;
  return convention.suffixes.some((suffix) => rest.endsWith(suffix));
}

function surfaceFor(file: SnapshotFile, convention: Convention): ResourceSurface {
  const text = convention.executable || file.relativePath.endsWith(".md") ? decodeUtf8(file) : "";
  const inventory = convention.executable
    ? inventoryExtensionSource(text)
    : { registrations: [], dynamicBehavior: false, metadata: {} };
  let name =
    file.relativePath
      .split("/")
      .at(-1)
      ?.replace(/\.(?:md|ts|js|json)$/u, "") ?? file.relativePath;
  if (file.relativePath.endsWith(".md")) {
    const parsed = parseFrontmatter(
      text,
      new Set([
        "name",
        "description",
        "license",
        "tools",
        "model",
        "color",
        "argument-hint",
        "allowed-tools",
      ]),
    );
    if (typeof parsed.attributes.name === "string") name = parsed.attributes.name;
  }
  return {
    kind: convention.kind,
    name,
    relativePath: file.relativePath,
    primary: true,
    executable: convention.executable,
    registrations: inventory.registrations,
    dynamicBehavior: inventory.dynamicBehavior,
    metadata: inventory.metadata,
  };
}

function packageInventory(
  json: Record<string, unknown>,
  diagnostics: DiscoveryDiagnostic[],
  path: string,
): PackageInventory {
  const scripts = stringRecord(json.scripts, "scripts");
  const lifecycleScripts = [
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    "prepack",
    "postpack",
  ].filter((name) => scripts[name] !== undefined);
  for (const script of lifecycleScripts)
    diagnostics.push({
      code: "lifecycle-script",
      severity: "warning",
      message: `${script} is inventoried but never executed`,
      relativePath: path,
    });
  const packageName = typeof json.name === "string" ? json.name : undefined;
  const validPackageName =
    packageName === undefined ||
    (Buffer.byteLength(packageName, "utf8") <= 214 &&
      /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(packageName));
  if (!validPackageName) {
    diagnostics.push({
      code: "package-name-invalid",
      severity: "error",
      message: "package name is unsafe or malformed",
      relativePath: path,
    });
  }
  return {
    ...(packageName !== undefined && validPackageName ? { packageName } : {}),
    ...(typeof json.version === "string" ? { version: json.version } : {}),
    dependencies: Object.keys(stringRecord(json.dependencies, "dependencies")).sort(),
    peerDependencies: Object.keys(stringRecord(json.peerDependencies, "peerDependencies")).sort(),
    lifecycleScripts,
    gallery: {},
  };
}

function checkSchema(
  options: DeclarativeAdapterOptions,
  json: Record<string, unknown>,
  diagnostics: DiscoveryDiagnostic[],
  path: string,
): void {
  const possible = [
    json.schemaVersion,
    json.version,
    (json.plugin as Record<string, unknown> | undefined)?.version,
  ];
  const explicit = possible.find((value) => typeof value === "string");
  if (
    typeof explicit === "string" &&
    !["1", "1.0", "1.0.0", options.sourceSchemaVersion].includes(explicit)
  ) {
    diagnostics.push({
      code: "source-schema-unsupported",
      severity: "error",
      message: `unsupported ${options.ecosystem} schema version ${explicit}`,
      relativePath: path,
    });
  }
}

function discoverSnapshot(
  options: DeclarativeAdapterOptions,
  snapshot: TreeSnapshot,
  scope: Scope,
  context: DiscoveryContext,
  diagnostics: DiscoveryDiagnostic[],
): DiscoveryCandidate[] {
  const limits = mergeLimits(context.limits);
  const candidates: DiscoveryCandidate[] = [];
  const claimed = new Set<string>();

  for (const file of snapshot.files) {
    const convention = options.conventions.find((item) =>
      matchesConvention(file.relativePath, item),
    );
    if (convention === undefined) continue;
    claimed.add(file.relativePath);
    try {
      const surface = surfaceFor(file, convention);
      candidates.push(
        createCandidate(
          {
            ecosystem: options.ecosystem,
            scope,
            snapshot,
            adapterId: options.adapterId,
            adapterVersion: options.adapterVersion,
            sourceSchemaVersion: options.sourceSchemaVersion,
            kind: convention.kind,
            relativePath: file.relativePath,
            displayName: surface.name,
            executable: convention.executable,
            surfaces: [surface],
          },
          limits,
        ),
      );
    } catch (error) {
      diagnostics.push({
        code: "resource-invalid",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        relativePath: file.relativePath,
      });
    }
  }

  for (const file of snapshot.files) {
    const base = file.relativePath.split("/").at(-1) ?? "";
    if (!options.manifestNames.includes(base) && !options.configNames.includes(base)) continue;
    let json: Record<string, unknown>;
    try {
      json = file.relativePath.endsWith(".jsonc")
        ? parseJsoncObject(file, limits.maxManifestBytes)
        : parseJsonObject(file, limits.maxManifestBytes);
    } catch (error) {
      diagnostics.push({
        code: "manifest-invalid",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        relativePath: file.relativePath,
      });
      continue;
    }
    checkSchema(options, json, diagnostics, file.relativePath);
    if (options.configNames.includes(base)) {
      const serialized = JSON.stringify(json);
      if (/"(?:apiKey|token|secret|password|oauth)"\s*:/iu.test(serialized))
        diagnostics.push({
          code: "literal-credential",
          severity: "error",
          message: "configuration contains credential-like fields",
          relativePath: file.relativePath,
        });
      if (/![^"\s]+/u.test(serialized))
        diagnostics.push({
          code: "command-value",
          severity: "error",
          message: "configuration contains an executable command value",
          relativePath: file.relativePath,
        });
      const mcp = json.mcpServers ?? json.mcp;
      if (mcp !== null && typeof mcp === "object" && !Array.isArray(mcp)) {
        const names = Object.keys(mcp).sort();
        if (names.length > 0) {
          const surfaces = names.map(
            (name, index): ResourceSurface => ({
              kind: "mcp-server",
              name,
              relativePath: file.relativePath,
              primary: index === 0,
              executable: true,
              registrations: [],
              dynamicBehavior: false,
              metadata: {},
            }),
          );
          candidates.push(
            createCandidate(
              {
                ecosystem: options.ecosystem,
                scope,
                snapshot,
                adapterId: options.adapterId,
                adapterVersion: options.adapterVersion,
                sourceSchemaVersion: options.sourceSchemaVersion,
                kind: "mcp-server",
                relativePath: file.relativePath,
                displayName: base,
                executable: true,
                surfaces,
              },
              limits,
            ),
          );
        }
      }
      continue;
    }
    const packageDiagnostics: DiscoveryDiagnostic[] = [];
    let inventory: PackageInventory;
    try {
      inventory = packageInventory(json, packageDiagnostics, file.relativePath);
    } catch (error) {
      diagnostics.push({
        code: "manifest-invalid",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        relativePath: file.relativePath,
      });
      continue;
    }
    const manifestDirectory = dirname(file.relativePath) === "." ? "" : dirname(file.relativePath);
    const packageRoot =
      base === "plugin.json" && manifestDirectory.endsWith(".claude-plugin")
        ? dirname(manifestDirectory) === "."
          ? ""
          : dirname(manifestDirectory)
        : manifestDirectory;
    const packagePrefix = packageRoot === "" ? "" : `${packageRoot}/`;
    const surfaces = snapshot.files
      .filter((candidate) => candidate.relativePath.startsWith(packagePrefix))
      .flatMap((candidate) => {
        const localPath = candidate.relativePath.slice(packagePrefix.length);
        const convention = options.conventions.find((item) => matchesConvention(localPath, item));
        if (convention === undefined) return [];
        try {
          return [
            {
              ...surfaceFor(candidate, convention),
              relativePath: candidate.relativePath,
              primary: false,
            },
          ];
        } catch {
          return [];
        }
      });
    const primary = surfaces.findIndex((surface) => surface.executable);
    const primaryIndex = primary >= 0 ? primary : surfaces.length > 0 ? 0 : -1;
    if (primaryIndex >= 0)
      surfaces[primaryIndex] = { ...(surfaces[primaryIndex] as ResourceSurface), primary: true };
    else
      surfaces.push({
        kind: "package",
        name: inventory.packageName ?? (packageRoot || options.ecosystem),
        relativePath: file.relativePath,
        primary: true,
        executable: false,
        registrations: [],
        dynamicBehavior: false,
        metadata: {},
      });
    candidates.push(
      createCandidate(
        {
          ecosystem: options.ecosystem,
          scope,
          snapshot,
          adapterId: options.adapterId,
          adapterVersion: options.adapterVersion,
          sourceSchemaVersion: options.sourceSchemaVersion,
          kind: "package",
          relativePath: file.relativePath,
          displayName: inventory.packageName ?? (packageRoot || options.ecosystem),
          executable: surfaces.some((surface) => surface.executable),
          ...(inventory.packageName === undefined
            ? {}
            : { packageIdentity: inventory.packageName }),
          sourcePrefix: packageRoot,
          surfaces,
          inventory,
          diagnostics: packageDiagnostics,
        },
        limits,
      ),
    );
  }
  return candidates;
}

function makeAdapter(options: DeclarativeAdapterOptions): SourceAdapter {
  const inspectRoot = async (
    root: string,
    scope: Scope,
    context: DiscoveryContext,
    fileSystem: BoundedFileSystem,
  ): Promise<AdapterResult> => {
    try {
      const snapshot = await snapshotTree(root, fileSystem, mergeLimits(context.limits));
      const diagnostics = [...snapshot.diagnostics];
      return {
        candidates: discoverSnapshot(options, snapshot, scope, context, diagnostics),
        diagnostics,
      };
    } catch (error) {
      return { candidates: [], diagnostics: [diagnosticsForError(error, root)] };
    }
  };
  return {
    ecosystem: options.ecosystem,
    adapterId: options.adapterId,
    adapterVersion: options.adapterVersion,
    sourceSchemaVersions: [options.sourceSchemaVersion],
    async discover(context, fileSystem) {
      const roots: { root: string; scope: Scope }[] = [
        { root: options.globalRoot(context.homeDirectory), scope: "global" },
      ];
      if (context.projectDirectory !== undefined) {
        if (!context.projectTrusted)
          return {
            candidates: [],
            diagnostics: [
              {
                code: "project-untrusted",
                severity: "error",
                message: `${options.ecosystem} project resources require Axl project trust`,
              },
            ],
          };
        roots.push({ root: options.projectRoot(context.projectDirectory), scope: "project" });
      }
      const results = await Promise.all(
        roots.map((entry) => inspectRoot(entry.root, entry.scope, context, fileSystem)),
      );
      return {
        candidates: results.flatMap((result) => result.candidates),
        diagnostics: results.flatMap((result) => result.diagnostics),
      };
    },
  };
}

export const openCodeAdapter = makeAdapter({
  ecosystem: "opencode",
  adapterId: "axl.opencode.discovery",
  adapterVersion: "1.0.0",
  sourceSchemaVersion: "opencode-v1",
  globalRoot: (home) => join(home, ".config", "opencode"),
  projectRoot: (project) => join(project, ".opencode"),
  conventions: [
    { directory: "tools", kind: "extension", executable: true, suffixes: [".ts", ".js"] },
    { directory: "tool", kind: "extension", executable: true, suffixes: [".ts", ".js"] },
    { directory: "plugins", kind: "extension", executable: true, suffixes: [".ts", ".js"] },
    { directory: "commands", kind: "prompt", executable: false, suffixes: [".md"] },
    { directory: "agents", kind: "agent", executable: false, suffixes: [".md"] },
    { directory: "skills", kind: "skill", executable: false, suffixes: ["SKILL.md", ".md"] },
  ],
  manifestNames: ["package.json"],
  configNames: ["opencode.json", "opencode.jsonc"],
});

export const dshAdapter = makeAdapter({
  ecosystem: "dsh",
  adapterId: "axl.dsh.discovery",
  adapterVersion: "1.0.0",
  sourceSchemaVersion: "dsh-v1",
  globalRoot: (home) => join(home, ".dsh"),
  projectRoot: (project) => join(project, ".dsh"),
  conventions: [
    { directory: "tools", kind: "extension", executable: true, suffixes: [".ts", ".js"] },
    { directory: "extensions", kind: "extension", executable: true, suffixes: [".ts", ".js"] },
    { directory: "skills", kind: "skill", executable: false, suffixes: ["SKILL.md", ".md"] },
    { directory: "prompts", kind: "prompt", executable: false, suffixes: [".md"] },
    { directory: "workflows", kind: "workflow", executable: false, suffixes: [".json", ".md"] },
  ],
  manifestNames: ["package.json"],
  configNames: ["dsh.json"],
});

export const claudeCodeAdapter = makeAdapter({
  ecosystem: "claude-code",
  adapterId: "axl.claude-code.discovery",
  adapterVersion: "1.0.0",
  sourceSchemaVersion: "claude-plugin-v1",
  globalRoot: (home) => join(home, ".claude"),
  projectRoot: (project) => join(project, ".claude"),
  conventions: [
    { directory: "plugins", kind: "extension", executable: true, suffixes: [".js", ".ts"] },
    { directory: "commands", kind: "prompt", executable: false, suffixes: [".md"] },
    { directory: "agents", kind: "agent", executable: false, suffixes: [".md"] },
    { directory: "skills", kind: "skill", executable: false, suffixes: ["SKILL.md", ".md"] },
    { directory: "hooks", kind: "hook", executable: true, suffixes: [".json", ".js", ".ts"] },
  ],
  manifestNames: ["package.json", "plugin.json"],
  configNames: ["settings.json", ".mcp.json"],
});
