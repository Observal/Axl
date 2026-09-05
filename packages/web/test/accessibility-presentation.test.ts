// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConversationProjector, emptyWorkspaceState, parseSessionId } from "@axl/sdk";

import { App, escapeDestination } from "../dist/app.js";
import type { ApplicationShell } from "../dist/shell.js";

function staticShell(selected = false): ApplicationShell {
  const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
  const conversation = new ConversationProjector(sessionId).state;
  const state = {
    connection: "connected" as const,
    grantedCapabilities: [],
    sessions: [],
    nextPageCursor: undefined,
    search: "",
    selected: selected
      ? {
          sessionId,
          cwd: "<repository>",
          runtime: { state: "idle" as const },
          profile: "standard" as const,
        }
      : undefined,
    conversation: { ...conversation, model: "<hostile-model>" },
    workspace: emptyWorkspaceState(sessionId),
    draft: "",
    cursorPersistence: { state: "available" as const },
    presence: [],
    busy: false,
    detached: false,
    error: undefined,
  };
  return {
    state,
    subscribe: () => () => undefined,
    supports: () => false,
  } as unknown as ApplicationShell;
}

test("Chat remains a permanent semantic destination with restrained status announcements", () => {
  const html = renderToStaticMarkup(createElement(App, { shell: staticShell() }));
  assert.match(html, /<header class="topbar">/);
  assert.match(html, /<nav aria-label="Quick navigation"/);
  assert.match(html, /<nav aria-label="Primary"/);
  assert.match(html, /aria-current="page">Chat/);
  assert.match(html, /<main class="primary-pane" aria-label="Chat">/);
  assert.match(html, /Connection: Connected/);
  assert.match(html, /Session: None selected/);
  assert.equal((html.match(/aria-live=/g) ?? []).length, 1);
  assert.equal((html.match(/role="status"/g) ?? []).length, 1);
  assert.match(html, /<button type="button" disabled="">Explorer<\/button>/);
  assert.match(html, /<button type="submit" disabled="">Create<\/button>/);
});

test("repository and model labels remain escaped plain text", () => {
  const html = renderToStaticMarkup(createElement(App, { shell: staticShell(true) }));
  assert.match(html, /&lt;repository&gt;/);
  assert.match(html, /Model: &lt;hostile-model&gt;/);
  assert.doesNotMatch(html, /<repository>|<hostile-model>/);
});

test("Escape priority closes the modal navigation before returning a workspace pane to Chat", () => {
  assert.equal(escapeDestination(true, "changes"), "close-overlay");
  assert.equal(escapeDestination(false, "explorer"), "show-chat");
  assert.equal(escapeDestination(false, "chat"), "none");
});
