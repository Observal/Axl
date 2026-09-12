// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

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
    if ([".git", "_build", "deps", "dist", "node_modules"].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else visit(path);
  }
}

function packageDirectories(root: string): string[] {
  const directories: string[] = [];
  for (const workspaceRoot of ["packages", "services"]) {
    walk(resolve(root, workspaceRoot), (path) => {
      if (path.endsWith(`${sep}package.json`)) directories.push(dirname(path));
    });
  }
  return directories;
}

function importsIn(source: string, fileName: string): string[] {
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : undefined;
    if (specifier !== undefined && ts.isStringLiteralLike(specifier)) imports.push(specifier.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest));
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
  const ui = packages.find(({ directory }) => directory === resolve(root, "packages/ui"));
  const tui = packages.find(({ directory }) => directory === resolve(root, "packages/tui"));
  const controlPlane = packages.find(
    ({ directory }) => directory === resolve(root, "services/control-plane"),
  );
  const protocolName = protocol?.manifest.name ?? "@axl/protocol";
  const kernelName = kernel?.manifest.name ?? "@axl/kernel";
  const tuiName = tui?.manifest.name ?? "@axl/tui";
  const sdkName = sdk?.manifest.name ?? "@axl/sdk";
  const uiRuntimeAllowed = new Set([
    sdkName,
    "@fontsource-variable/inter",
    "highlight.js",
    "marked",
    "react",
  ]);
  const tuiRuntimeAllowed = new Set([
    "@axl/extension-api",
    sdkName,
    "grok-mermaid",
    "highlight.js",
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

  if (controlPlane) {
    for (const dependency of runtimeDependencies(controlPlane.manifest)) {
      if (dependency !== protocolName) {
        errors.push(
          `${relative(root, controlPlane.directory)} may depend only on ${protocolName}, found ${dependency}`,
        );
      }
    }
  }

  if (runtime && runtimeDependencies(runtime.manifest).includes(tuiName)) {
    errors.push(
      `${relative(root, runtime.directory)} must not depend on presentation package ${tuiName}`,
    );
  }

  if (ui) {
    for (const dependency of runtimeDependencies(ui.manifest)) {
      if (!uiRuntimeAllowed.has(dependency)) {
        errors.push(
          `${relative(root, ui.directory)} may depend only on shared client presentation packages, found ${dependency}`,
        );
      }
    }
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
      for (const specifier of importsIn(readFileSync(path, "utf8"), path)) {
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
          directory === ui?.directory &&
          !specifier.startsWith(".") &&
          !uiRuntimeAllowed.has(specifier) &&
          ![...uiRuntimeAllowed].some((dependency) => specifier.startsWith(`${dependency}/`))
        ) {
          errors.push(
            `${relative(root, path)} imports ${specifier}; UI source may import only shared client presentation packages`,
          );
        }
        if (
          directory === controlPlane?.directory &&
          !specifier.startsWith(".") &&
          !specifier.startsWith("node:") &&
          specifier !== protocolName
        ) {
          errors.push(
            `${relative(root, path)} imports ${specifier}; control plane may import only Node.js and ${protocolName}`,
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

  const relayMixPath = resolve(root, "services/relay/mix.exs");
  if (existsSync(relayMixPath)) {
    const relayMix = readFileSync(relayMixPath, "utf8");
    const allowedRelayDependencies = new Set([
      "bandit",
      "plug",
      "websock_adapter",
      "credo",
      "dialyxir",
      "mix_audit",
    ]);
    for (const match of relayMix.matchAll(/\{:([a-z][a-z0-9_]*),/g)) {
      const dependency = match[1] as string;
      if (!allowedRelayDependencies.has(dependency)) {
        errors.push(`services/relay may not depend on unapproved package ${dependency}`);
      }
    }
    if (/\bpath:\s*/.test(relayMix)) {
      errors.push("services/relay must not use path dependencies into repository packages");
    }
  }

  walk(resolve(root, "apps"), (path) => {
    const extension = path.slice(path.lastIndexOf("."));
    if (!sourceExtensions.has(extension)) return;
    for (const specifier of importsIn(readFileSync(path, "utf8"), path)) {
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
