// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMcpConfigListResult,
  parseMcpConfigProbeResult,
  parseMcpServerDefinition,
  ProtocolValidationError,
} from "../src/index.ts";

const definition = { url: "https://mcp.example.com/mcp" };

test("list results carry daemon-projected discovery status per server", () => {
  const result = parseMcpConfigListResult({
    path: "/home/user/.axl/mcp.json",
    servers: [
      {
        name: "docs",
        definition,
        status: "discovered",
        tools: [{ name: "search", description: "Search docs." }],
        discoveredAt: 5,
      },
      { name: "off", definition: { ...definition, enabled: false }, status: "disabled", tools: [] },
      { name: "broken", definition, status: "failed", tools: [], error: "HTTP 404" },
      { name: "fresh", definition, status: "pending", tools: [] },
    ],
  });
  assert.deepEqual(
    result.servers.map((server) => [server.name, server.status, server.tools.length]),
    [
      ["docs", "discovered", 1],
      ["off", "disabled", 0],
      ["broken", "failed", 0],
      ["fresh", "pending", 0],
    ],
  );
  assert.equal(result.servers[2]?.error, "HTTP 404");
});

test("status-specific fields are enforced", () => {
  const base = { path: "/p", servers: [{ name: "a", definition, status: "pending", tools: [] }] };
  assert.throws(
    () =>
      parseMcpConfigListResult({
        ...base,
        servers: [{ ...base.servers[0], status: "failed" }],
      }),
    (error: unknown) =>
      error instanceof ProtocolValidationError && /error.*required/u.test(error.message),
  );
  assert.throws(
    () =>
      parseMcpConfigListResult({
        ...base,
        servers: [{ ...base.servers[0], discoveredAt: 1 }],
      }),
    (error: unknown) =>
      error instanceof ProtocolValidationError && /discoveredAt/u.test(error.message),
  );
  assert.throws(
    () =>
      parseMcpConfigListResult({
        ...base,
        servers: [{ ...base.servers[0], status: "connected" }],
      }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseMcpConfigListResult({
        ...base,
        servers: [{ ...base.servers[0], tools: [{ name: "x" }] }],
      }),
    ProtocolValidationError,
  );
});

test("probe results contain only compact tool summaries", () => {
  assert.deepEqual(
    parseMcpConfigProbeResult({
      protocolVersion: "2025-11-25",
      tools: [{ name: "a", description: "" }],
    }),
    { protocolVersion: "2025-11-25", tools: [{ name: "a", description: "" }] },
  );
  assert.throws(
    () =>
      parseMcpConfigProbeResult({
        protocolVersion: "2025-11-25",
        tools: [{ name: "a", description: "", inputSchema: {} }],
      }),
    ProtocolValidationError,
  );
  assert.equal(
    parseMcpConfigProbeResult({
      protocolVersion: "2025-11-25",
      tools: [],
      authorization: "required",
    }).authorization,
    "required",
  );
  assert.throws(
    () =>
      parseMcpConfigProbeResult({
        protocolVersion: "2025-11-25",
        tools: [],
        authorization: "maybe",
      }),
    ProtocolValidationError,
  );
});

test("server definitions still require exactly one transport", () => {
  assert.throws(
    () => parseMcpServerDefinition({ url: "https://x", command: "y" }, "d"),
    ProtocolValidationError,
  );
});
