// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import type {
  McpServerDefinition,
  McpServerEntry,
  McpServerStatus,
  UserQuestion,
  UserQuestionAnswer,
} from "@axl/protocol";

/**
 * Shared behavior for the guided "add an MCP server" flow. Clients render
 * `MCP_ADD_SERVER_QUESTIONS` with their questionnaire UI, hand the answers
 * back here, and submit the resulting definition to the daemon. The daemon
 * still validates and probes; this module only shapes user intent.
 */

export type McpServerTransport = "remote" | "local";

export const MCP_TRANSPORT_LABELS: Readonly<Record<McpServerTransport, string>> = {
  remote: "Remote server",
  local: "Local process",
};

const NONE_LABEL = "None";

export const MCP_ADD_SERVER_QUESTIONS: readonly UserQuestion[] = [
  {
    header: "Name",
    question: "Name for this server. Letters, numbers, dots, dashes, underscores.",
    options: [],
  },
  {
    header: "Transport",
    question: "How does Axl reach the server?",
    options: [
      {
        label: MCP_TRANSPORT_LABELS.remote,
        description: "Streamable HTTP endpoint (https://…).",
      },
      {
        label: MCP_TRANSPORT_LABELS.local,
        description: "A command Axl runs inside the sandbox (npx -y …).",
      },
    ],
  },
  {
    header: "Connection",
    question: "Server URL, or the full command line for a local process.",
    options: [],
  },
  {
    header: "Secrets",
    question:
      "Headers (remote) or environment variables (local), comma-separated: NAME=API_TOKEN or NAME=Bearer ${API_TOKEN}. Values are variable names, never secrets.",
    options: [{ label: NONE_LABEL, description: "No credentials needed." }],
  },
  {
    header: "Roots",
    question: "Directories the server may access, comma-separated.",
    options: [{ label: NONE_LABEL, description: "No filesystem access." }],
  },
];

export interface McpServerDraft {
  readonly name: string;
  readonly transport: McpServerTransport;
  readonly connection: string;
  readonly secrets: string;
  readonly roots: string;
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function answerText(answers: readonly UserQuestionAnswer[], index: number): string {
  const answer = answers.find((item) => item.questionIndex === index);
  const text = answer?.customAnswer ?? answer?.selectedLabels[0] ?? "";
  return text.trim();
}

function transportFromText(text: string): McpServerTransport {
  if (text === MCP_TRANSPORT_LABELS.remote || /^(remote|http|https|url)\b/iu.test(text)) {
    return "remote";
  }
  if (text === MCP_TRANSPORT_LABELS.local || /^(local|stdio|command|process)\b/iu.test(text)) {
    return "local";
  }
  throw new Error(
    `Choose ${MCP_TRANSPORT_LABELS.remote} or ${MCP_TRANSPORT_LABELS.local} for the transport`,
  );
}

/** Maps questionnaire answers, in `MCP_ADD_SERVER_QUESTIONS` order, to a draft. */
export function mcpServerDraftFromAnswers(answers: readonly UserQuestionAnswer[]): McpServerDraft {
  const optional = (index: number): string => {
    const text = answerText(answers, index);
    return text === NONE_LABEL ? "" : text;
  };
  return {
    name: answerText(answers, 0),
    transport: transportFromText(answerText(answers, 1)),
    connection: answerText(answers, 2),
    secrets: optional(3),
    roots: optional(4),
  };
}

/** Splits a command line the way a POSIX shell would for quotes and backslashes. */
export function splitCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let started = false;
  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (quote !== undefined) throw new Error("The command line has an unterminated quote");
  if (escaped) throw new Error("The command line ends with a dangling backslash");
  if (started) tokens.push(current);
  return tokens;
}

function parsePairs(text: string, kind: "header" | "environment variable"): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split(",")) {
    const pair = raw.trim();
    if (pair === "") continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Write each ${kind} as NAME=HOST_ENV_VAR, got "${pair}"`);
    }
    const name = pair.slice(0, separator).trim();
    const source = pair.slice(separator + 1).trim();
    if (name === "") throw new Error(`Each ${kind} needs a name before "="`);
    result[name] = secretTemplate(
      source,
      `${kind} ${name}`,
      name.toLowerCase() === "authorization"
        ? "TOKEN"
        : name.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase(),
    );
  }
  return result;
}

function parseRoots(text: string): string[] {
  return text
    .split(",")
    .map((root) => root.trim())
    .filter((root) => root !== "");
}

/** Builds a daemon-ready definition. Throws a user-facing error for invalid input. */
export function mcpServerDefinitionFromDraft(draft: McpServerDraft): {
  readonly name: string;
  readonly definition: McpServerDefinition;
} {
  if (!SERVER_NAME.test(draft.name)) {
    throw new Error(
      "The server name must start with a letter or number and use only letters, numbers, dots, dashes, or underscores",
    );
  }
  const roots = parseRoots(draft.roots);
  if (draft.transport === "remote") {
    let url: URL;
    try {
      url = new URL(draft.connection);
    } catch {
      throw new Error("Enter an absolute URL such as https://mcp.example.com/mcp");
    }
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
    ) {
      throw new Error("Remote servers must use HTTPS, except loopback development servers");
    }
    if (url.username || url.password || url.hash) {
      throw new Error("The URL must not contain credentials or a fragment");
    }
    const headers = parsePairs(draft.secrets, "header");
    return {
      name: draft.name,
      definition: {
        url: url.href,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(roots.length === 0 ? {} : { roots }),
      },
    };
  }
  const [command, ...args] = splitCommandLine(draft.connection);
  if (command === undefined) throw new Error("Enter the command that starts the server");
  const env = parsePairs(draft.secrets, "environment variable");
  return {
    name: draft.name,
    definition: {
      command,
      ...(args.length === 0 ? {} : { args }),
      ...(Object.keys(env).length === 0 ? {} : { env }),
      ...(roots.length === 0 ? {} : { roots }),
    },
  };
}

/** One-line description of how a server is reached. Never includes secret values. */
export function describeMcpServerDefinition(definition: McpServerDefinition): string {
  if ("url" in definition) return definition.url;
  return [definition.command, ...(definition.args ?? [])].join(" ");
}

export function mcpServerTransport(definition: McpServerDefinition): McpServerTransport {
  return "url" in definition ? "remote" : "local";
}

export const MCP_STATUS_LABELS: Readonly<Record<McpServerStatus, string>> = {
  discovered: "discovered",
  failed: "failed",
  disabled: "disabled",
  pending: "not discovered yet",
};

export interface McpServerSummary {
  readonly total: number;
  readonly discovered: number;
  readonly failed: number;
  readonly disabled: number;
  readonly pending: number;
  readonly tools: number;
  readonly failedNames: readonly string[];
}

export function summarizeMcpServers(servers: readonly McpServerEntry[]): McpServerSummary {
  const count = (status: McpServerStatus) =>
    servers.filter((server) => server.status === status).length;
  return {
    total: servers.length,
    discovered: count("discovered"),
    failed: count("failed"),
    disabled: count("disabled"),
    pending: count("pending"),
    tools: servers.reduce((sum, server) => sum + server.tools.length, 0),
    failedNames: servers
      .filter((server) => server.status === "failed")
      .map((server) => server.name),
  };
}

/** Short status text for notices and footers, e.g. "2 servers · 6 tools · 1 failed (docs)". */
export function formatMcpServerSummary(summary: McpServerSummary): string {
  const parts = [
    `${summary.total} ${summary.total === 1 ? "server" : "servers"}`,
    `${summary.tools} ${summary.tools === 1 ? "tool" : "tools"}`,
  ];
  if (summary.failed > 0)
    parts.push(`${summary.failed} failed (${summary.failedNames.join(", ")})`);
  if (summary.disabled > 0) parts.push(`${summary.disabled} disabled`);
  if (summary.pending > 0) parts.push(`${summary.pending} pending`);
  return parts.join(" · ");
}

/** The exact configuration entry that will be written, for review before saving. */
export function mcpServerReviewLines(
  name: string,
  definition: McpServerDefinition,
  path: string,
): string[] {
  return [
    `Will be written to ${path} as:`,
    ...JSON.stringify({ [name]: definition }, null, 2).split("\n"),
  ];
}

/**
 * Quick import: paste whatever the server's README shows. Accepts a full
 * `{"mcpServers": {...}}` or `{"servers": {...}}` block, a `{name: definition}`
 * map, a bare definition, a bare URL, or a bare command line. Common host
 * fields are translated; secret placeholders must name environment variables.
 */
export const MCP_IMPORT_QUESTION: UserQuestion = {
  header: "Import",
  question:
    "Paste the mcpServers block from a README, a server URL, or a command line. Secrets must be variable names like ${API_TOKEN}, never real values.",
  options: [],
};

export interface McpImportedServer {
  readonly name: string;
  readonly definition: McpServerDefinition;
}

const RESERVED_HOST_LABELS = new Set(["mcp", "api", "www", "app", "server", "remote"]);

function sanitizeName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9_.-]+$/gu, "")
    .slice(0, 128);
  return cleaned === "" ? "mcp" : cleaned;
}

/** Derives a stable, readable server name from a definition, like `github` or `server-memory`. */
export function deriveMcpServerName(definition: McpServerDefinition): string {
  if ("url" in definition) {
    let hostname = "";
    try {
      hostname = new URL(definition.url).hostname;
    } catch {
      return "mcp";
    }
    const labels = hostname.split(".").filter((label) => label !== "");
    if (labels.length === 0) return "mcp";
    if (["localhost", "127.0.0.1"].includes(hostname) || /^\[?[0-9a-f:]+\]?$/iu.test(hostname)) {
      return "local-mcp";
    }
    const meaningful = labels.filter((label) => !RESERVED_HOST_LABELS.has(label));
    const candidate = meaningful.length >= 2 ? meaningful[meaningful.length - 2] : meaningful[0];
    return sanitizeName(candidate ?? labels[0] ?? "mcp");
  }
  const packageArg = (definition.args ?? []).find(
    (arg) => /^@?[a-z0-9][\w.-]*(\/[\w.-]+)?(@[\w.-]+)?$/iu.test(arg) && !arg.startsWith("-"),
  );
  if (
    packageArg !== undefined &&
    /^(npx|uvx|pnpx|bunx|yarn)$/u.test(definition.command.split(/[\\/]/u).pop() ?? "")
  ) {
    const withoutVersion = packageArg.replace(/@[^/@]+$/u, "");
    return sanitizeName(withoutVersion.split("/").pop() ?? withoutVersion);
  }
  return sanitizeName(definition.command.split(/[\\/]/u).pop() ?? definition.command);
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
/** Conventional environment variable names. Anything else in a secret slot is treated as a literal. */
const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;

function looksLikeSecret(text: string): boolean {
  return /[a-z]/u.test(text) && /[0-9]/u.test(text) && text.replace(/^\$/u, "").length >= 16;
}

/**
 * Normalizes a secret value into what the daemon accepts: an UPPER_CASE variable
 * name, or literal text with `${VAR}` placeholders. Other hosts' spellings are
 * mapped: `$VAR`, `${env:VAR}`, and VS Code's `${input:id}` (which becomes `${ID}`).
 * A literal token is rejected with the exact commands to run instead.
 */
export function secretTemplate(value: string, path: string, suggestedName = "TOKEN"): string {
  const trimmed = value.trim();
  if (VARIABLE_NAME.test(trimmed)) return trimmed;
  const mapped = trimmed
    .replace(
      /\$\{input:([A-Za-z0-9_.-]+)\}/gu,
      (_match, id: string) => `\${${id.replace(/[^A-Za-z0-9_]/gu, "_").toUpperCase()}}`,
    )
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu, "$${$1}")
    .replace(/\$([A-Z_][A-Z0-9_]*)(?![\w{])/gu, "$${$1}");
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u.test(mapped)) return mapped.slice(2, -1);
  if (PLACEHOLDER.test(mapped)) {
    PLACEHOLDER.lastIndex = 0;
    return mapped;
  }
  PLACEHOLDER.lastIndex = 0;
  const prefix = /^(Bearer|Basic|token)\s+/iu.exec(trimmed)?.[0] ?? "";
  const shown = looksLikeSecret(trimmed.slice(prefix.length))
    ? `${prefix}…`
    : trimmed.length > 24
      ? `${trimmed.slice(0, 24)}…`
      : trimmed;
  throw new Error(
    `${path} is a literal value ("${shown}"). Axl never stores secrets in mcp.json. Run \`export ${suggestedName}=<the token>\` before starting axl, then use "${prefix}\${${suggestedName}}" here.`,
  );
}

function suggestedVariable(path: string): string {
  // "mcpServers.github.headers.Authorization" -> GITHUB_TOKEN; "mcpServers.db.env.PGPASS" -> DB_PGPASS
  const parts = path.split(".");
  const server = parts.length >= 3 ? parts[parts.length - 3] : undefined;
  const key = parts[parts.length - 1] ?? "";
  const base =
    key.toLowerCase() === "authorization"
      ? "TOKEN"
      : key.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase();
  const prefix =
    server === undefined ? "" : `${server.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase()}_`;
  return `${prefix}${base}`;
}

function environmentSource(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return secretTemplate(value, path, suggestedVariable(path));
}

/** Environment variables a set of definitions reads. Shown so users know what to export. */
export function mcpRequiredEnvironment(
  servers: readonly { readonly definition: McpServerDefinition }[],
): readonly string[] {
  const names = new Set<string>();
  for (const { definition } of servers) {
    const values =
      "url" in definition
        ? Object.values(definition.headers ?? {})
        : Object.values(definition.env ?? {});
    for (const value of values) {
      if (VARIABLE_NAME.test(value)) names.add(value);
      else for (const match of value.matchAll(PLACEHOLDER)) names.add(match[1] as string);
    }
  }
  return [...names].sort();
}

function stringList(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
  return value as string[];
}

function translateDefinition(raw: unknown, path: string): McpServerDefinition {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path} must be an object`);
  }
  const input = raw as Record<string, unknown>;
  const type = typeof input.type === "string" ? input.type.toLowerCase() : undefined;
  if (type === "sse") {
    throw new Error(
      `${path} uses the legacy SSE transport. Axl supports Streamable HTTP; use the server's /mcp endpoint.`,
    );
  }
  const roots = stringList(input.roots, `${path}.roots`);
  const enabled = input.disabled === true ? false : input.enabled === false ? false : undefined;
  if (typeof input.url === "string") {
    const headers = Object.fromEntries(
      Object.entries(
        typeof input.headers === "object" && input.headers !== null
          ? (input.headers as Record<string, unknown>)
          : {},
      ).map(([header, value]) => [header, environmentSource(value, `${path}.headers.${header}`)]),
    );
    return {
      url: input.url,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(roots.length === 0 ? {} : { roots }),
      ...(enabled === undefined ? {} : { enabled }),
    };
  }
  if (typeof input.command === "string") {
    const env = Object.fromEntries(
      Object.entries(
        typeof input.env === "object" && input.env !== null
          ? (input.env as Record<string, unknown>)
          : {},
      ).map(([name, value]) => [name, environmentSource(value, `${path}.env.${name}`)]),
    );
    const args = stringList(input.args, `${path}.args`);
    return {
      command: input.command,
      ...(args.length === 0 ? {} : { args }),
      ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
      ...(Object.keys(env).length === 0 ? {} : { env }),
      ...(roots.length === 0 ? {} : { roots }),
      ...(enabled === undefined ? {} : { enabled }),
    };
  }
  throw new Error(`${path} needs either "url" or "command"`);
}

function looksLikeDefinition(value: Record<string, unknown>): boolean {
  return typeof value.url === "string" || typeof value.command === "string";
}

/** Parses pasted README text into named server definitions. Throws a user-facing error. */
export function parseMcpImport(text: string): McpImportedServer[] {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("Paste a JSON block, a URL, or a command line");
  if (!trimmed.startsWith("{")) {
    const definition: McpServerDefinition = /^https?:\/\//iu.test(trimmed)
      ? { url: trimmed }
      : (() => {
          const [command, ...args] = splitCommandLine(trimmed);
          if (command === undefined) throw new Error("Enter the command that starts the server");
          return { command, ...(args.length === 0 ? {} : { args }) };
        })();
    return [{ name: deriveMcpServerName(definition), definition }];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // README snippets often carry trailing commas or comments; strip the common cases once.
    try {
      parsed = JSON.parse(trimmed.replace(/\/\/[^\n"]*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"));
    } catch {
      throw new Error("That is not valid JSON. Paste the block exactly as shown in the README.");
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Paste a JSON object");
  }
  const root = parsed as Record<string, unknown>;
  if (looksLikeDefinition(root)) {
    const definition = translateDefinition(root, "server");
    return [{ name: deriveMcpServerName(definition), definition }];
  }
  const map = (root.mcpServers ?? root.servers ?? root) as unknown;
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    throw new Error('Expected an object under "mcpServers"');
  }
  const entries = Object.entries(map as Record<string, unknown>);
  if (entries.length === 0) throw new Error("The JSON block contains no servers");
  const servers = entries.map(([name, raw]) => {
    if (!SERVER_NAME.test(name)) {
      throw new Error(
        `"${name}" is not a valid server name. Use letters, numbers, dots, dashes, or underscores.`,
      );
    }
    return { name, definition: translateDefinition(raw, `mcpServers.${name}`) };
  });
  const seen = new Set<string>();
  for (const server of servers) {
    if (seen.has(server.name)) throw new Error(`Server "${server.name}" appears twice`);
    seen.add(server.name);
  }
  return servers;
}
