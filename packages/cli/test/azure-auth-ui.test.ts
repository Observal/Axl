// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { FileCredentialStore, type AuthContext } from "@axl/ai";
import { promptLine, SetupAbortedError } from "@axl/tui";

import { azureLoginDialog, runAzureSetup } from "../src/azure-auth-ui.ts";

const context: AuthContext = { env: () => undefined, fileExists: () => Promise.resolve(false) };
const okFetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

function makeIo(): { input: PassThrough; output: PassThrough; text: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return { input, output, text: () => text };
}

/** Feed keystrokes after the prompt has attached its listener. */
function type(input: PassThrough, keys: string): void {
  setTimeout(() => input.write(keys), 5);
}

test("promptLine reads a line with backspace editing", async () => {
  const { input, output, text } = makeIo();
  type(input, "helXX\x7f\x7flo\r");
  assert.equal(await promptLine(input, output, "name: "), "hello");
  assert.match(text(), /^name: /);
});

test("masked input never echoes the secret", async () => {
  const { input, output, text } = makeIo();
  type(input, "super-secret-key\r");
  const value = await promptLine(input, output, "key: ", { mask: true });
  assert.equal(value, "super-secret-key");
  assert.equal(text().includes("super-secret"), false);
  assert.match(text(), /\*{16}/);
});

test("empty input is refused unless allowed, and Ctrl+C aborts", async () => {
  const { input, output } = makeIo();
  type(input, "\r\rvalue\r");
  assert.equal(await promptLine(input, output, "> "), "value");

  const aborted = makeIo();
  type(aborted.input, "\x03");
  await assert.rejects(promptLine(aborted.input, aborted.output, "> "), SetupAbortedError);

  const optional = makeIo();
  type(optional.input, "\r");
  assert.equal(await promptLine(optional.input, optional.output, "> ", { allowEmpty: true }), "");
});

test("Azure login dialog definition verifies and stores credentials", async (testContext) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-login-dialog-"));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileCredentialStore(join(directory, "credentials.json"));
  const definition = await azureLoginDialog(store, context, okFetch);

  assert.equal(definition.title, "Login to Azure OpenAI");
  assert.deepEqual(
    await definition.submit({
      key: "dialog-key",
      endpoint: "https://myres.openai.azure.com/",
      deploymentMap: "gpt-5=my-deploy",
    }),
    { ok: true, summary: "✓ credentials verified with Azure" },
  );
  const stored = await store.read("azure-openai");
  assert.equal(stored?.type === "api_key" && stored.key, "dialog-key");
});

test("full setup stores a verified credential without leaking the key", async (testContext: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-setup-"));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileCredentialStore(join(directory, "credentials.json"));
  const { input, output, text } = makeIo();

  // key → invalid URL → valid URL → deployment map
  type(input, "test-api-key-value\r");
  setTimeout(() => input.write("not a url\r"), 40);
  setTimeout(() => input.write("https://myres.openai.azure.com/\r"), 80);
  setTimeout(() => input.write("gpt-5=my-deploy\r"), 120);

  await runAzureSetup(input, output, store, context, okFetch);

  assert.match(text(), /not a valid URL/);
  assert.match(text(), /Credentials verified with Azure/);
  assert.equal(text().includes("test-api-key-value"), false);

  const stored = await store.read("azure-openai");
  assert.equal(stored?.type === "api_key" && stored.key, "test-api-key-value");
  if (stored?.type === "api_key") {
    assert.equal(stored.env?.AZURE_OPENAI_BASE_URL, "https://myres.openai.azure.com/openai/v1");
    assert.equal(stored.env?.AZURE_OPENAI_DEPLOYMENT_NAME_MAP, "gpt-5=my-deploy");
  }
});

test("setup without a deployment map skips the env entry", async (testContext: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-setup-"));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileCredentialStore(join(directory, "credentials.json"));
  const { input, output } = makeIo();

  type(input, "another-key\r");
  setTimeout(() => input.write("https://myres.services.ai.azure.com/\r"), 40);
  setTimeout(() => input.write("\r"), 80);

  await runAzureSetup(input, output, store, context, okFetch);
  const stored = await store.read("azure-openai");
  if (stored?.type === "api_key") {
    assert.equal(stored.env?.AZURE_OPENAI_DEPLOYMENT_NAME_MAP, undefined);
    assert.equal(
      stored.env?.AZURE_OPENAI_BASE_URL,
      "https://myres.services.ai.azure.com/openai/v1",
    );
  } else {
    assert.fail("credential not stored");
  }
});

test("pasted keys arrive clean: bracketed-paste markers and whitespace stripped", async (testContext: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-setup-"));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileCredentialStore(join(directory, "credentials.json"));
  const { input, output, text } = makeIo();

  // A terminal paste wraps the key in \x1b[200~ … \x1b[201~ and may carry a newline.
  type(input, "\x1b[200~pasted-key-value \x1b[201~\r");
  setTimeout(() => input.write("https://myres.openai.azure.com/\r"), 40);
  setTimeout(() => input.write("\r"), 80);

  await runAzureSetup(input, output, store, context, okFetch);
  const stored = await store.read("azure-openai");
  assert.equal(stored?.type === "api_key" && stored.key, "pasted-key-value");
  assert.equal(text().includes("[200~"), false);
});

test("a rejected key re-prompts and only real acceptance says verified", async (testContext: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-setup-"));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileCredentialStore(join(directory, "credentials.json"));
  const { input, output, text } = makeIo();
  let calls = 0;
  const flapFetch = (async () => {
    calls += 1;
    return calls === 1
      ? new Response('{"error":{"code":"401"}}', { status: 401 })
      : new Response("{}", { status: 200 });
  }) as typeof fetch;

  // Attempt 1: bad key → 401 → re-prompt. Attempt 2: good key → verified.
  type(input, "bad-key\r");
  setTimeout(() => input.write("https://myres.openai.azure.com/\r"), 40);
  setTimeout(() => input.write("\r"), 80);
  setTimeout(() => input.write("good-key\r"), 200);
  setTimeout(() => input.write("https://myres.openai.azure.com/\r"), 240);
  setTimeout(() => input.write("\r"), 280);

  await runAzureSetup(input, output, store, context, flapFetch);
  assert.match(text(), /rejected the credentials \(HTTP 401\)/);
  assert.match(text(), /Credentials verified with Azure/);
  const stored = await store.read("azure-openai");
  assert.equal(stored?.type === "api_key" && stored.key, "good-key");
});
