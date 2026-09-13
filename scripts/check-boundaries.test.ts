// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 Lokesh
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

test("enforces control-plane and relay service boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "axl-service-boundaries-"));
  const controlPlane = join(root, "services/control-plane");
  mkdirSync(join(controlPlane, "src"), { recursive: true });
  writeFileSync(
    join(controlPlane, "package.json"),
    JSON.stringify({ name: "@axl/control-plane", dependencies: { fastify: "1.0.0" } }),
  );
  writeFileSync(join(controlPlane, "src/index.ts"), 'import "@axl/daemon";\n');
  const relay = join(root, "services/relay");
  mkdirSync(relay, { recursive: true });
  writeFileSync(
    join(relay, "mix.exs"),
    'defp deps, do: [{:bandit, "1.12.5"}, {:forbidden, path: "../../packages/kernel"}]\n',
  );

  assert.deepEqual(checkWorkspace(root), [
    "services/control-plane may depend only on @axl/protocol, found fastify",
    "services/control-plane/src/index.ts imports @axl/daemon; control plane may import only Node.js and @axl/protocol",
    "services/relay may not depend on unapproved package forbidden",
    "services/relay must not use path dependencies into repository packages",
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
