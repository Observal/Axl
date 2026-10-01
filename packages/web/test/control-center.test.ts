// SPDX-FileCopyrightText: 2026 PranavD2905
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { WebPreferences } from "../src/environment.ts";

// Node strips TypeScript types but does not compile JSX, so this test compiles web .tsx sources on load.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".tsx")) return nextLoad(url, context);
    const fileName = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
      fileName,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2023,
        verbatimModuleSyntax: true,
      },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

const { ControlCenter } = await import("../src/control-center.tsx");

const preferences: WebPreferences = {
  sidebarWidth: 280,
  dockWidth: 560,
  sidebarCollapsed: false,
  changesView: "files",
  panes: [],
};

function renderSettings(overrides: Partial<WebPreferences>): string {
  const noop = (): void => undefined;
  return renderToStaticMarkup(
    createElement(ControlCenter, {
      tab: "settings",
      preferences: { ...preferences, ...overrides },
      theme: "system",
      providers: [],
      providerLoading: false,
      mcpBusy: false,
      mcpActiveIdentities: new Set<string>(),
      canRefresh: false,
      canLogin: false,
      canLogout: false,
      onTab: noop,
      onPreferences: noop,
      onTheme: noop,
      onRefresh: noop,
      onCancelRefresh: noop,
      onLogin: noop,
      onCancelLogin: noop,
      onLogout: noop,
      onCopyLogin: noop,
      onMcpAdd: () => Promise.resolve(),
      onMcpImport: () => Promise.resolve(),
      onMcpRemove: noop,
      onMcpSetEnabled: noop,
      onMcpReload: noop,
      onClose: noop,
    }),
  );
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`, "u").exec(tag)?.[1];
}

function sessionRailSwitch(html: string): string {
  const tag = /<button[^>]*role="switch"[^>]*>/u.exec(html)?.[0];
  assert.ok(tag, "Session rail switch is rendered");
  return tag;
}

test("the Session rail switch is named by its visible label and reports its state", () => {
  const visible = renderSettings({ sidebarCollapsed: false });
  const tag = sessionRailSwitch(visible);
  const labelId = attribute(tag, "aria-labelledby");
  assert.ok(labelId, "switch has aria-labelledby");
  assert.match(visible, new RegExp(`<strong id="${labelId}">Session rail</strong>`, "u"));
  const detailId = attribute(tag, "aria-describedby");
  assert.ok(detailId, "switch has aria-describedby");
  assert.match(
    visible,
    new RegExp(`<small id="${detailId}">Keep the session list visible on desktop</small>`, "u"),
  );
  assert.equal(attribute(tag, "aria-checked"), "true");

  assert.equal(
    attribute(sessionRailSwitch(renderSettings({ sidebarCollapsed: true })), "aria-checked"),
    "false",
  );
});

test("the Default changes view buttons expose the selected option", () => {
  for (const changesView of ["files", "all"] as const) {
    const html = renderSettings({ changesView });
    const group = /<div[^>]*aria-label="Default changes view"[^>]*>(.*?)<\/div>/u.exec(html);
    assert.ok(group, "changes view group is rendered with an accessible name");
    assert.equal(attribute(group[0], "role"), "group");
    const buttons = [...(group[1] ?? "").matchAll(/<button([^>]*)>([^<]*)<\/button>/gu)].map(
      (match) => ({
        label: match[2],
        pressed: attribute(match[1] ?? "", "aria-pressed"),
      }),
    );
    assert.deepEqual(buttons, [
      { label: "Files", pressed: String(changesView === "files") },
      { label: "All", pressed: String(changesView === "all") },
    ]);
  }
});
