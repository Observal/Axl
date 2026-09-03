// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { JsonObject } from "@axl/protocol";

import {
  makeEditTool,
  makeReadTool,
  makeShellTool,
  makeWebFetchTool,
  makeWebSearchTool,
  makeWriteTool,
  requestPublicUrl,
  SandboxViolationError,
  ToolInputError,
} from "../src/index.ts";

const noSignal = new AbortController().signal;

async function workspace(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "axl-tools-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function shellIn(cwd: string, overrides: Partial<Parameters<typeof makeShellTool>[0]> = {}) {
  return makeShellTool({ cwd, overflowDirectory: join(cwd, ".overflow"), ...overrides });
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
}

test("shell runs a command and reports output and exit status", async (context) => {
  const cwd = await workspace(context);
  const shell = shellIn(cwd);

  const ok = await shell.execute({ command: "echo out; echo err >&2" }, noSignal);
  assert.equal(ok.isError, false);
  assert.match(text(ok), /out/);
  assert.match(text(ok), /err/);

  const failing = await shell.execute({ command: "exit 3" }, noSignal);
  assert.equal(failing.isError, true);
  assert.match(text(failing), /\[exit code 3\]/);

  const pwd = await shell.execute({ command: "pwd" }, noSignal);
  assert.equal(text(pwd).trim(), cwd);
});

test("shell validates input before execution", async (context) => {
  const shell = shellIn(await workspace(context));
  await assert.rejects(shell.execute({}, noSignal), ToolInputError);
  await assert.rejects(shell.execute({ command: "" }, noSignal), ToolInputError);
  await assert.rejects(shell.execute({ command: "true", nope: 1 }, noSignal), ToolInputError);
  await assert.rejects(shell.execute({ command: "true", timeoutMs: -5 }, noSignal), ToolInputError);
});

test("shell rejects a protected working directory before spawning", async (context) => {
  const cwd = await workspace(context);
  const protectedPath = join(cwd, "private");
  const shell = shellIn(cwd, {
    policy: { workspace: cwd, readableRoots: [cwd], protectedPaths: [protectedPath] },
  });
  await assert.rejects(
    shell.execute({ command: "pwd", cwd: protectedPath }, noSignal),
    SandboxViolationError,
  );
});

test("shell enforces timeouts and abort promptly", async (context) => {
  const shell = shellIn(await workspace(context));

  const timedOut = await shell.execute({ command: "sleep 30", timeoutMs: 100 }, noSignal);
  assert.equal(timedOut.isError, true);
  assert.match(text(timedOut), /timed out after 100ms/);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  const aborted = await shell.execute({ command: "sleep 30" }, controller.signal);
  assert.equal(aborted.isError, true);
  assert.match(text(aborted), /aborted after/);
  assert.equal(Date.now() - started < 5_000, true);
});

test("shell abort terminates descendant processes and never starts with a spent signal", async (context) => {
  const cwd = await workspace(context);
  const shell = shellIn(cwd);
  const spent = new AbortController();
  spent.abort();
  await assert.rejects(
    shell.execute({ command: "touch should-not-exist" }, spent.signal),
    (error) => error instanceof DOMException && error.name === "AbortError",
  );
  await assert.rejects(stat(join(cwd, "should-not-exist")), /ENOENT/);

  const abortedWhileWrapping = new AbortController();
  const wrappingShell = shellIn(cwd, {
    wrapCommand: (command) => {
      abortedWhileWrapping.abort();
      return ["bash", "-c", command];
    },
  });
  await assert.rejects(
    wrappingShell.execute(
      { command: "touch wrapped-should-not-exist" },
      abortedWhileWrapping.signal,
    ),
    (error) => error instanceof DOMException && error.name === "AbortError",
  );
  await assert.rejects(stat(join(cwd, "wrapped-should-not-exist")), /ENOENT/);

  if (process.platform === "win32") return;
  const controller = new AbortController();
  const running = shell.execute(
    { command: "sleep 30 & echo $! > child.pid; wait" },
    controller.signal,
  );
  let childPid: number | undefined;
  for (let attempt = 0; attempt < 100 && childPid === undefined; attempt += 1) {
    try {
      childPid = Number((await readFile(join(cwd, "child.pid"), "utf8")).trim());
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  }
  assert.equal(Number.isSafeInteger(childPid), true);
  controller.abort();
  const result = await running;
  assert.equal(result.isError, true);
  assert.match(text(result), /aborted after/);
  let state: string | undefined;
  try {
    const status = await readFile(`/proc/${childPid as number}/stat`, "utf8");
    state = status.split(" ")[2];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ESRCH") throw error;
  }
  assert.equal(state === undefined || state === "Z", true);
});

test("shell runs backend cleanup after success and failure", async (context) => {
  const cwd = await workspace(context);
  let cleanups = 0;
  const shell = shellIn(cwd, {
    wrapCommand: (command) => ({
      argv: ["bash", "-c", command],
      cleanup: () => {
        cleanups += 1;
        return Promise.resolve();
      },
    }),
  });
  await shell.execute({ command: "true" }, noSignal);
  await shell.execute({ command: "exit 7" }, noSignal);
  assert.equal(cleanups, 2);

  const brokenCleanup = shellIn(cwd, {
    wrapCommand: (command) => ({
      argv: ["bash", "-c", command],
      cleanup: () => Promise.reject(new Error("cleanup failed")),
    }),
  });
  await assert.rejects(brokenCleanup.execute({ command: "true" }, noSignal), /cleanup failed/);
});

test("shell truncates the model surface but preserves the complete output", async (context) => {
  const cwd = await workspace(context);
  const shell = shellIn(cwd, { maxOutputBytes: 1_000 });

  const result = await shell.execute(
    { command: 'for i in $(seq 1 500); do echo "line $i of output"; done' },
    noSignal,
  );
  assert.equal(result.isError, false);
  assert.match(text(result), /bytes truncated; complete output preserved at /);

  const details = result.details as { overflowPath: string; outputBytes: number };
  const preserved = await readFile(details.overflowPath, "utf8");
  assert.equal(preserved.split("\n").filter(Boolean).length, 500);
  assert.equal(Buffer.byteLength(preserved), details.outputBytes);
  assert.equal(Buffer.byteLength(text(result)) < 1_200, true);
});

test("read returns file content with offset, limit, and continuation notes", async (context) => {
  const cwd = await workspace(context);
  const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
  await writeFile(join(cwd, "file.txt"), `${lines.join("\n")}\n`);
  const read = makeReadTool({ cwd, maxLines: 10 });

  const first = await read.execute({ path: "file.txt" }, noSignal);
  assert.match(text(first), /^line 1\n/);
  assert.match(text(first), /\[showing lines 1-10 of 50; continue with offset 11\]/);

  const middle = await read.execute({ path: "file.txt", offset: 11, limit: 5 }, noSignal);
  assert.match(text(middle), /^line 11\n/);
  assert.match(text(middle), /lines 11-15 of 50/);

  const tail = await read.execute({ path: "file.txt", offset: 46 }, noSignal);
  assert.equal(text(tail).includes("continue with offset"), false);
});

test("read fails loudly on missing and binary files and bad input", async (context) => {
  const cwd = await workspace(context);
  await writeFile(join(cwd, "binary.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  const read = makeReadTool({ cwd });

  await assert.rejects(read.execute({ path: "missing.txt" }, noSignal), /ENOENT/);
  await assert.rejects(read.execute({ path: "binary.bin" }, noSignal), /binary file/);
  await assert.rejects(read.execute({ path: "x", offset: 0 }, noSignal), ToolInputError);
});

test("edit replaces exact text atomically and reports the count", async (context) => {
  const cwd = await workspace(context);
  const path = join(cwd, "code.ts");
  await writeFile(path, "const a = 1;\nconst b = 1;\n");
  await chmod(path, 0o640);
  const edit = makeEditTool({ cwd });

  const one = await edit.execute(
    { path: "code.ts", oldText: "const a = 1;", newText: "const a = 2;" },
    noSignal,
  );
  assert.equal(one.isError, false);
  assert.match(text(one), /Replaced 1 occurrence /);
  assert.equal(await readFile(path, "utf8"), "const a = 2;\nconst b = 1;\n");

  const all = await edit.execute(
    { path: "code.ts", oldText: "= 1;", newText: "= 3;", replaceAll: true },
    noSignal,
  );
  assert.match(text(all), /Replaced 1 occurrence/);
  assert.equal(await readFile(path, "utf8"), "const a = 2;\nconst b = 3;\n");
  assert.equal((await stat(path)).mode & 0o777, 0o640);
});

test("edit rejects misses, ambiguity, and missing files before writing", async (context) => {
  const cwd = await workspace(context);
  const path = join(cwd, "code.ts");
  const original = "x();\nx();\n";
  await writeFile(path, original);
  const edit = makeEditTool({ cwd });

  await assert.rejects(
    edit.execute({ path: "code.ts", oldText: "y();", newText: "z();" }, noSignal),
    /not found/,
  );
  await assert.rejects(
    edit.execute({ path: "code.ts", oldText: "x();", newText: "z();" }, noSignal),
    /occurs 2 times/,
  );
  await assert.rejects(
    edit.execute({ path: "gone.ts", oldText: "a", newText: "b" }, noSignal),
    /ENOENT/,
  );
  await assert.rejects(
    edit.execute({ path: "code.ts", oldText: "x();", newText: "x();" }, noSignal),
    /identical/,
  );
  assert.equal(await readFile(path, "utf8"), original); // nothing was written
});

test("write creates directories, overwrites atomically, and enforces bounds", async (context) => {
  const cwd = await workspace(context);
  const write = makeWriteTool({
    cwd,
    maxBytes: 20,
    policy: { workspace: cwd, readableRoots: [cwd], protectedPaths: [] },
  });
  const created = await write.execute({ path: "nested/file.txt", content: "hello\n" }, noSignal);
  assert.equal(created.isError, false);
  assert.equal(await readFile(join(cwd, "nested", "file.txt"), "utf8"), "hello\n");
  await write.execute({ path: "nested/file.txt", content: "replacement\n" }, noSignal);
  assert.equal(await readFile(join(cwd, "nested", "file.txt"), "utf8"), "replacement\n");
  await assert.rejects(
    write.execute({ path: "too-large.txt", content: "x".repeat(21) }, noSignal),
    /maximum is 20/,
  );
  await assert.rejects(
    write.execute({ path: "../escape.txt", content: "no" }, noSignal),
    SandboxViolationError,
  );
});

test("web_fetch returns bounded readable content", async () => {
  const tool = makeWebFetchTool({
    request: async (url) => ({
      url,
      status: 200,
      contentType: "text/html",
      body: Buffer.from(
        "<html><style>hidden</style><h1>Hello</h1><p>world &amp; friends &amp;lt;</p></html>",
      ),
    }),
  });
  const result = await tool.execute({ url: "https://example.com/page" }, noSignal);
  assert.equal(result.isError, false);
  assert.match(text(result), /Hello\s+world & friends &lt;/);
  assert.equal(text(result).includes("hidden"), false);
  assert.equal(text(result).includes("world & friends <"), false);
  const truncated = await tool.execute(
    { url: "https://example.com/page", maxCharacters: 10 },
    noSignal,
  );
  assert.match(text(truncated), /truncated at 10 characters/);
});

test("web access blocks private destinations and search uses configured credentials", async () => {
  await assert.rejects(requestPublicUrl("http://127.0.0.1/private"), /private or reserved/);
  await assert.rejects(requestPublicUrl("http://[::1]/private"), /private or reserved/);
  const keyless = makeWebSearchTool({
    request: async (url) => ({
      url,
      status: 200,
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          Heading: "Axl",
          AbstractURL: "https://example.com/axl",
          AbstractText: "Agent harness",
        }),
      ),
    }),
  });
  assert.match(text(await keyless.execute({ query: "Axl" }, noSignal)), /Agent harness/);

  let receivedToken: string | undefined;
  const search = makeWebSearchTool({
    apiKey: "obviously-fake-search-key",
    request: async (url, options) => {
      receivedToken = options?.headers?.["x-subscription-token"];
      return {
        url,
        status: 200,
        contentType: "application/json",
        body: Buffer.from(
          JSON.stringify({
            web: {
              results: [
                { title: "Axl", url: "https://example.com/axl", description: "Agent harness" },
              ],
            },
          }),
        ),
      };
    },
  });
  const result = await search.execute({ query: "Axl agent", count: 1 }, noSignal);
  assert.equal(receivedToken, "obviously-fake-search-key");
  assert.match(text(result), /Axl/);
  assert.match(text(result), /https:\/\/example.com\/axl/);
});

test("tool input objects with unknown fields are rejected across tools", async (context) => {
  const cwd = await workspace(context);
  await writeFile(join(cwd, "f.txt"), "hello\n");
  const cases: readonly [
    { execute(i: JsonObject, s: AbortSignal): Promise<unknown> },
    JsonObject,
  ][] = [
    [makeReadTool({ cwd }), { path: "f.txt", surprise: true }],
    [makeEditTool({ cwd }), { path: "f.txt", oldText: "a", newText: "b", mode: "x" }],
  ];
  for (const [tool, input] of cases) {
    await assert.rejects(tool.execute(input, noSignal), ToolInputError);
  }
});
