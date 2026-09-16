// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { dirname, join, parse } from "node:path";
import type { BoundedFileSystem, SnapshotFile, TreeSnapshot } from "../filesystem.ts";
import { decodeUtf8, mergeLimits, snapshotTree } from "../filesystem.ts";
import {
  expandPatterns,
  parseFrontmatter,
  parseJsonObject,
  stringArray,
  stringRecord,
} from "../parsing.ts";
import type { SourceAdapter, AdapterResult } from "../source-adapter.ts";
import type {
  DiscoveryCandidate,
  DiscoveryContext,
  DiscoveryDiagnostic,
  PackageInventory,
  ResourceKind,
  ResourceSurface,
  Scope,
} from "../types.ts";
import {
  conventionalFiles,
  createCandidate,
  diagnosticsForError,
  fileMap,
  inventoryExtensionSource,
} from "./common.ts";

const ADAPTER_ID = "axl.pi.discovery";
const ADAPTER_VERSION = "1.0.0";
const SOURCE_SCHEMA_VERSION = "pi-package-v1";
const extensionSuffixes = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const skillFields = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
  "disable-model-invocation",
]);

interface PiManifest {
  readonly extensions: readonly string[];
  readonly skills: readonly string[];
  readonly prompts: readonly string[];
  readonly themes: readonly string[];
  readonly dynamicDiscovery: boolean;
}

function packageInstallationKind(relativePath: string): PackageInventory["installationKind"] {
  const segments = relativePath.split("/");
  if (segments.includes("node_modules") || segments[0] === "npm") return "npm";
  if (segments[0] === "git" || segments.includes("repos")) return "git";
  return "local";
}

function parsePiManifest(
  file: SnapshotFile,
  maximumBytes: number,
): { manifest: PiManifest; inventory: PackageInventory; diagnostics: DiscoveryDiagnostic[] } {
  const json = parseJsonObject(file, maximumBytes);
  const allowedTop = new Set([
    "name",
    "version",
    "description",
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
    "scripts",
    "pi",
    "gallery",
    "keywords",
    "license",
    "author",
    "repository",
    "type",
    "main",
    "exports",
    "files",
    "engines",
    "devDependencies",
  ]);
  const diagnostics: DiscoveryDiagnostic[] = [];
  for (const key of Object.keys(json)) {
    if (!allowedTop.has(key))
      diagnostics.push({
        code: "package-field-unrecognized",
        severity: "info",
        message: `unrecognized package field ${key}`,
        relativePath: file.relativePath,
      });
  }
  const pi = json.pi;
  if (pi !== undefined && (pi === null || Array.isArray(pi) || typeof pi !== "object"))
    throw new Error("package pi field must be an object");
  const piObject = (pi ?? {}) as Record<string, unknown>;
  const allowedPi = new Set([
    "schemaVersion",
    "extensions",
    "skills",
    "prompts",
    "themes",
    "resources_discover",
  ]);
  for (const key of Object.keys(piObject)) {
    if (!allowedPi.has(key))
      diagnostics.push({
        code: "pi-field-unrecognized",
        severity: "warning",
        message: `unrecognized pi field ${key}`,
        relativePath: file.relativePath,
      });
  }
  if (
    typeof piObject.schemaVersion === "string" &&
    !["1", "1.0", "1.0.0", SOURCE_SCHEMA_VERSION].includes(piObject.schemaVersion)
  ) {
    diagnostics.push({
      code: "source-schema-unsupported",
      severity: "error",
      message: `unsupported Pi schema version ${piObject.schemaVersion}`,
      relativePath: file.relativePath,
    });
  }
  const scripts = stringRecord(json.scripts, "scripts");
  const lifecycle = [
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    "prepack",
    "postpack",
  ].filter((name) => scripts[name] !== undefined);
  for (const name of lifecycle)
    diagnostics.push({
      code: "lifecycle-script",
      severity: "warning",
      message: `${name} is inventoried but will never execute`,
      relativePath: file.relativePath,
    });
  const galleryValue = json.gallery;
  const gallery =
    galleryValue !== null && typeof galleryValue === "object" && !Array.isArray(galleryValue)
      ? Object.fromEntries(
          Object.entries(galleryValue).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  const dependencies = stringRecord(json.dependencies, "dependencies");
  const peers = stringRecord(json.peerDependencies, "peerDependencies");
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
      relativePath: file.relativePath,
    });
  }
  return {
    manifest: {
      extensions: stringArray(piObject.extensions, "pi.extensions"),
      skills: stringArray(piObject.skills, "pi.skills"),
      prompts: stringArray(piObject.prompts, "pi.prompts"),
      themes: stringArray(piObject.themes, "pi.themes"),
      dynamicDiscovery: piObject.resources_discover !== undefined,
    },
    inventory: {
      ...(packageName !== undefined && validPackageName ? { packageName } : {}),
      ...(typeof json.version === "string" ? { version: json.version } : {}),
      installationKind: packageInstallationKind(file.relativePath),
      dependencies: Object.keys(dependencies).sort(),
      peerDependencies: Object.keys(peers).sort(),
      lifecycleScripts: lifecycle,
      gallery,
    },
    diagnostics,
  };
}

function settingsFilters(
  snapshot: TreeSnapshot,
  diagnostics: DiscoveryDiagnostic[],
  maximumBytes: number,
): { adds: string[]; removes: Set<string> } {
  const settings = fileMap(snapshot).get("settings.json");
  if (settings === undefined) return { adds: [], removes: new Set() };
  let json: Record<string, unknown>;
  try {
    json = parseJsonObject(settings, maximumBytes);
  } catch (error) {
    diagnostics.push({
      code: "settings-invalid",
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
      relativePath: settings.relativePath,
    });
    return { adds: [], removes: new Set() };
  }
  const adds: string[] = [];
  const removes = new Set<string>();
  for (const field of ["extensions", "skills", "prompts", "themes", "packages"] as const) {
    const value = json[field];
    if (value === undefined) continue;
    let declarations: readonly string[];
    try {
      declarations = stringArray(value, `settings.${field}`);
    } catch (error) {
      diagnostics.push({
        code: "settings-field-invalid",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        relativePath: settings.relativePath,
      });
      continue;
    }
    for (const declaration of declarations) {
      const path =
        declaration.startsWith("+") || declaration.startsWith("-")
          ? declaration.slice(1)
          : declaration;
      if (
        path === "" ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").some((part) => part === "" || part === "." || part === "..")
      ) {
        diagnostics.push({
          code: "settings-path-invalid",
          severity: "error",
          message: "settings resource path is unsafe",
          relativePath: settings.relativePath,
        });
        continue;
      }
      if (declaration.startsWith("+")) adds.push(path);
      else if (declaration.startsWith("-")) removes.add(path);
      else if (field === "packages") adds.push(path);
    }
  }
  const serialized = JSON.stringify(json);
  if (/"(?:apiKey|token|secret|password|oauth)"\s*:/iu.test(serialized))
    diagnostics.push({
      code: "literal-credential",
      severity: "error",
      message: "settings contain credential-like fields",
      relativePath: settings.relativePath,
    });
  if (/![^"\s]+/u.test(serialized))
    diagnostics.push({
      code: "command-value",
      severity: "error",
      message: "settings contain a !command value",
      relativePath: settings.relativePath,
    });
  return { adds, removes };
}

function resourceKind(directory: string): ResourceKind {
  if (directory === "extensions") return "extension";
  if (directory === "skills") return "skill";
  if (directory === "prompts") return "prompt";
  return "theme";
}

function resourceErrorCode(kind: ResourceKind): string {
  if (kind === "skill") return "skill-frontmatter-invalid";
  if (kind === "prompt") return "prompt-invalid";
  if (kind === "extension") return "extension-source-invalid";
  if (kind === "theme") return "theme-invalid";
  return "pi-resource-invalid";
}

function parseSkill(
  file: SnapshotFile,
  snapshot: TreeSnapshot,
): {
  name: string;
  diagnostics: DiscoveryDiagnostic[];
  executable: boolean;
  metadata: Record<string, string | boolean>;
} {
  const diagnostics: DiscoveryDiagnostic[] = [];
  const text = decodeUtf8(file);
  const standardSkill = file.relativePath.endsWith("/SKILL.md");
  if (standardSkill && !text.startsWith("---\n")) {
    diagnostics.push({
      code: "skill-frontmatter-required",
      severity: "error",
      message: "SKILL.md requires YAML frontmatter",
      relativePath: file.relativePath,
    });
  }
  const parsed = parseFrontmatter(text, skillFields);
  for (const field of parsed.unknownFields)
    diagnostics.push({
      code: "skill-unknown-field",
      severity: "warning",
      message: `unknown skill field ${field}`,
      relativePath: file.relativePath,
    });
  const directoryName = standardSkill
    ? (dirname(file.relativePath).split("/").at(-1) ?? "")
    : (file.relativePath.replace(/\.md$/u, "").split("/").at(-1) ?? "");
  const declaredName = parsed.attributes.name;
  const declared = typeof declaredName === "string" ? declaredName : directoryName;
  if (standardSkill && (typeof declaredName !== "string" || declaredName.trim() === "")) {
    diagnostics.push({
      code: "skill-name-required",
      severity: "error",
      message: "standard Agent Skill frontmatter requires a nonempty name",
      relativePath: file.relativePath,
    });
  }
  const description = parsed.attributes.description;
  if (standardSkill && (typeof description !== "string" || description.trim() === "")) {
    diagnostics.push({
      code: "skill-description-required",
      severity: "error",
      message: "standard Agent Skill frontmatter requires a nonempty description",
      relativePath: file.relativePath,
    });
  } else if (typeof description === "string" && Buffer.byteLength(description, "utf8") > 1_024) {
    diagnostics.push({
      code: "skill-description-too-long",
      severity: "error",
      message: "skill description exceeds 1024 UTF-8 bytes",
      relativePath: file.relativePath,
    });
  }
  if (Buffer.byteLength(declared, "utf8") > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(declared))
    diagnostics.push({
      code: "skill-invalid-name",
      severity: "error",
      message: "skill name is not standard-compatible",
      relativePath: file.relativePath,
    });
  if (declared !== directoryName)
    diagnostics.push({
      code: "skill-name-mismatch",
      severity: "error",
      message: "skill name differs from its directory",
      relativePath: file.relativePath,
    });
  if (!standardSkill)
    diagnostics.push({
      code: "skill-flat-markdown",
      severity: "warning",
      message: "flat Markdown skill is Pi-lenient",
      relativePath: file.relativePath,
    });
  if (parsed.attributes["disable-model-invocation"] !== undefined)
    diagnostics.push({
      code: "skill-pi-disable-model-invocation",
      severity: "warning",
      message: "disable-model-invocation is Pi-specific metadata",
      relativePath: file.relativePath,
    });
  const parent = dirname(file.relativePath);
  const helpers = snapshot.files.filter(
    (candidate) =>
      candidate.relativePath.startsWith(`${parent}/`) &&
      candidate.relativePath !== file.relativePath &&
      /\.(?:js|mjs|cjs|ts|py|sh)$/u.test(candidate.relativePath),
  );
  if (helpers.length > 0)
    diagnostics.push({
      code: "skill-executable-helper",
      severity: "warning",
      message: "skill contains executable helper files",
      relativePath: file.relativePath,
    });
  return {
    name: declared,
    diagnostics,
    executable: helpers.length > 0,
    metadata: { disableModelInvocation: parsed.attributes["disable-model-invocation"] === true },
  };
}

function extensionSurface(file: SnapshotFile): ResourceSurface {
  const inventory = inventoryExtensionSource(decodeUtf8(file));
  return {
    kind: "extension",
    name:
      file.relativePath
        .split("/")
        .at(-1)
        ?.replace(/\.[^.]+$/u, "") ?? file.relativePath,
    relativePath: file.relativePath,
    primary: true,
    executable: true,
    registrations: inventory.registrations,
    dynamicBehavior: inventory.dynamicBehavior,
    metadata: inventory.metadata,
  };
}

function discoverSnapshot(
  snapshot: TreeSnapshot,
  scope: Scope,
  limits: ReturnType<typeof mergeLimits>,
  diagnostics: DiscoveryDiagnostic[],
): DiscoveryCandidate[] {
  const candidates: DiscoveryCandidate[] = [];
  const paths = snapshot.files.map((file) => file.relativePath);
  const filters = settingsFilters(snapshot, diagnostics, limits.maxManifestBytes);
  const byPath = fileMap(snapshot);
  const declared = new Map<ResourceKind, string[]>();
  const packageFiles = snapshot.files.filter(
    (file) => file.relativePath === "package.json" || file.relativePath.endsWith("/package.json"),
  );

  for (const packageFile of packageFiles) {
    let parsed: ReturnType<typeof parsePiManifest>;
    try {
      parsed = parsePiManifest(packageFile, limits.maxManifestBytes);
    } catch (error) {
      const issue: DiscoveryDiagnostic = {
        code: "pi-manifest-invalid",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        relativePath: packageFile.relativePath,
      };
      diagnostics.push(issue);
      const packageRoot =
        dirname(packageFile.relativePath) === "." ? "" : dirname(packageFile.relativePath);
      const fallbackName = packageRoot.split("/").at(-1) || "pi-package";
      candidates.push(
        createCandidate(
          {
            ecosystem: "pi",
            scope,
            snapshot,
            adapterId: ADAPTER_ID,
            adapterVersion: ADAPTER_VERSION,
            sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
            kind: "package",
            relativePath: packageFile.relativePath,
            displayName: fallbackName,
            executable: true,
            diagnostics: [issue],
            surfaces: [
              {
                kind: "package",
                name: fallbackName,
                relativePath: packageFile.relativePath,
                primary: true,
                executable: true,
                registrations: [],
                dynamicBehavior: true,
                metadata: {},
              },
            ],
          },
          limits,
        ),
      );
      continue;
    }
    diagnostics.push(...parsed.diagnostics);
    const packageRoot =
      dirname(packageFile.relativePath) === "." ? "" : dirname(packageFile.relativePath);
    const prefix = packageRoot === "" ? "" : `${packageRoot}/`;
    const packagePaths = paths
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length));
    const resourceLists: readonly [ResourceKind, readonly string[]][] = [
      ["extension", parsed.manifest.extensions],
      ["skill", parsed.manifest.skills],
      ["prompt", parsed.manifest.prompts],
      ["theme", parsed.manifest.themes],
    ];
    const surfaces: ResourceSurface[] = [];
    for (const [kind, patterns] of resourceLists) {
      let expanded: readonly string[];
      try {
        expanded = expandPatterns(packagePaths, patterns, limits.maxGlobMatches);
      } catch (error) {
        const issue: DiscoveryDiagnostic = {
          code: "pi-resource-pattern-invalid",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
          relativePath: packageFile.relativePath,
        };
        parsed.diagnostics.push(issue);
        diagnostics.push(issue);
        continue;
      }
      for (const relativeResource of expanded) {
        const full = `${prefix}${relativeResource}`;
        const source = byPath.get(full);
        let name =
          relativeResource
            .split("/")
            .at(-1)
            ?.replace(/\.[^.]+$/u, "") ?? relativeResource;
        let executable = kind === "extension";
        let registrations: readonly string[] = [];
        let dynamicBehavior = false;
        let metadata: Readonly<Record<string, string | number | boolean>> = {};
        if (source !== undefined) {
          try {
            if (kind === "extension") {
              const inventory = inventoryExtensionSource(decodeUtf8(source));
              registrations = inventory.registrations;
              dynamicBehavior = inventory.dynamicBehavior;
              metadata = inventory.metadata;
            } else if (kind === "skill") {
              const skill = parseSkill(source, snapshot);
              name = skill.name;
              executable = skill.executable;
              metadata = skill.metadata;
              parsed.diagnostics.push(...skill.diagnostics);
              diagnostics.push(...skill.diagnostics);
            } else if (kind === "prompt") {
              const prompt = parseFrontmatter(decodeUtf8(source), new Set(["name", "description"]));
              if (typeof prompt.attributes.name === "string") name = prompt.attributes.name;
            } else {
              parseJsonObject(source, limits.maxManifestBytes);
            }
          } catch (error) {
            const issue: DiscoveryDiagnostic = {
              code: resourceErrorCode(kind),
              severity: "error",
              message: error instanceof Error ? error.message : String(error),
              relativePath: full,
            };
            parsed.diagnostics.push(issue);
            diagnostics.push(issue);
            dynamicBehavior = executable;
          }
        }
        surfaces.push({
          kind,
          name,
          relativePath: full,
          primary: false,
          executable,
          registrations,
          dynamicBehavior,
          metadata,
        });
      }
    }
    if (parsed.manifest.dynamicDiscovery)
      surfaces.push({
        kind: "extension",
        name: "resources_discover",
        relativePath: packageFile.relativePath,
        primary: false,
        executable: true,
        registrations: ["resources_discover"],
        dynamicBehavior: true,
        metadata: {},
      });
    if (surfaces.length > 0) surfaces[0] = { ...(surfaces[0] as ResourceSurface), primary: true };
    else
      surfaces.push({
        kind: "package",
        name: parsed.inventory.packageName ?? (packageRoot || "pi-package"),
        relativePath: packageFile.relativePath,
        primary: true,
        executable: false,
        registrations: [],
        dynamicBehavior: parsed.manifest.dynamicDiscovery,
        metadata: {},
      });
    candidates.push(
      createCandidate(
        {
          ecosystem: "pi",
          scope,
          snapshot,
          adapterId: ADAPTER_ID,
          adapterVersion: ADAPTER_VERSION,
          sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
          kind: "package",
          relativePath: packageFile.relativePath,
          displayName: parsed.inventory.packageName ?? (packageRoot || "pi-package"),
          executable: surfaces.some((surface) => surface.executable),
          ...(parsed.inventory.packageName === undefined
            ? {}
            : { packageIdentity: parsed.inventory.packageName }),
          surfaces,
          inventory: parsed.inventory,
          diagnostics: parsed.diagnostics,
        },
        limits,
      ),
    );
  }

  for (const directory of ["extensions", "skills", "prompts", "themes"] as const) {
    const kind = resourceKind(directory);
    const files = conventionalFiles(
      snapshot,
      directory,
      directory === "extensions"
        ? extensionSuffixes
        : directory === "themes"
          ? new Set([".json"])
          : new Set([".md"]),
    );
    declared.set(
      kind,
      files.map((file) => file.relativePath),
    );
  }
  for (const added of filters.adds) {
    if (byPath.has(added)) {
      const kind: ResourceKind = added.includes("skill")
        ? "skill"
        : added.includes("prompt")
          ? "prompt"
          : added.includes("theme")
            ? "theme"
            : "extension";
      declared.set(kind, [...(declared.get(kind) ?? []), added]);
    }
  }

  const seen = new Set<string>();
  const skillNames = new Map<string, string>();
  for (const [kind, resourcePaths] of declared) {
    for (const relativePath of [...new Set(resourcePaths)].sort()) {
      if (seen.has(relativePath) || filters.removes.has(relativePath)) continue;
      seen.add(relativePath);
      const file = byPath.get(relativePath);
      if (file === undefined) continue;
      let displayName: string | undefined;
      let resourceDiagnostics: DiscoveryDiagnostic[] = [];
      let executable = kind === "extension";
      let surface: ResourceSurface | undefined;
      try {
        if (kind === "skill") {
          const parsed = parseSkill(file, snapshot);
          displayName = parsed.name;
          resourceDiagnostics = parsed.diagnostics;
          executable = parsed.executable;
          const existing = skillNames.get(parsed.name);
          if (existing !== undefined)
            resourceDiagnostics.push({
              code: "skill-collision",
              severity: "error",
              message: `skill name collides with ${existing}`,
              relativePath,
            });
          else skillNames.set(parsed.name, relativePath);
          surface = {
            kind,
            name: parsed.name,
            relativePath,
            primary: true,
            executable,
            registrations: [],
            dynamicBehavior: false,
            metadata: parsed.metadata,
          };
        } else if (kind === "extension") surface = extensionSurface(file);
        else if (kind === "prompt") {
          const parsed = parseFrontmatter(decodeUtf8(file), new Set(["name", "description"]));
          displayName =
            typeof parsed.attributes.name === "string" ? parsed.attributes.name : undefined;
          surface = {
            kind,
            name: displayName ?? relativePath,
            relativePath,
            primary: true,
            executable: false,
            registrations: [...decodeUtf8(file).matchAll(/\{\{([a-zA-Z0-9_-]+)\}\}/gu)]
              .map((match) => `substitution:${match[1] ?? ""}`)
              .sort(),
            dynamicBehavior: false,
            metadata: {},
          };
        } else {
          let metadata: Record<string, string | number | boolean> = {};
          try {
            const theme = parseJsonObject(file, limits.maxManifestBytes);
            metadata = {
              tokenCount:
                theme.colors !== null && typeof theme.colors === "object"
                  ? Object.keys(theme.colors as object).length
                  : 0,
            };
          } catch (error) {
            resourceDiagnostics.push({
              code: "theme-invalid",
              severity: "error",
              message: error instanceof Error ? error.message : String(error),
              relativePath,
            });
          }
          surface = {
            kind,
            name: displayName ?? relativePath,
            relativePath,
            primary: true,
            executable: false,
            registrations: [],
            dynamicBehavior: false,
            metadata,
          };
        }
      } catch (error) {
        const issue: DiscoveryDiagnostic = {
          code: resourceErrorCode(kind),
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
          relativePath,
        };
        resourceDiagnostics.push(issue);
        displayName = relativePath
          .split("/")
          .at(-1)
          ?.replace(/\.[^.]+$/u, "");
        if (kind === "skill") {
          const parent = dirname(relativePath);
          executable = snapshot.files.some(
            (candidate) =>
              candidate.relativePath.startsWith(`${parent}/`) &&
              candidate.relativePath !== relativePath &&
              /\.(?:js|mjs|cjs|ts|py|sh)$/u.test(candidate.relativePath),
          );
        }
        surface = {
          kind,
          name: displayName ?? relativePath,
          relativePath,
          primary: true,
          executable,
          registrations: [],
          dynamicBehavior: kind === "extension",
          metadata: {},
        };
      }
      diagnostics.push(...resourceDiagnostics);
      candidates.push(
        createCandidate(
          {
            ecosystem: "pi",
            scope,
            snapshot,
            adapterId: ADAPTER_ID,
            adapterVersion: ADAPTER_VERSION,
            sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
            kind,
            relativePath,
            ...(displayName === undefined ? {} : { displayName }),
            executable,
            ...(surface === undefined ? {} : { surfaces: [surface] }),
            diagnostics: resourceDiagnostics,
          },
          limits,
        ),
      );
    }
  }

  const metadataFiles: readonly [string, ResourceKind, number][] = [
    ["models.json", "provider", 0],
    ["AGENTS.md", "instructions", 1],
    ["SYSTEM.md", "instructions", 2],
    ["APPEND_SYSTEM.md", "instructions", 3],
  ];
  for (const [relativePath, kind, precedence] of metadataFiles) {
    const metadataFile = byPath.get(relativePath);
    if (metadataFile === undefined) continue;
    const metadataDiagnostics: DiscoveryDiagnostic[] = [];
    if (relativePath === "models.json") {
      try {
        const models = parseJsonObject(metadataFile, limits.maxManifestBytes);
        if (/"(?:apiKey|token|secret|password|oauth)"\s*:/iu.test(JSON.stringify(models))) {
          metadataDiagnostics.push({
            code: "literal-credential",
            severity: "error",
            message: "provider configuration contains credential-like fields",
            relativePath,
          });
        }
      } catch (error) {
        metadataDiagnostics.push({
          code: "provider-config-invalid",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
          relativePath,
        });
      }
    }
    diagnostics.push(...metadataDiagnostics);
    candidates.push(
      createCandidate(
        {
          ecosystem: "pi",
          scope,
          snapshot,
          adapterId: ADAPTER_ID,
          adapterVersion: ADAPTER_VERSION,
          sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
          kind,
          relativePath,
          executable: false,
          sourcePrecedence: precedence,
          diagnostics: metadataDiagnostics,
        },
        limits,
      ),
    );
  }
  const keybindings = byPath.get("keybindings.json");
  if (keybindings !== undefined) {
    try {
      parseJsonObject(keybindings, limits.maxManifestBytes);
      diagnostics.push({
        code: "keybindings-inventoried",
        severity: "info",
        message: "keybindings are inventory metadata and are not adoptable",
        relativePath: "keybindings.json",
      });
    } catch (error) {
      diagnostics.push({
        code: "keybindings-invalid",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        relativePath: "keybindings.json",
      });
    }
  }
  return candidates;
}

async function inspectOptionalRoot(
  root: string,
  scope: Scope,
  context: DiscoveryContext,
  fileSystem: BoundedFileSystem,
  contextOnly = false,
): Promise<AdapterResult> {
  const limits = mergeLimits(context.limits);
  try {
    const snapshot = await snapshotTree(root, fileSystem, limits, {
      exclude(relativePath) {
        if (contextOnly && !["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"].includes(relativePath)) {
          return true;
        }
        return (
          relativePath === "auth.json" ||
          relativePath === "trust.json" ||
          relativePath === "model-cache.json" ||
          relativePath.startsWith("sessions/") ||
          relativePath.startsWith("cache/")
        );
      },
    });
    const diagnostics = [...snapshot.diagnostics];
    return { candidates: discoverSnapshot(snapshot, scope, limits, diagnostics), diagnostics };
  } catch (error) {
    return { candidates: [], diagnostics: [diagnosticsForError(error, root)] };
  }
}

export const piAdapter: SourceAdapter = {
  ecosystem: "pi",
  adapterId: ADAPTER_ID,
  adapterVersion: ADAPTER_VERSION,
  sourceSchemaVersions: [SOURCE_SCHEMA_VERSION],
  async discover(context, fileSystem) {
    const environment = context.environment ?? {};
    const globalRoot =
      environment.PI_CODING_AGENT_DIR ?? join(context.homeDirectory, ".pi", "agent");
    const roots: { root: string; scope: Scope; contextOnly?: boolean }[] = [
      { root: globalRoot, scope: "global" },
    ];
    const policyDiagnostics: DiscoveryDiagnostic[] = [];
    const packageRoot = environment.PI_PACKAGE_DIR;
    if (packageRoot !== undefined && packageRoot !== globalRoot)
      roots.push({ root: packageRoot, scope: "global" });
    if (context.projectDirectory !== undefined) {
      if (context.projectTrusted) {
        roots.push({ root: join(context.projectDirectory, ".pi"), scope: "project" });
        roots.push({ root: context.projectDirectory, scope: "project", contextOnly: true });
        let ancestor = context.projectDirectory;
        const filesystemRoot = parse(ancestor).root;
        for (let depth = 0; depth < 32; depth += 1) {
          roots.push({ root: join(ancestor, ".agents"), scope: "project" });
          if (ancestor === filesystemRoot) break;
          const parent = dirname(ancestor);
          if (parent === ancestor) break;
          ancestor = parent;
        }
      } else {
        policyDiagnostics.push({
          code: "adoption_project_untrusted",
          severity: "error",
          message: "Pi project resources require Axl project trust",
        });
      }
    }
    const uniqueRoots = [...new Map(roots.map((entry) => [entry.root, entry])).values()];
    const limits = mergeLimits(context.limits);
    if (uniqueRoots.length > limits.maxRoots) {
      return {
        candidates: [],
        diagnostics: [
          {
            code: "scan-limit-exceeded",
            severity: "error",
            message: "discovery root limit exceeded",
          },
        ],
      };
    }
    const results = await Promise.all(
      uniqueRoots.map((entry) =>
        inspectOptionalRoot(
          entry.root,
          entry.scope,
          context,
          fileSystem,
          entry.contextOnly ?? false,
        ),
      ),
    );
    return {
      candidates: results.flatMap((result) => result.candidates),
      diagnostics: [...policyDiagnostics, ...results.flatMap((result) => result.diagnostics)],
    };
  },
};
