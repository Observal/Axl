// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { TerminalExtensionHost, type TerminalExtension } from "@axl/extension-api";

import { ExtensionWidgetsComponent, PLAIN_PALETTE } from "../src/index.ts";

test("extension widgets sanitize controls and collapse embedded lines", async () => {
  const extension: TerminalExtension = {
    manifest: { id: "test.safe-widget", name: "Safe widget", capabilities: ["terminal.widgets"] },
    activate(api) {
      api.registerWidget("unsafe", {
        render: () => [{ text: "first\nsecond\u001b]0;owned\u0007", tone: "accent" }],
      });
    },
  };
  const host = new TerminalExtensionHost([extension]);
  const component = new ExtensionWidgetsComponent(host, "aboveEditor", () => PLAIN_PALETTE);
  await host.activate();
  assert.deepEqual(component.render(80), ["first second"]);
  await host.dispose();
});

test("extension widgets cache settled rows and invalidate on lifecycle changes", async () => {
  let renders = 0;
  const extension: TerminalExtension = {
    manifest: { id: "test.widget", name: "Widget", capabilities: ["terminal.widgets"] },
    activate(api) {
      api.registerWidget("summary", {
        render: () => {
          renders += 1;
          return [{ text: "summary", tone: "accent" }];
        },
      });
    },
  };
  const host = new TerminalExtensionHost([extension]);
  const component = new ExtensionWidgetsComponent(host, "aboveEditor", () => PLAIN_PALETTE);

  await host.activate();
  assert.deepEqual(component.render(80), ["summary"]);
  assert.deepEqual(component.render(80), ["summary"]);
  assert.equal(renders, 1);

  await host.deactivate("test.widget");
  assert.deepEqual(component.render(80), []);
  await host.activateExtension("test.widget");
  assert.deepEqual(component.render(80), ["summary"]);
  assert.equal(renders, 2);
  await host.dispose();
});
