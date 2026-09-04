// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TerminalExtensionHost, type TerminalTone } from "@axl/extension-api";

import {
  discoverPromptTemplates,
  expandPromptTemplate,
  type PromptTemplate,
  promptTemplatesExtension,
} from "../src/index.ts";

async function writeTemplate(directory: string, name: string, source: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.md`), source);
}

function template(content: string): PromptTemplate {
  return {
    name: "review",
    description: "Review a target",
    content,
    path: "/templates/review.md",
    scope: "project",
  };
}

test("discovers global prompts with project overrides", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-prompts-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const globalDirectory = join(root, "global");
  const cwd = join(root, "workspace");
  await writeTemplate(globalDirectory, "review", "Review globally.");
  await writeTemplate(globalDirectory, "summarize", "# Summarize this work");
  await writeTemplate(
    join(cwd, ".axl", "prompts"),
    "review",
    "---\ndescription: Review a selected file\nusage: <path> [focus]\n---\nReview {{1}} for {{2=correctness}}.",
  );

  const prompts = await discoverPromptTemplates({ cwd, globalDirectory });
  assert.deepEqual(
    prompts.map(({ name, scope }) => ({ name, scope })),
    [
      { name: "review", scope: "project" },
      { name: "summarize", scope: "global" },
    ],
  );
  assert.equal(prompts[0]?.description, "Review a selected file");
  assert.equal(prompts[0]?.usage, "<path> [focus]");
  assert.equal(prompts[1]?.description, "Summarize this work");
});

test("expands quoted positional arguments, all arguments, and defaults", () => {
  assert.equal(
    expandPromptTemplate(
      template("Review {{1}} for {{2=correctness}}. Inputs: {{all}}"),
      '"src/main file.ts" security',
    ),
    "Review src/main file.ts for security. Inputs: src/main file.ts security",
  );
  assert.equal(
    expandPromptTemplate(template("Review {{1}} for {{2=correctness}}."), "src/main.ts"),
    "Review src/main.ts for correctness.",
  );
  assert.throws(() => expandPromptTemplate(template("Review {{1}}."), ""), /requires argument 1/);
  assert.throws(
    () => expandPromptTemplate(template("Review {{1}}."), "one two"),
    /accepts at most 1 argument/,
  );
  assert.throws(
    () => expandPromptTemplate(template("Review {{all}}."), '"unfinished'),
    /open quote/,
  );
});

test("rejects escaped templates, invalid UTF-8, and unsupported metadata", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-prompts-invalid-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const prompts = join(cwd, ".axl", "prompts");
  const outside = join(root, "outside.md");
  await mkdir(prompts, { recursive: true });
  await writeFile(outside, "escaped");
  await symlink(outside, join(prompts, "escape.md"));
  await assert.rejects(discoverPromptTemplates({ cwd }), /escapes its discovery root/);

  await rm(join(prompts, "escape.md"));
  await writeFile(join(prompts, "invalid.md"), Buffer.from([0xff]));
  await assert.rejects(discoverPromptTemplates({ cwd }), /valid UTF-8/);

  await writeFile(join(prompts, "invalid.md"), "---\nunknown: value\n---\nbody");
  await assert.rejects(discoverPromptTemplates({ cwd }), /not a supported field/);
});

test("terminal extension expands prompts and reloads for the active workspace", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-prompts-extension-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first");
  const second = join(root, "second");
  await writeTemplate(join(first, ".axl", "prompts"), "review", "First {{1}}.");
  await writeTemplate(join(second, ".axl", "prompts"), "review", "Second {{1}}.");

  const host = new TerminalExtensionHost([promptTemplatesExtension({ cwd: first })]);
  await host.activate();
  context.after(() => host.dispose());
  const command = host.commands()[0];
  assert.equal(command?.name, "prompt");
  assert.deepEqual(command?.complete?.("rev"), ["review"]);

  let editor = "";
  const notices: Array<{ message: string; tone?: TerminalTone }> = [];
  const commandContext = {
    signal: new AbortController().signal,
    notify(message: string, tone?: Exclude<TerminalTone, "text">) {
      notices.push({ message, ...(tone === undefined ? {} : { tone }) });
    },
    async select() {
      return "review";
    },
    getEditorText: () => editor,
    setEditorText: (text: string) => {
      editor = text;
    },
  };
  await command?.run("review target", commandContext);
  assert.equal(editor, "First target.");
  assert.match(notices[0]?.message ?? "", /review it, then press Enter/);

  editor = "";
  await command?.run("", commandContext);
  assert.equal(editor, "/prompt review");

  const errors = await host.emit({
    type: "session.event",
    event: { type: "session.created", payload: { cwd: second } },
  });
  assert.deepEqual(errors, []);
  await host.commands()[0]?.run("review target", commandContext);
  assert.equal(editor, "Second target.");

  await writeTemplate(join(second, ".axl", "prompts"), "review", "Reloaded {{1}}.");
  await host.reload();
  await host.commands()[0]?.run("review target", commandContext);
  assert.equal(editor, "Reloaded target.");
});
