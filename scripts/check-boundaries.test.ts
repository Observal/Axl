// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
