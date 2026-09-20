// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { McpConfigListResult, UserQuestionAnswer } from "@axl/protocol";
import { MCP_ADD_SERVER_QUESTIONS } from "@axl/sdk";

import {
  McpPanelOverlay,
  PLAIN_PALETTE,
  QuestionnaireOverlay,
  visibleWidth,
} from "../src/index.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function listing(): McpConfigListResult {
  return {
    path: "/home/user/.axl/mcp.json",
    servers: [
      {
        name: "broken",
        definition: { url: "https://broken.example.com/mcp" },
        status: "failed",
        tools: [],
        error: "endpoint returned HTTP 404",
      },
      {
        name: "docs",
        definition: { url: "https://mcp.example.com/mcp", headers: { Authorization: "DOCS" } },
        status: "discovered",
        discoveredAt: 1,
        tools: [
          { name: "search_docs", description: "Search the documentation." },
          { name: "read_page", description: "Read one page." },
        ],
      },
      {
        name: "off",
        definition: { command: "npx", args: ["-y", "x"], enabled: false },
        status: "disabled",
        tools: [],
      },
    ],
  };
}

function panel(state: McpConfigListResult, active: string[] = []) {
  const calls: string[] = [];
  let closed = 0;
  const overlay = new McpPanelOverlay({
    palette: () => PLAIN_PALETTE,
    refresh: () => undefined,
    load: async () => state,
    activeIdentities: () => new Set(active),
    onAdd: () => calls.push("add"),
    onImport: () => calls.push("import"),
    remove: async (name) => {
      calls.push(`remove:${name}`);
      state = { ...state, servers: state.servers.filter((server) => server.name !== name) };
    },
    setEnabled: async (name, enabled) => {
      calls.push(`enabled:${name}:${enabled}`);
    },
    reload: async () => {
      calls.push("reload");
    },
    close: () => {
      closed += 1;
    },
  });
  return { overlay, calls, closed: () => closed };
}

test("renders daemon-projected servers with status, tool counts, and the failure under the cursor", async () => {
  const { overlay } = panel(listing());
  await tick();
  const text = overlay.render(80).join("\n");
  assert.match(text, /MCP servers/u);
  assert.match(text, /Global config: \/home\/user\/\.axl\/mcp\.json/u);
  assert.match(text, /3 servers · 2 tools · 1 failed \(broken\) · 1 disabled/u);
  assert.match(text, /broken.*failed/u);
  assert.match(text, /endpoint returned HTTP 404/u);
  assert.match(text, /docs.*2 tools.*discovered/u);
  assert.match(text, /off.*disabled/u);
  assert.equal(text.includes("Authorization"), false);
  assert.ok(overlay.render(80).every((line) => visibleWidth(line) <= 80));
});

test("expands a server into tool rows and marks session-activated tools", async () => {
  const { overlay } = panel(listing(), ["mcp:docs/search_docs"]);
  await tick();
  overlay.handleKey("\u001b[B"); // down to docs
  overlay.handleKey("\r");
  const text = overlay.render(80).join("\n");
  assert.match(text, /● search_docs\s+Search the documentation\./u);
  assert.match(text, /○ read_page\s+Read one page\./u);
  overlay.handleKey("\r");
  assert.equal(overlay.render(80).join("\n").includes("search_docs"), false);
});

test("keys submit intent: add, confirm-remove, enable, reload, close", async () => {
  const fixture = panel(listing());
  await tick();
  fixture.overlay.handleKey("a");
  fixture.overlay.handleKey("p");
  assert.deepEqual(fixture.calls, ["add", "import"]);

  fixture.overlay.handleKey("d");
  assert.match(fixture.overlay.render(80).join("\n"), /Remove broken\?/u);
  fixture.overlay.handleKey("\u001b");
  assert.equal(fixture.overlay.render(80).join("\n").includes("Remove broken?"), false);
  fixture.overlay.handleKey("d");
  fixture.overlay.handleKey("\r");
  await tick();
  await tick();
  assert.deepEqual(fixture.calls, ["add", "import", "remove:broken"]);
  assert.equal(fixture.overlay.render(80).join("\n").includes("broken"), false);

  fixture.overlay.handleKey("\u001b[B");
  fixture.overlay.handleKey("e");
  await tick();
  await tick();
  assert.deepEqual(fixture.calls.at(-1), "enabled:off:true");

  fixture.overlay.handleKey("r");
  await tick();
  await tick();
  assert.deepEqual(fixture.calls.at(-1), "reload");

  fixture.overlay.handleKey("\u001b");
  assert.equal(fixture.closed(), 1);
});

test("an empty configuration points at the add flow and load errors are visible", async () => {
  const empty = panel({ path: "/p/mcp.json", servers: [] });
  await tick();
  const text = empty.overlay.render(60).join("\n");
  assert.match(text, /No MCP servers are configured/u);
  assert.match(text, /Press p to paste/u);

  const failing = new McpPanelOverlay({
    palette: () => PLAIN_PALETTE,
    refresh: () => undefined,
    load: () => Promise.reject(new Error("daemon unavailable")),
    activeIdentities: () => new Set(),
    onAdd: () => undefined,
    onImport: () => undefined,
    remove: async () => undefined,
    setEnabled: async () => undefined,
    reload: async () => undefined,
    close: () => undefined,
  });
  await tick();
  assert.match(failing.render(60).join("\n"), /daemon unavailable/u);
});

test("the add questionnaire enters text directly, reviews the effect, and surfaces submit errors", async () => {
  let submitted: readonly UserQuestionAnswer[] | undefined;
  let attempts = 0;
  const dialog = new QuestionnaireOverlay({
    title: "Add MCP server",
    questions: MCP_ADD_SERVER_QUESTIONS,
    palette: () => PLAIN_PALETTE,
    refresh: () => undefined,
    submitLabel: "connect and save",
    pendingLabel: "Connecting…",
    review: (answers) => [
      `review:${answers.map((answer) => answer.customAnswer ?? answer.selectedLabels[0] ?? "").join("|")}`,
    ],
    submit: async (answers) => {
      attempts += 1;
      if (attempts === 1) throw new Error("endpoint returned HTTP 404");
      submitted = answers;
    },
    cancel: async () => undefined,
  });
  assert.match(dialog.render(80).join("\n"), /Add MCP server/u);
  assert.match(dialog.render(80).join("\n"), /> $/mu); // text entry is already open for Name
  dialog.handleKey("docs");
  dialog.handleKey("\r");
  dialog.handleKey("1"); // Remote server
  dialog.handleKey("https://mcp.example.com/mcp");
  dialog.handleKey("\r");
  dialog.handleKey("1"); // Secrets: None
  dialog.handleKey("1"); // Roots: None
  const review = dialog.render(80).join("\n");
  assert.match(review, /Review answers/u);
  assert.match(review, /review:docs\|Remote server\|https:\/\/mcp\.example\.com\/mcp\|None\|None/u);
  assert.match(review, /Enter to connect and save/u);
  dialog.handleKey("\r");
  await tick();
  assert.match(dialog.render(80).join("\n"), /endpoint returned HTTP 404/u);
  dialog.handleKey("\r");
  await tick();
  assert.equal(submitted?.length, 5);
});

test("the caret sits on the text prompt even with a dialog title and pasted multi-line text", () => {
  const dialog = new QuestionnaireOverlay({
    title: "Import MCP servers",
    questions: [
      {
        header: "Import",
        question: "Paste the block.",
        options: [{ label: "None", description: "Nothing." }],
      },
    ],
    palette: () => PLAIN_PALETTE,
    refresh: () => undefined,
    submit: async () => undefined,
    cancel: async () => undefined,
  });
  dialog.handleKey("2"); // Type something.
  dialog.paste('{\n  "mcpServers": {}\n}');
  const lines = dialog.render(60);
  const cursor = dialog.cursor();
  assert.ok(cursor !== undefined);
  const promptLine = lines[cursor.row] ?? "";
  assert.match(promptLine, /^ {2}> /u);
  assert.equal(promptLine.includes("\n"), false);
  assert.equal(visibleWidth(promptLine), cursor.column);
});

test("a pasted multi-line answer never breaks the dialog frame, and Esc cancels from review", async () => {
  let cancelled = 0;
  const dialog = new QuestionnaireOverlay({
    title: "Import MCP servers",
    questions: [{ header: "Import", question: "Paste the block.", options: [] }],
    palette: () => PLAIN_PALETTE,
    refresh: () => undefined,
    review: (answers) => ["parsed:", ...(answers[0]?.customAnswer ?? "").split("\n")],
    submit: async () => undefined,
    cancel: async () => {
      cancelled += 1;
    },
  });
  dialog.paste(
    '{\n  "mcpServers": {\n    "docs": { "url": "https://mcp.example.com/mcp" }\n  }\n}',
  );
  dialog.handleKey("\r"); // to review
  const lines = dialog.render(70);
  assert.equal(
    lines.some((line) => line.includes("\n")),
    false,
  );
  assert.equal(lines.filter((line) => /^─+$/u.test(line)).length, 2);
  assert.ok(lines.every((line) => visibleWidth(line) <= 70));
  assert.match(lines.join("\n"), /Review answers/u);
  assert.match(lines.join("\n"), /"docs": \{ "url"/u);
  dialog.handleKey("\u001b");
  await tick();
  assert.equal(cancelled, 1);
});
