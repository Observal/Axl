// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const sourceExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);

type PackageManifest = {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: string | Record<string, unknown>;
};

function walk(directory: string, visit: (path: string) => void): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "dist", "node_modules"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else visit(path);
  }
}

function packageDirectories(root: string): string[] {
  const directories: string[] = [];
  walk(resolve(root, "packages"), (path) => {
    if (path.endsWith(`${sep}package.json`)) directories.push(dirname(path));
  });
  return directories;
}

function importsIn(source: string): string[] {
  const imports: string[] = [];
  const pattern =
    /\bfrom\s*["']([#@A-Za-z0-9][#@A-Za-z0-9._:/-]*)["']|\bimport\s*(?:\(\s*)?["']([#@A-Za-z0-9][#@A-Za-z0-9._:/-]*)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier) imports.push(specifier);
  }
  return imports;
}

function isInside(path: string, parent: string): boolean {
  const pathFromParent = relative(parent, path);
  return (
    pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..")
  );
}

function runtimeDependencies(manifest: PackageManifest): string[] {
  return runtimeDependencyFields.flatMap((field) => Object.keys(manifest[field] ?? {}));
}

function exportsSubpath(manifest: PackageManifest, subpath: string): boolean {
  return (
    typeof manifest.exports === "object" && manifest.exports !== null && subpath in manifest.exports
  );
}

export function checkWorkspace(root: string): string[] {
  const errors: string[] = [];
  const packages = packageDirectories(root).map((directory) => ({
    directory,
    manifest: JSON.parse(
      readFileSync(resolve(directory, "package.json"), "utf8"),
    ) as PackageManifest,
  }));
  const protocol = packages.find(
    ({ directory }) => directory === resolve(root, "packages/protocol"),
  );
  const kernel = packages.find(({ directory }) => directory === resolve(root, "packages/kernel"));
  const runtime = packages.find(({ directory }) => directory === resolve(root, "packages/runtime"));
  const sdk = packages.find(({ directory }) => directory === resolve(root, "packages/sdk"));
  const tui = packages.find(({ directory }) => directory === resolve(root, "packages/tui"));
  const protocolName = protocol?.manifest.name ?? "@axl/protocol";
  const kernelName = kernel?.manifest.name ?? "@axl/kernel";
  const tuiName = tui?.manifest.name ?? "@axl/tui";
  const sdkName = sdk?.manifest.name ?? "@axl/sdk";
  const tuiRuntimeAllowed = new Set([
    "@axl/extension-api",
    sdkName,
    "grok-mermaid",
    "marked",
    protocolName,
  ]);

  if (protocol) {
    for (const dependency of runtimeDependencies(protocol.manifest)) {
      errors.push(
        `${relative(root, protocol.directory)} must be dependency-free, found ${dependency}`,
      );
    }
  }

  if (kernel) {
    for (const dependency of runtimeDependencies(kernel.manifest)) {
      if (dependency !== protocolName) {
        errors.push(
          `${relative(root, kernel.directory)} may depend only on ${protocolName}, found ${dependency}`,
        );
      }
    }
  }

  if (sdk) {
    for (const dependency of runtimeDependencies(sdk.manifest)) {
      if (dependency !== protocolName) {
        errors.push(
          `${relative(root, sdk.directory)} may depend only on ${protocolName}, found ${dependency}`,
        );
      }
    }
  }

  if (runtime && runtimeDependencies(runtime.manifest).includes(tuiName)) {
    errors.push(
      `${relative(root, runtime.directory)} must not depend on presentation package ${tuiName}`,
    );
  }

  if (tui) {
    for (const dependency of runtimeDependencies(tui.manifest)) {
      if (!tuiRuntimeAllowed.has(dependency)) {
        errors.push(
          `${relative(root, tui.directory)} may depend only on client-facing packages, found ${dependency}`,
        );
      }
    }
  }

  for (const { directory } of packages) {
    walk(resolve(directory, "src"), (path) => {
      const extension = path.slice(path.lastIndexOf("."));
      if (!sourceExtensions.has(extension)) return;
      for (const specifier of importsIn(readFileSync(path, "utf8"))) {
        if (directory === protocol?.directory && !specifier.startsWith(".")) {
          errors.push(
            `${relative(root, path)} imports ${specifier}; protocol may use only relative imports`,
          );
        }
        if (
          directory === kernel?.directory &&
          !specifier.startsWith(".") &&
          !specifier.startsWith("node:") &&
          specifier !== protocolName
        ) {
          errors.push(
            `${relative(root, path)} imports ${specifier}; kernel may import only Node.js and ${protocolName}`,
          );
        }
        if (
          directory === tui?.directory &&
          !specifier.startsWith(".") &&
          !specifier.startsWith("node:") &&
          !tuiRuntimeAllowed.has(specifier)
        ) {
          errors.push(
            `${relative(root, path)} imports ${specifier}; TUI source may import only client-facing packages`,
          );
        }
        if (isInside(directory, resolve(root, "packages/extensions"))) {
          if (specifier.startsWith(".")) {
            const target = resolve(dirname(path), specifier);
            if (kernel && isInside(target, kernel.directory)) {
              errors.push(`${relative(root, path)} imports kernel source by relative path`);
            }
          } else if (specifier.startsWith(`${kernelName}/`)) {
            const subpath = `.${specifier.slice(kernelName.length)}`;
            if (!exportsSubpath(kernel?.manifest ?? {}, subpath)) {
              errors.push(`${relative(root, path)} imports private kernel path ${specifier}`);
            }
          }
        }
      }
    });
  }

  walk(resolve(root, "apps"), (path) => {
    const extension = path.slice(path.lastIndexOf("."));
    if (!sourceExtensions.has(extension)) return;
    for (const specifier of importsIn(readFileSync(path, "utf8"))) {
      if (specifier.startsWith("@axl/") && specifier !== "@axl/sdk") {
        errors.push(`${relative(root, path)} imports ${specifier}; apps may import only @axl/sdk`);
      }
    }
  });

  return errors;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const errors = checkWorkspace(root);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Package boundaries are valid.");
  }
}
