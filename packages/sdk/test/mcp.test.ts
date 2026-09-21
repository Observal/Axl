// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { UserQuestionAnswer } from "@axl/protocol";

import {
  deriveMcpServerName,
  describeMcpServerDefinition,
  formatMcpServerSummary,
  MCP_ADD_SERVER_QUESTIONS,
  mcpServerDefinitionFromDraft,
  mcpServerDraftFromAnswers,
  mcpRequiredEnvironment,
  mcpServerReviewLines,
  parseMcpImport,
  secretTemplate,
  splitCommandLine,
  summarizeMcpServers,
} from "../src/mcp.ts";

function answers(values: readonly (string | { label: string })[]): readonly UserQuestionAnswer[] {
  return values.map((value, questionIndex) =>
    typeof value === "string"
      ? { questionIndex, selectedLabels: [], customAnswer: value }
      : { questionIndex, selectedLabels: [value.label] },
  );
}

test("the add flow asks for name, transport, connection, secrets, and roots", () => {
  assert.deepEqual(
    MCP_ADD_SERVER_QUESTIONS.map((question) => question.header),
    ["Name", "Transport", "Connection", "Secrets", "Roots"],
  );
  for (const question of MCP_ADD_SERVER_QUESTIONS) {
    assert.ok(question.header.length <= 16);
    assert.ok(question.options.length <= 4);
    assert.notEqual(question.multiSelect, true);
  }
});

test("a remote server draft becomes an HTTPS definition with header sources", () => {
  const draft = mcpServerDraftFromAnswers(
    answers([
      "github",
      { label: "Remote server" },
      "https://api.githubcopilot.com/mcp/",
      "Authorization=GITHUB_MCP_TOKEN, X-Trace=TRACE_ID",
      { label: "None" },
    ]),
  );
  assert.deepEqual(mcpServerDefinitionFromDraft(draft), {
    name: "github",
    definition: {
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "GITHUB_MCP_TOKEN", "X-Trace": "TRACE_ID" },
    },
  });
  assert.equal(
    describeMcpServerDefinition(mcpServerDefinitionFromDraft(draft).definition),
    "https://api.githubcopilot.com/mcp/",
  );
});

test("a local server draft splits the command line and maps env sources and roots", () => {
  const built = mcpServerDefinitionFromDraft(
    mcpServerDraftFromAnswers(
      answers([
        "filesystem",
        { label: "Local process" },
        'npx -y "@modelcontextprotocol/server-filesystem@2026.8.31" /work/my\\ project',
        "API_KEY=FS_API_KEY",
        "/work/my project, /tmp/scratch",
      ]),
    ),
  );
  assert.deepEqual(built, {
    name: "filesystem",
    definition: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31", "/work/my project"],
      env: { API_KEY: "FS_API_KEY" },
      roots: ["/work/my project", "/tmp/scratch"],
    },
  });
  assert.deepEqual(splitCommandLine("a 'b c' d\\ e \"f\""), ["a", "b c", "d e", "f"]);
  assert.throws(() => splitCommandLine("a 'b"), /unterminated quote/u);
});

test("invalid drafts fail with user-facing messages", () => {
  const base = {
    name: "docs",
    transport: "remote" as const,
    connection: "https://mcp.example.com/mcp",
    secrets: "",
    roots: "",
  };
  assert.throws(() => mcpServerDefinitionFromDraft({ ...base, name: "-bad" }), /server name/u);
  assert.throws(
    () => mcpServerDefinitionFromDraft({ ...base, connection: "http://example.com/mcp" }),
    /HTTPS/u,
  );
  assert.throws(
    () => mcpServerDefinitionFromDraft({ ...base, connection: "mcp.example.com" }),
    /absolute URL/u,
  );
  assert.throws(
    () => mcpServerDefinitionFromDraft({ ...base, secrets: "Authorization=Bearer abc-123" }),
    /literal value/u,
  );
  assert.deepEqual(
    mcpServerDefinitionFromDraft({
      ...base,
      secrets: "Authorization=Bearer ${GH_PAT}, X-Key=API_KEY",
    }).definition,
    {
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer ${GH_PAT}", "X-Key": "API_KEY" },
    },
  );
  assert.throws(
    () => mcpServerDefinitionFromDraft({ ...base, secrets: "Authorization" }),
    /NAME=HOST_ENV_VAR/u,
  );
  assert.throws(
    () => mcpServerDefinitionFromDraft({ ...base, transport: "local", connection: "   " }),
    /command that starts the server/u,
  );
  assert.throws(
    () => mcpServerDraftFromAnswers(answers(["x", "carrier pigeon", "u", "", ""])),
    /Remote server or Local process/u,
  );
  const loopback = mcpServerDefinitionFromDraft({
    ...base,
    connection: "http://localhost:3000/mcp",
  }).definition;
  assert.equal("url" in loopback ? loopback.url : undefined, "http://localhost:3000/mcp");
});

test("summaries count statuses and name failed servers", () => {
  const summary = summarizeMcpServers([
    {
      name: "a",
      definition: { url: "https://a.example/mcp" },
      status: "discovered",
      tools: [
        { name: "x", description: "" },
        { name: "y", description: "" },
      ],
    },
    {
      name: "b",
      definition: { url: "https://b.example/mcp" },
      status: "failed",
      tools: [],
      error: "boom",
    },
    { name: "c", definition: { command: "c", enabled: false }, status: "disabled", tools: [] },
  ]);
  assert.equal(formatMcpServerSummary(summary), "3 servers · 2 tools · 1 failed (b) · 1 disabled");
  assert.deepEqual(
    mcpServerReviewLines("a", { url: "https://a.example/mcp" }, "/h/.axl/mcp.json"),
    [
      "Will be written to /h/.axl/mcp.json as:",
      "{",
      '  "a": {',
      '    "url": "https://a.example/mcp"',
      "  }",
      "}",
    ],
  );
});

test("quick import accepts README JSON, host variants, bare URLs, and command lines", () => {
  assert.deepEqual(
    parseMcpImport(`{
      "mcpServers": {
        "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "\${GITHUB_MCP_TOKEN}" } },
        "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"], "env": { "MEMORY_FILE": "MEMORY_FILE_PATH" }, },
      }
    }`),
    [
      {
        name: "github",
        definition: {
          url: "https://api.githubcopilot.com/mcp/",
          headers: { Authorization: "GITHUB_MCP_TOKEN" },
        },
      },
      {
        name: "memory",
        definition: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-memory"],
          env: { MEMORY_FILE: "MEMORY_FILE_PATH" },
        },
      },
    ],
  );
  assert.deepEqual(
    parseMcpImport('{"servers": {"docs": {"url": "https://mcp.example.com/mcp"}}}'),
    [{ name: "docs", definition: { url: "https://mcp.example.com/mcp" } }],
  );
  assert.deepEqual(parseMcpImport("https://mcp.deepwiki.com/mcp"), [
    { name: "deepwiki", definition: { url: "https://mcp.deepwiki.com/mcp" } },
  ]);
  assert.deepEqual(
    parseMcpImport("npx -y @modelcontextprotocol/server-filesystem@2026.8.31 /work"),
    [
      {
        name: "server-filesystem",
        definition: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31", "/work"],
        },
      },
    ],
  );
  assert.deepEqual(
    parseMcpImport('{"command": "uvx", "args": ["mcp-server-git"], "disabled": true}'),
    [
      {
        name: "mcp-server-git",
        definition: { command: "uvx", args: ["mcp-server-git"], enabled: false },
      },
    ],
  );
  assert.equal(deriveMcpServerName({ url: "https://learn.microsoft.com/api/mcp" }), "microsoft");
  assert.equal(deriveMcpServerName({ url: "http://localhost:3000/mcp" }), "local-mcp");
  assert.equal(deriveMcpServerName({ command: "/opt/bin/my-server" }), "my-server");
});

test("quick import refuses literal secrets, SSE, and malformed input with clear messages", () => {
  assert.throws(
    () =>
      parseMcpImport(
        '{"mcpServers": {"gh": {"url": "https://x.example/mcp", "headers": {"Authorization": "Bearer ghp_secret"}}}}',
      ),
    /literal value/u,
  );
  assert.deepEqual(
    parseMcpImport(
      `{"servers": {"github": {"type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": {"Authorization": "Bearer \${input:github_mcp_pat}"}}}, "inputs": [{"type": "promptString", "id": "github_mcp_pat", "password": true}]}`,
    ),
    [
      {
        name: "github",
        definition: {
          url: "https://api.githubcopilot.com/mcp/",
          headers: { Authorization: "Bearer ${GITHUB_MCP_PAT}" },
        },
      },
    ],
  );
  assert.deepEqual(
    mcpRequiredEnvironment(
      parseMcpImport(
        '{"mcpServers": {"a": {"url": "https://a.example/mcp", "headers": {"Authorization": "Bearer ${GH_PAT}", "X-Key": "API_KEY"}}, "b": {"command": "x", "env": {"DSN": "pg://${DB_USER}:${DB_PASS}@h"}}}}',
      ),
    ),
    ["API_KEY", "DB_PASS", "DB_USER", "GH_PAT"],
  );
  assert.equal(secretTemplate("$TOKEN", "h"), "TOKEN");
  assert.equal(secretTemplate("${env:TOKEN}", "h"), "TOKEN");
  assert.equal(secretTemplate("Bearer $TOKEN", "h"), "Bearer ${TOKEN}");
  assert.throws(
    () =>
      parseMcpImport('{"mcpServers": {"old": {"type": "sse", "url": "https://x.example/sse"}}}'),
    /SSE/u,
  );
  assert.throws(() => parseMcpImport("{ not json"), /not valid JSON/u);
  assert.throws(() => parseMcpImport('{"mcpServers": {}}'), /contains no servers/u);
  assert.throws(
    () => parseMcpImport('{"mcpServers": {"bad name": {"url": "https://x.example/mcp"}}}'),
    /not a valid server name/u,
  );
  assert.throws(() => parseMcpImport("   "), /Paste/u);
});

test("a pasted literal token is never treated as a variable and never echoed back", () => {
  const token =
    "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";
  for (const value of [`Bearer $${token}`, `Bearer ${token}`, token, `$${token}`]) {
    try {
      parseMcpImport(
        `{"servers": {"github": {"url": "https://api.githubcopilot.com/mcp/", "headers": {"Authorization": ${JSON.stringify(value)}}}}}`,
      );
      assert.fail(`accepted literal ${value.slice(0, 12)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /literal value/u);
      assert.match(message, /export GITHUB_TOKEN=<the token>/u);
      assert.equal(message.includes("11BONASFY0A8"), false, "token leaked into the message");
    }
  }
  assert.throws(
    () =>
      mcpServerDefinitionFromDraft({
        name: "gh",
        transport: "remote",
        connection: "https://x.example/mcp",
        secrets: `Authorization=Bearer ${token}`,
        roots: "",
      }),
    /export TOKEN=<the token>.*Bearer \$\{TOKEN\}/u,
  );
  assert.equal(secretTemplate("Bearer $GITHUB_MCP_PAT", "h"), "Bearer ${GITHUB_MCP_PAT}");
  assert.equal(secretTemplate("GITHUB_MCP_PAT", "h"), "GITHUB_MCP_PAT");
  assert.throws(() => secretTemplate("github_mcp_pat", "h"), /literal value/u);
});

test("quick import strips README comments without touching URLs and trims name edges linearly", () => {
  assert.deepEqual(
    parseMcpImport(`{
      // remote server copied from the README
      "mcpServers": {
        "docs": { "url": "https://docs.example.com/mcp" } // trailing note
      }
    }`),
    [{ name: "docs", definition: { url: "https://docs.example.com/mcp" } }],
  );
  // Inputs that made the former regexes backtrack polynomially resolve quickly.
  const commas = `${",".repeat(50_000)}x`;
  assert.equal(deriveMcpServerName({ command: commas }), "x");
  const slashes = `{${"//".repeat(50_000)}\n"mcpServers": {"a": {"url": "https://a.example.com/mcp"}}}`;
  const started = Date.now();
  assert.equal(parseMcpImport(slashes)[0]?.name, "a");
  assert.ok(Date.now() - started < 2_000, "comment stripping stays linear");
});
