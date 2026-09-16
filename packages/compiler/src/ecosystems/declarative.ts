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
  readonly globalRoot: (context: DiscoveryContext) => string;
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
    installationKind: "local",
    dependencies: Object.keys(stringRecord(json.dependencies, "dependencies")).sort(),
    peerDependencies: Object.keys(stringRecord(json.peerDependencies, "peerDependencies")).sort(),
    lifecycleScripts,
    gallery: {},
  };
}

interface CordisConfig {
  readonly pluginNames: readonly string[];
  readonly diagnostics: readonly DiscoveryDiagnostic[];
}

function stripYamlComment(line: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (quote !== undefined) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "#") return line.slice(0, index);
  }
  return line;
}

function splitYamlMapping(
  line: string,
): { indent: number; sequence: boolean; key: string; scalar: string } | undefined {
  const indent = /^ */u.exec(line)?.[0].length ?? 0;
  let content = line.slice(indent);
  const sequence = content.startsWith("- ");
  if (sequence) content = content.slice(2);
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? "";
    if (quote !== undefined) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === ":" && /\s|^$/u.test(content[index + 1] ?? "")) {
      const rawKey = content.slice(0, index).trim();
      const key =
        (rawKey.startsWith('"') && rawKey.endsWith('"')) ||
        (rawKey.startsWith("'") && rawKey.endsWith("'"))
          ? rawKey.slice(1, -1)
          : rawKey;
      return { indent, sequence, key, scalar: content.slice(index + 1).trim() };
    }
  }
  return undefined;
}

function parseCordisConfig(file: SnapshotFile, maximumBytes: number): CordisConfig {
  if (file.bytes.byteLength > maximumBytes) {
    throw new Error("Cordis manifest exceeds byte limit");
  }
  const text = decodeUtf8(file);
  if (/\t/u.test(text)) throw new Error("Cordis YAML tabs are unsupported");
  if (/(?:^|[\s:])[!&*](?![\s])/mu.test(text) || /<<\s*:|\$\{|\{\{/u.test(text)) {
    throw new Error("Cordis YAML tags, anchors, aliases, merges, and expressions are unsupported");
  }
  const pluginNames: string[] = [];
  const sequenceEntries: { indent: number; id?: string; name?: string }[] = [];
  const sequenceStack: { indent: number; id?: string; name?: string }[] = [];
  let pluginsIndent: number | undefined;
  let directPluginIndent: number | undefined;
  let version: string | undefined;
  const lines = text.split(/\r?\n/u);
  if (lines.length > 10_000) throw new Error("Cordis YAML line limit exceeded");
  for (const rawLine of lines) {
    const line = stripYamlComment(rawLine).trimEnd();
    if (line.trim() === "" || line.trim() === "---") continue;
    const hasFlowCollection = ["[", "]", "{", "}"].some((character) => line.includes(character));
    if (/^\s*[%]/u.test(line) || /:\s*[|>]\s*$/u.test(line) || hasFlowCollection) {
      throw new Error(
        "Cordis YAML directives, block scalars, and flow collections are unsupported",
      );
    }
    const mapping = splitYamlMapping(line);
    if (mapping === undefined) throw new Error("Cordis YAML must use bounded mapping syntax");
    const { indent, sequence, key, scalar } = mapping;
    if (indent > 64 || indent % 2 !== 0) throw new Error("Cordis YAML indentation is unsupported");
    if (Buffer.byteLength(key, "utf8") > 256 || Buffer.byteLength(scalar, "utf8") > 4_096)
      throw new Error("Cordis YAML key or scalar exceeds limit");
    const scalarValue = scalar.replace(/^['"]|['"]$/gu, "");
    while ((sequenceStack.at(-1)?.indent ?? -1) >= indent) sequenceStack.pop();
    if (sequence) {
      const entry: { indent: number; id?: string; name?: string } = { indent };
      if (key === "id" && scalarValue !== "") entry.id = scalarValue;
      if (key === "name" && scalarValue !== "") entry.name = scalarValue;
      sequenceEntries.push(entry);
      sequenceStack.push(entry);
    } else {
      const entry = sequenceStack.at(-1);
      if (entry !== undefined && indent > entry.indent) {
        if (key === "id" && scalarValue !== "") entry.id = scalarValue;
        if (key === "name" && scalarValue !== "") entry.name = scalarValue;
      }
    }
    if (indent === 0 && !sequence && key === "version" && scalar !== "") version = scalarValue;
    if (indent === 0 && key === "plugins") {
      pluginsIndent = indent;
      directPluginIndent = undefined;
      continue;
    }
    if (pluginsIndent !== undefined) {
      if (indent <= pluginsIndent) {
        pluginsIndent = undefined;
        directPluginIndent = undefined;
      } else {
        directPluginIndent ??= indent;
        if (!sequence && indent === directPluginIndent) pluginNames.push(key);
      }
    }
  }
  const diagnostics: DiscoveryDiagnostic[] = [];
  if (version !== undefined && !["1", "1.0", "1.0.0"].includes(version)) {
    diagnostics.push({
      code: "source-schema-unsupported",
      severity: "error",
      message: `unsupported Cordis configuration version ${version}`,
      relativePath: file.relativePath,
    });
  }
  for (const entry of sequenceEntries) {
    const name = entry.name ?? entry.id;
    if (name !== undefined && name !== "") {
      if (Buffer.byteLength(name, "utf8") > 256) {
        throw new Error("Cordis plugin name exceeds limit");
      }
      pluginNames.push(name);
    }
  }
  return { pluginNames: [...new Set(pluginNames)].sort(), diagnostics };
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

function diagnostic(code: string, error: unknown, relativePath: string): DiscoveryDiagnostic {
  return {
    code,
    severity: "error",
    message: error instanceof Error ? error.message : String(error),
    relativePath,
  };
}

function malformedCandidate(
  options: DeclarativeAdapterOptions,
  snapshot: TreeSnapshot,
  scope: Scope,
  file: SnapshotFile,
  kind: ResourceKind,
  executable: boolean,
  issue: DiscoveryDiagnostic,
  limits: ReturnType<typeof mergeLimits>,
): DiscoveryCandidate {
  return createCandidate(
    {
      ecosystem: options.ecosystem,
      scope,
      snapshot,
      adapterId: options.adapterId,
      adapterVersion: options.adapterVersion,
      sourceSchemaVersion: options.sourceSchemaVersion,
      kind,
      relativePath: file.relativePath,
      executable,
      diagnostics: [issue],
      surfaces: [
        {
          kind,
          name: file.relativePath.split("/").at(-1) ?? file.relativePath,
          relativePath: file.relativePath,
          primary: true,
          executable,
          registrations: [],
          dynamicBehavior: executable,
          metadata: {},
        },
      ],
    },
    limits,
  );
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
      const issue = diagnostic("resource-invalid", error, file.relativePath);
      diagnostics.push(issue);
      candidates.push(
        malformedCandidate(
          options,
          snapshot,
          scope,
          file,
          convention.kind,
          convention.executable,
          issue,
          limits,
        ),
      );
    }
  }

  for (const file of snapshot.files) {
    const base = file.relativePath.split("/").at(-1) ?? "";
    if (!options.manifestNames.includes(base) && !options.configNames.includes(base)) continue;
    if (options.ecosystem === "dsh" && (base === "cordis.yml" || base === "cordis.yaml")) {
      try {
        const cordis = parseCordisConfig(file, limits.maxManifestBytes);
        diagnostics.push(...cordis.diagnostics);
        const surfaces: ResourceSurface[] =
          cordis.pluginNames.length === 0
            ? [
                {
                  kind: "package",
                  name: base,
                  relativePath: file.relativePath,
                  primary: true,
                  executable: false,
                  registrations: [],
                  dynamicBehavior: false,
                  metadata: { format: "cordis-yaml" },
                },
              ]
            : cordis.pluginNames.map((name, index) => ({
                kind: "extension",
                name,
                relativePath: file.relativePath,
                primary: index === 0,
                executable: true,
                registrations: [`cordis-plugin:${name}`],
                dynamicBehavior: false,
                metadata: { format: "cordis-yaml" },
              }));
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
              displayName: base,
              executable: surfaces.some((surface) => surface.executable),
              surfaces,
              diagnostics: cordis.diagnostics,
            },
            limits,
          ),
        );
      } catch (error) {
        const issue = diagnostic("cordis-config-invalid", error, file.relativePath);
        diagnostics.push(issue);
        candidates.push(
          malformedCandidate(options, snapshot, scope, file, "package", true, issue, limits),
        );
      }
      continue;
    }
    let json: Record<string, unknown>;
    try {
      json = file.relativePath.endsWith(".jsonc")
        ? parseJsoncObject(file, limits.maxManifestBytes)
        : parseJsonObject(file, limits.maxManifestBytes);
    } catch (error) {
      const issue = diagnostic("manifest-invalid", error, file.relativePath);
      diagnostics.push(issue);
      candidates.push(
        malformedCandidate(options, snapshot, scope, file, "package", true, issue, limits),
      );
      continue;
    }
    const fileDiagnostics: DiscoveryDiagnostic[] = [];
    checkSchema(options, json, fileDiagnostics, file.relativePath);
    if (options.configNames.includes(base)) {
      const serialized = JSON.stringify(json);
      if (/"(?:apiKey|token|secret|password|oauth)"\s*:/iu.test(serialized))
        fileDiagnostics.push({
          code: "literal-credential",
          severity: "error",
          message: "configuration contains credential-like fields",
          relativePath: file.relativePath,
        });
      if (/![^"\s]+/u.test(serialized))
        fileDiagnostics.push({
          code: "command-value",
          severity: "error",
          message: "configuration contains an executable command value",
          relativePath: file.relativePath,
        });
      diagnostics.push(...fileDiagnostics);
      const mcp = json.mcpServers ?? json.mcp;
      const names =
        mcp !== null && typeof mcp === "object" && !Array.isArray(mcp)
          ? Object.keys(mcp).sort()
          : [];
      const executable =
        names.length > 0 || fileDiagnostics.some((entry) => entry.code === "command-value");
      const kind: ResourceKind = names.length > 0 ? "mcp-server" : "package";
      const surfaces: ResourceSurface[] =
        names.length > 0
          ? names.map((name, index) => ({
              kind: "mcp-server",
              name,
              relativePath: file.relativePath,
              primary: index === 0,
              executable: true,
              registrations: [],
              dynamicBehavior: false,
              metadata: {},
            }))
          : [
              {
                kind,
                name: base,
                relativePath: file.relativePath,
                primary: true,
                executable,
                registrations: [],
                dynamicBehavior: executable,
                metadata: {},
              },
            ];
      candidates.push(
        createCandidate(
          {
            ecosystem: options.ecosystem,
            scope,
            snapshot,
            adapterId: options.adapterId,
            adapterVersion: options.adapterVersion,
            sourceSchemaVersion: options.sourceSchemaVersion,
            kind,
            relativePath: file.relativePath,
            displayName: base,
            executable,
            surfaces,
            diagnostics: fileDiagnostics,
          },
          limits,
        ),
      );
      continue;
    }
    const packageDiagnostics: DiscoveryDiagnostic[] = [...fileDiagnostics];
    let inventory: PackageInventory;
    try {
      inventory = packageInventory(json, packageDiagnostics, file.relativePath);
    } catch (error) {
      const issue = diagnostic("manifest-invalid", error, file.relativePath);
      diagnostics.push(issue);
      candidates.push(
        malformedCandidate(options, snapshot, scope, file, "package", true, issue, limits),
      );
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
        } catch (error) {
          packageDiagnostics.push(diagnostic("resource-invalid", error, candidate.relativePath));
          return [
            {
              kind: convention.kind,
              name: candidate.relativePath.split("/").at(-1) ?? candidate.relativePath,
              relativePath: candidate.relativePath,
              primary: false,
              executable: convention.executable,
              registrations: [],
              dynamicBehavior: convention.executable,
              metadata: {},
            },
          ];
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
    diagnostics.push(...packageDiagnostics);
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

const excludedStateByEcosystem: Readonly<Record<Exclude<Ecosystem, "pi">, ReadonlySet<string>>> = {
  opencode: new Set([
    "auth.json",
    "credentials.json",
    "cache",
    "logs",
    "sessions",
    "storage",
    "telemetry",
  ]),
  dsh: new Set([
    "auth.json",
    "credentials.json",
    "cache",
    "history.jsonl",
    "logs",
    "sessions",
    "telemetry",
  ]),
  "claude-code": new Set([
    ".credentials.json",
    "auth.json",
    "credentials.json",
    "cache",
    "debug",
    "history.jsonl",
    "logs",
    "projects",
    "sessions",
    "shell-snapshots",
    "statsig",
    "telemetry",
    "todos",
  ]),
};

function shouldExcludeState(
  ecosystem: Exclude<Ecosystem, "pi">,
  scope: Scope,
  relativePath: string,
): boolean {
  if (scope !== "global") return false;
  const first = relativePath.split("/")[0]?.toLowerCase() ?? "";
  return excludedStateByEcosystem[ecosystem].has(first);
}

function makeAdapter(options: DeclarativeAdapterOptions): SourceAdapter {
  const inspectRoot = async (
    root: string,
    scope: Scope,
    context: DiscoveryContext,
    fileSystem: BoundedFileSystem,
  ): Promise<AdapterResult> => {
    try {
      const snapshot = await snapshotTree(root, fileSystem, mergeLimits(context.limits), {
        exclude(relativePath) {
          return shouldExcludeState(options.ecosystem, scope, relativePath);
        },
      });
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
        { root: options.globalRoot(context), scope: "global" },
      ];
      const policyDiagnostics: DiscoveryDiagnostic[] = [];
      if (context.projectDirectory !== undefined) {
        if (!context.projectTrusted) {
          policyDiagnostics.push({
            code: "adoption_project_untrusted",
            severity: "error",
            message: `${options.ecosystem} project resources require Axl project trust`,
          });
        } else {
          roots.push({ root: options.projectRoot(context.projectDirectory), scope: "project" });
        }
      }
      const results = await Promise.all(
        roots.map((entry) => inspectRoot(entry.root, entry.scope, context, fileSystem)),
      );
      return {
        candidates: results.flatMap((result) => result.candidates),
        diagnostics: [...policyDiagnostics, ...results.flatMap((result) => result.diagnostics)],
      };
    },
  };
}

export const openCodeAdapter = makeAdapter({
  ecosystem: "opencode",
  adapterId: "axl.opencode.discovery",
  adapterVersion: "1.0.0",
  sourceSchemaVersion: "opencode-v1",
  globalRoot: (context) => join(context.homeDirectory, ".config", "opencode"),
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
  sourceSchemaVersion: "cordis-v1",
  globalRoot: (context) => context.environment?.DSH_HOME || join(context.homeDirectory, ".dsh"),
  projectRoot: (project) => join(project, ".dsh"),
  conventions: [
    { directory: "tools", kind: "extension", executable: true, suffixes: [".ts", ".js"] },
    { directory: "extensions", kind: "extension", executable: true, suffixes: [".ts", ".js"] },
    { directory: "skills", kind: "skill", executable: false, suffixes: ["SKILL.md", ".md"] },
    { directory: "prompts", kind: "prompt", executable: false, suffixes: [".md"] },
    { directory: "workflows", kind: "workflow", executable: false, suffixes: [".json", ".md"] },
  ],
  manifestNames: ["package.json"],
  configNames: ["cordis.yml", "cordis.yaml"],
});

export const claudeCodeAdapter = makeAdapter({
  ecosystem: "claude-code",
  adapterId: "axl.claude-code.discovery",
  adapterVersion: "1.0.0",
  sourceSchemaVersion: "claude-plugin-v1",
  globalRoot: (context) => join(context.homeDirectory, ".claude"),
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
