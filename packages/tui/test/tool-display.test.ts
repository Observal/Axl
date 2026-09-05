// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { TerminalExtensionHost } from "@axl/extension-api";
import { mcpTerminalExtension } from "@axl/extension-mcp";
import { skillTerminalExtension } from "@axl/extension-skills";

import {
  PLAIN_PALETTE,
  renderShellPassthrough,
  renderToolTransaction,
  stripAnsi,
  THEMES,
  visibleWidth,
} from "../src/index.ts";

test("edit transactions render adaptive unified and split previews", () => {
  const args = {
    path: "src/app.ts",
    oldText: "const value = 1;\nreturn value;",
    newText: "const value = 2;\nreturn value;",
  };
  const unified = renderToolTransaction({
    name: "edit",
    args,
    status: "running",
    width: 80,
    mode: "compact",
    palette: PLAIN_PALETTE,
  });
  const unifiedText = unified.join("\n");
  assert.match(unifiedText, /EDIT {2}src\/app\.ts\s+running/);
  assert.ok(!unifiedText.includes("✓"));
  assert.match(unifiedText, /↳ diff \+1 -1 unified \[━{2}\]/);
  assert.match(unifiedText, /1 -│ const value = 1;/);
  assert.match(unifiedText, /1 \+│ const value = 2;/);

  const split = renderToolTransaction({
    name: "edit",
    args,
    status: "running",
    width: 140,
    mode: "compact",
    palette: PLAIN_PALETTE,
  });
  assert.match(split.join("\n"), /↳ diff \+1 -1 split \[━{2}\]/);
  assert.match(split.join("\n"), /old\s+│ new/);

  const theme = THEMES["axl-dark"];
  assert.ok(theme);
  const rich = renderToolTransaction({
    name: "edit",
    args,
    status: "running",
    width: 80,
    mode: "compact",
    palette: theme,
  });
  assert.equal(
    rich.every((line) => visibleWidth(line) <= 80),
    true,
  );
  assert.ok(
    rich[1]?.includes(theme.toolBackground?.("marker").split("marker")[0] ?? "missing background"),
  );
  assert.equal(rich.join("\n").includes("\x1b[38;2;251;73;52mconst"), true);
  assert.equal(rich[0], "");
  assert.match(stripAnsi(rich[1] ?? ""), /^ {2}EDIT .*running$/);
  assert.equal(rich[2], "");
});

test("full read results use syntax highlighting from the file path", () => {
  const palette = THEMES["axl-dark"];
  assert.ok(palette);
  const rendered = renderToolTransaction({
    name: "read",
    args: { path: "src/config.py" },
    result: 'def load(value: str):\n    return f"value={value}"',
    status: "succeeded",
    width: 80,
    mode: "full",
    palette,
  }).join("\n");
  assert.equal(rendered.includes("\x1b[38;2;251;73;52mdef"), true);
  assert.equal(rendered.includes("\x1b[38;2;184;187;38mload"), true);
  assert.match(stripAnsi(rendered), /def load\(value: str\):/);
});

test("one transaction combines lifecycle, target, duration, and bounded result", () => {
  const output = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
  const running = renderToolTransaction({
    name: "shell",
    args: { command: "pnpm test" },
    status: "running",
    width: 80,
    mode: "compact",
    palette: PLAIN_PALETTE,
  });
  assert.match(running[1] ?? "", /^ {2}SHELL\s+running$/);
  assert.match(running.join("\n"), /\$ pnpm test/);
  assert.equal(running.filter((line) => line.includes("╭")).length, 0);

  const settled = renderToolTransaction({
    name: "shell",
    args: { command: "pnpm test" },
    result: output,
    status: "succeeded",
    durationMs: 1_250,
    width: 80,
    mode: "compact",
    palette: PLAIN_PALETTE,
  });
  assert.match(settled[1] ?? "", /^ {2}SHELL\s+done \| 1\.3s$/);
  assert.match(settled.join("\n"), /\$ pnpm test/);
  assert.match(settled.join("\n"), /lines hidden · Ctrl\+O to expand/);
  assert.equal(settled.filter((line) => line.includes("╭")).length, 0);
  const firstOutput = settled.findIndex((line) => line.includes("$ pnpm test"));
  assert.equal(firstOutput > 0 && settled[firstOutput - 1] === "", true);

  const expanded = renderToolTransaction({
    name: "shell",
    args: { command: "pnpm test" },
    result: output,
    status: "succeeded",
    durationMs: 1_250,
    width: 80,
    mode: "full",
    palette: PLAIN_PALETTE,
  });
  assert.equal(expanded.length > settled.length, true);
});

test("focus mode hides routine success while retaining failures and edits", () => {
  assert.deepEqual(
    renderToolTransaction({
      name: "read",
      args: { path: "src/app.ts" },
      result: "content",
      status: "succeeded",
      width: 80,
      mode: "focus",
      palette: PLAIN_PALETTE,
    }),
    [],
  );
  const failed = renderToolTransaction({
    name: "read",
    args: { path: "missing.ts" },
    result: "not found",
    isError: true,
    status: "failed",
    width: 80,
    mode: "focus",
    palette: PLAIN_PALETTE,
  });
  assert.match(failed[1] ?? "", /^ {2}READ .*failed$/);
  assert.match(failed.join("\n"), /not found/);
});

test("first-party MCP and skill views use public renderer registrations", async () => {
  const host = new TerminalExtensionHost([mcpTerminalExtension, skillTerminalExtension]);
  await host.activate();
  const mcpRenderer = host.toolRenderer("mcp");
  const skillRenderer = host.toolRenderer("skill");
  assert.ok(mcpRenderer);
  assert.ok(skillRenderer);
  const mcp = renderToolTransaction({
    callId: "mcp-call",
    name: "mcp",
    args: { server: "docs", action: "call_tool", name: "search" },
    status: "running",
    width: 80,
    mode: "compact",
    palette: PLAIN_PALETTE,
    renderer: mcpRenderer,
  });
  const skill = renderToolTransaction({
    callId: "skill-call",
    name: "skill",
    args: { action: "load", name: "review" },
    status: "running",
    width: 80,
    mode: "compact",
    palette: PLAIN_PALETTE,
    renderer: skillRenderer,
  });
  assert.match(mcp.join("\n"), /MCP {2}docs · search/);
  assert.match(skill.join("\n"), /SKILL {2}load · review/);
  assert.equal(skill.join("\n").includes("TOOL SKILL"), false);
  const settledSkill = renderToolTransaction({
    callId: "skill-call",
    name: "skill",
    args: { action: "load", name: "review" },
    result: "a very long skill body that should stay out of compact mode",
    status: "succeeded",
    width: 80,
    mode: "compact",
    palette: PLAIN_PALETTE,
    renderer: skillRenderer,
  });
  assert.equal(settledSkill.join("\n").includes("a very long skill body"), false);
  await host.dispose();
});

test("extension tool renderers are bounded and fall back visibly on failure", () => {
  const custom = renderToolTransaction({
    callId: "call-custom",
    name: "fixture",
    args: { path: "unsafe\u001b]0;title\u0007" },
    result: "generic result",
    status: "succeeded",
    width: 48,
    mode: "compact",
    palette: PLAIN_PALETTE,
    renderer: {
      extensionId: "test.fixture",
      renderer: () => ({
        label: "CUSTOM\nINJECT\u001b]0;owned\u0007",
        target: "safe\u001b[31m target",
        lines: Array.from({ length: 30 }, (_, index) => ({
          text: `row ${index}${index === 0 ? "\nextra" : ""}`,
          tone: "accent",
        })),
      }),
    },
  });
  assert.match(custom.join("\n"), /CUSTOM INJECT {2}safe target/);
  assert.equal(custom.join("\n").includes("\u001b]0;owned"), false);
  assert.equal(
    custom.some((line) => line.includes("row 0\nextra")),
    false,
  );
  assert.match(custom.join("\n"), /extension rows hidden/);
  assert.equal(
    custom.every((line) => visibleWidth(line) <= 48),
    true,
  );

  const fallback = renderToolTransaction({
    callId: "call-broken",
    name: "read",
    args: { path: "src/app.ts" },
    result: "content",
    status: "failed",
    isError: true,
    width: 80,
    mode: "compact",
    palette: PLAIN_PALETTE,
    renderer: {
      extensionId: "test.broken",
      renderer: () => {
        throw new Error("bad renderer");
      },
    },
  });
  assert.match(fallback.join("\n"), /READ {2}src\/app\.ts/);
  assert.match(fallback.join("\n"), /renderer test\.broken failed · bad renderer/);
});

test("consecutive colored tool surfaces retain an unpainted separator", () => {
  const palette = THEMES["axl-dark"];
  assert.ok(palette);
  const first = renderToolTransaction({
    name: "read",
    args: { path: "one.ts" },
    status: "succeeded",
    width: 80,
    mode: "compact",
    palette,
  });
  const second = renderToolTransaction({
    name: "read",
    args: { path: "two.ts" },
    status: "succeeded",
    width: 80,
    mode: "compact",
    palette,
  });
  assert.equal(first[0], "");
  assert.equal(second[0], "");
  assert.notEqual(first.at(-1), "");
});

test("long tool targets remain inside the inset status surface", () => {
  const palette = THEMES["axl-dark"];
  assert.ok(palette);
  const rendered = renderToolTransaction({
    name: "shell",
    args: { command: `printf ${"value".repeat(80)}` },
    status: "failed",
    width: 40,
    mode: "compact",
    palette,
  });
  assert.equal(
    rendered.every((line) => visibleWidth(line) <= 40),
    true,
  );
  assert.match(stripAnsi(rendered[1] ?? ""), /^ {2}SHELL\s+failed$/);
  for (let width = 1; width <= 20; width += 1) {
    const narrow = renderToolTransaction({
      name: "shell",
      args: { command: "a command with a very long target" },
      result: "a result with a very long line",
      status: "failed",
      width,
      mode: "compact",
      palette,
    });
    assert.equal(
      narrow.every((line) => visibleWidth(line) <= width),
      true,
      `tool row exceeded width ${width}`,
    );
  }
});

test("user shell output stays distinct and bounded", () => {
  const rendered = renderShellPassthrough({
    command: "pwd",
    text: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"),
    isError: false,
    excluded: true,
    width: 60,
    mode: "compact",
    palette: PLAIN_PALETTE,
  });
  assert.match(rendered.join("\n"), /local only/);
  assert.match(rendered.join("\n"), /\$ pwd/);
  assert.match(rendered.join("\n"), /lines hidden/);
});

test("tool output cannot inject terminal control sequences", () => {
  const output = renderToolTransaction({
    name: "shell",
    args: { command: "echo safe" },
    result: "safe\x1b]0;owned\x07 text\x1b[31m!",
    isError: false,
    status: "succeeded",
    width: 80,
    mode: "full",
    palette: PLAIN_PALETTE,
  });
  assert.match(stripAnsi(output.join("\n")), /safe text!/);
  assert.equal(output.join("\n").includes("\x1b]0;owned"), false);
});

test("oversized inputs have character and wrapped-row bounds without changing arguments", () => {
  for (const name of ["bash", "read", "grep", "edit", "write", "custom"]) {
    const value = `BEGIN\x1b]0;owned\x07${"long input ".repeat(10_000)}END`;
    const args = { command: value, path: value, pattern: value, oldText: value, newText: value };
    const before = JSON.stringify(args);
    for (const width of [20, 80, 120]) {
      const compact = renderToolTransaction({
        name,
        args,
        status: "running",
        width,
        mode: "compact",
        palette: PLAIN_PALETTE,
      });
      const full = renderToolTransaction({
        name,
        args,
        status: "running",
        width,
        mode: "full",
        palette: PLAIN_PALETTE,
      });
      assert.ok(compact.length < 25, `${name} compact at ${width}`);
      assert.ok(full.length < 60, `${name} full at ${width}`);
      assert.ok(compact.join("").length < 2_000);
      assert.ok(full.join("").length < 8_192);
      const bodyText = (rows: readonly string[]) =>
        rows.map((row) => stripAnsi(row).replace(/^ {2}/u, "")).join("");
      assert.match(bodyText(compact), /BEGIN/);
      assert.match(bodyText(compact), /END/);
      assert.match(bodyText(compact), /chars/);
      assert.match(bodyText(compact), /Ctrl\+O/);
      assert.match(bodyText(full), /\/export/);
      for (const row of [...compact, ...full]) {
        assert.ok(visibleWidth(row) <= width);
        assert.ok(!row.includes("\x1b]0;owned"));
      }
      const failed = renderToolTransaction({
        name,
        args,
        result: value,
        isError: true,
        status: "failed",
        width,
        mode: "compact",
        palette: PLAIN_PALETTE,
      });
      assert.ok(failed.length < 40, "an error echoing the input must also stay bounded");
      assert.equal(JSON.stringify(args), before);
    }
  }
});

test("tool headers lead with the operation and keep status and duration visible", () => {
  const header =
    renderToolTransaction({
      name: "read",
      args: { path: `src/${"long-path/".repeat(30)}file.ts` },
      status: "succeeded",
      durationMs: 1234,
      width: 60,
      mode: "compact",
      palette: PLAIN_PALETTE,
    })[1] ?? "";
  assert.match(header, /^ {2}READ {2}src\//);
  assert.match(header, /done \| 1\.2s$/);
  assert.equal(visibleWidth(header), 60);
  assert.ok(!/[✓◌○■]/u.test(header));
});

test("Bash commands retain line breaks, syntax, and bounded expanded output", () => {
  const command =
    'set -eu\nexpected=\'File 1\'\nactual="$(cat file1.txt)"\ntest "$actual" = "$expected"';
  const palette = THEMES["axl-dark"];
  assert.ok(palette);
  for (const mode of ["compact", "full"] as const) {
    const rows = renderToolTransaction({
      name: "bash",
      args: { command },
      result: "ok",
      status: "succeeded",
      durationMs: 8,
      width: 80,
      mode,
      palette,
    });
    const plain = rows.map(stripAnsi);
    assert.match(plain[1] ?? "", /^ {2}BASH\s+done \| 8ms$/);
    for (const line of command.split("\n"))
      assert.ok(
        plain.some((row) => row.includes(line)),
        line,
      );
    assert.ok(!plain.some((row) => row.includes('"command":')));
    assert.ok(rows.some((row) => row.includes("expected") && row.includes("\x1b[")));
  }
  const rows = renderToolTransaction({
    name: "read",
    args: { path: "large.txt" },
    result: `${"line\n".repeat(10_000)}TAIL`,
    status: "succeeded",
    width: 80,
    mode: "full",
    palette: PLAIN_PALETTE,
  });
  assert.ok(rows.length < 215);
  assert.match(rows.join("\n"), /\/export for complete result/);
  assert.match(rows.join("\n"), /TAIL/);
});

test("full input budgets count terminal cells rather than JavaScript characters", () => {
  const rows = renderToolTransaction({
    name: "custom",
    args: { query: "界".repeat(2_000) },
    status: "running",
    width: 80,
    mode: "full",
    palette: PLAIN_PALETTE,
  });
  assert.ok(rows.length < 50);
  assert.match(rows.join("\n"), /Input preview/);
  assert.ok(rows.every((row) => visibleWidth(row) <= 80));
});
