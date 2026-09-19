// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkWorkspace } from "./check-boundaries.ts";

function writePackage(
  root: string,
  path: string,
  manifest: Record<string, unknown>,
  source = "export {};\n",
): void {
  const directory = join(root, "packages", path);
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(directory, "src/index.ts"), source);
}

test("enforces protocol, kernel, runtime, TUI, and extension dependency boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "axl-boundaries-"));
  writePackage(root, "protocol", { name: "@axl/protocol", dependencies: { typebox: "1.0.0" } });
  writePackage(root, "kernel", {
    name: "@axl/kernel",
    dependencies: { "@axl/protocol": "workspace:*", yaml: "1.0.0" },
  });
  writePackage(root, "runtime", {
    name: "@axl/runtime",
    dependencies: { "@axl/tui": "workspace:*" },
  });
  writePackage(
    root,
    "tui",
    {
      name: "@axl/tui",
      dependencies: {
        "@axl/extension-api": "workspace:*",
        "@axl/runtime": "workspace:*",
        "grok-mermaid": "0.2.2",
        marked: "18.0.11",
      },
    },
    'import "@axl/ai";\n',
  );
  writePackage(
    root,
    "extensions/example",
    { name: "@axl/example" },
    'import "@axl/kernel/private";\n',
  );
  mkdirSync(join(root, "apps/example"), { recursive: true });
  writeFileSync(join(root, "apps/example/index.ts"), 'import "@axl/kernel";\n');

  assert.deepEqual(checkWorkspace(root), [
    "packages/protocol must be dependency-free, found typebox",
    "packages/kernel may depend only on @axl/protocol, found yaml",
    "packages/runtime must not depend on presentation package @axl/tui",
    "packages/tui may depend only on client-facing packages, found @axl/runtime",
    "packages/extensions/example/src/index.ts imports private kernel path @axl/kernel/private",
    "packages/tui/src/index.ts imports @axl/ai; TUI source may import only client-facing packages",
    "apps/example/index.ts imports @axl/kernel; apps may import only @axl/sdk",
  ]);
});

test("rejects every forbidden Lounge import form and permits the public API", () => {
  const root = mkdtempSync(join(tmpdir(), "axl-lounge-boundaries-"));
  writePackage(root, "extensions/api", { name: "@axl/extension-api" });
  writePackage(
    root,
    "extensions/lounge",
    {
      name: "@axl/extension-lounge",
      dependencies: {
        "@axl/extension-api": "workspace:*",
        "@axl/sdk": "workspace:*",
      },
    },
    `
      import type { TerminalExtension } from "@axl/extension-api";
      import "@axl/tui";
      import "@axl/extension-api/private";
      void import("node:fs");
      type Internal = import("@axl/sdk").AxlClient;
      export const extension: TerminalExtension | undefined = undefined;
    `,
  );

  assert.deepEqual(checkWorkspace(root), [
    "packages/extensions/lounge may depend only on the public extension API, found @axl/sdk",
    "packages/extensions/lounge/src/index.ts imports @axl/tui; Lounge may import only the public extension API",
    "packages/extensions/lounge/src/index.ts imports @axl/extension-api/private; Lounge may import only the public extension API",
    "packages/extensions/lounge/src/index.ts imports node:fs; Lounge may import only the public extension API",
    "packages/extensions/lounge/src/index.ts imports @axl/sdk; Lounge may import only the public extension API",
  ]);
});

test("rejects Lounge relative imports that escape the package", () => {
  const root = mkdtempSync(join(tmpdir(), "axl-lounge-relative-boundaries-"));
  writePackage(root, "extensions/api", { name: "@axl/extension-api" });
  writePackage(
    root,
    "extensions/lounge",
    {
      name: "@axl/extension-lounge",
      dependencies: { "@axl/extension-api": "workspace:*" },
    },
    'import type { TerminalExtension } from "@axl/extension-api";\nimport "../../tui/src/index.ts";\nexport const extension: TerminalExtension | undefined = undefined;\n',
  );
  assert.deepEqual(checkWorkspace(root), [
    "packages/extensions/lounge/src/index.ts imports ../../tui/src/index.ts; Lounge relative imports must stay inside its package",
  ]);
});

test("checks real imports without interpreting embedded clipboard scripts as dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "axl-boundary-syntax-"));
  writePackage(
    root,
    "tui",
    { name: "@axl/tui" },
    `
    const script = 'ObjC.import("AppKit");';
    ObjC.import("AppKit");
    // import "@axl/ai";
    import type { Event } from "@axl/protocol";
    export { value } from "@axl/kernel";
    void import("@axl/ai");
    type Forbidden = import("@axl/runtime").Runtime;
  `,
  );
  assert.deepEqual(checkWorkspace(root), [
    "packages/tui/src/index.ts imports @axl/kernel; TUI source may import only client-facing packages",
    "packages/tui/src/index.ts imports @axl/ai; TUI source may import only client-facing packages",
    "packages/tui/src/index.ts imports @axl/runtime; TUI source may import only client-facing packages",
  ]);
});
