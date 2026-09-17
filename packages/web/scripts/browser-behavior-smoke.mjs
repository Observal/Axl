// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

const targetUrl = process.argv[2];
if (targetUrl === undefined) {
  throw new Error("Usage: node scripts/browser-behavior-smoke.mjs <url> [bidi-url]");
}
const bidiUrl = process.argv[3] ?? "ws://127.0.0.1:9223/session";
const socket = new WebSocket(bidiUrl);
let nextId = 1;
const pending = new Map();
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  const request = pending.get(message.id);
  if (request === undefined) return;
  pending.delete(message.id);
  if (message.type === "error") request.reject(new Error(`${message.error}: ${message.message}`));
  else request.resolve(message.result);
};
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (context, expression) => {
  const response = await call("script.evaluate", {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: "none",
  });
  if (response.result.type !== "string") throw new Error(JSON.stringify(response.result));
  return JSON.parse(response.result.value);
};
const keys = (context, ...values) => call("input.performActions", {
  context,
  actions: [{
    type: "key",
    id: "keyboard",
    actions: values.map(([type, value]) => ({ type, value })),
  }],
});
const down = (value) => ["keyDown", value];
const up = (value) => ["keyUp", value];
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const inspect = (context) => evaluate(context, `JSON.stringify({
  dialog: document.querySelector('[role=dialog]')?.getAttribute('aria-label') ?? document.querySelector('[role=dialog]')?.getAttribute('aria-labelledby') ?? null,
  active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.getAttribute('placeholder') ?? document.activeElement?.textContent?.trim().slice(0, 30) ?? null,
  composer: document.querySelector('.composer') !== null,
  modelOpen: document.querySelector('.model-picker[open]') !== null,
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  hash: location.hash,
  unlabeledButtons: [...document.querySelectorAll('button')].filter((button) => !button.textContent?.trim() && !button.getAttribute('aria-label') && button.getBoundingClientRect().width > 0).length,
  error: document.querySelector('.error-banner')?.textContent ?? ''
})`);

await call("session.new", { capabilities: {} });
const { context } = await call("browsingContext.create", { type: "tab" });
await call("browsingContext.navigate", { context, url: targetUrl, wait: "complete" });
for (let attempt = 0; attempt < 50; attempt += 1) {
  if (await evaluate(context, "JSON.stringify(document.querySelectorAll('.session').length > 0)")) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
await evaluate(context, "document.querySelector('.session')?.click(); JSON.stringify(true)");
await new Promise((resolve) => setTimeout(resolve, 500));
let state = await inspect(context);
assert(state.composer && state.hash === "" && state.overflow === 0 && !state.error, `projection: ${JSON.stringify(state)}`);
await evaluate(context, `document.querySelector('.usage-toggle')?.click(); JSON.stringify(document.querySelector('.session-usage') !== null)`);
const usageOpened = await evaluate(context, "JSON.stringify(document.querySelector('.session-usage') !== null)");
assert(usageOpened, "session usage did not open");
await evaluate(context, `document.querySelector('.thread')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); JSON.stringify(true)`);
const usageClosed = await evaluate(context, "JSON.stringify(document.querySelector('.session-usage') === null)");
assert(usageClosed, "session usage did not dismiss outside");
if (new URL(targetUrl).searchParams.get("capabilities") === "none") {
  const restricted = await evaluate(context, `JSON.stringify({
    create: { disabled: document.querySelector('[aria-label="New session"]')?.disabled, title: document.querySelector('[aria-label="New session"]')?.title },
    attach: { disabled: document.querySelector('[aria-label="Attach files"]')?.disabled, title: document.querySelector('[aria-label="Attach files"]')?.title },
    send: { disabled: document.querySelector('.composer-submit.send')?.disabled, title: document.querySelector('.composer-submit.send')?.title },
    model: { disabled: document.querySelector('.model-picker summary')?.getAttribute('aria-disabled'), title: document.querySelector('.model-picker summary')?.title },
    webTools: document.querySelector('.web-tool-config.compact summary')?.title,
    shell: document.querySelector('.shell-button') !== null,
    workspace: document.querySelector('.changes-toggle') !== null,
    manage: document.querySelector('.session-manage') !== null
  })`);
  assert(
    restricted.create.disabled && restricted.create.title &&
    restricted.attach.disabled && restricted.attach.title &&
    restricted.send.disabled && restricted.send.title &&
    restricted.model.disabled === "true" && restricted.model.title && restricted.webTools &&
    !restricted.shell && !restricted.workspace && !restricted.manage,
    `capability controls: ${JSON.stringify(restricted)}`,
  );
  console.log(JSON.stringify({ status: "passed", checks: ["missing capabilities disable or remove controls with reasons"] }));
  socket.close();
  process.exit(0);
}
await evaluate(context, "document.querySelector('[aria-label=\"New session\"]')?.click(); JSON.stringify(true)");
await new Promise((resolve) => setTimeout(resolve, 50));
state = await inspect(context);
assert(state.dialog === "new-session-title" && state.active === "Close", `dialog focus: ${JSON.stringify(state)}`);
await evaluate(context, "document.querySelector('.new-session-dialog footer button:last-child').focus(); JSON.stringify(true)");
await keys(context, down("\uE004"), up("\uE004"));
state = await inspect(context);
assert(state.active === "Close", `forward focus wrap: ${JSON.stringify(state)}`);
await keys(context, down("\uE008"), down("\uE004"), up("\uE004"), up("\uE008"));
state = await inspect(context);
assert(state.active?.startsWith("Create "), `reverse focus wrap: ${JSON.stringify(state)}`);
await keys(context, down("\uE00C"), up("\uE00C"));
await keys(context, down("\uE009"), down("k"), up("k"), up("\uE009"));
await new Promise((resolve) => setTimeout(resolve, 50));
state = await inspect(context);
assert(state.dialog === "Commands" && state.active === "Search commands", `commands: ${JSON.stringify(state)}`);
await keys(context, down("\uE00C"), up("\uE00C"));
await evaluate(context, "document.querySelector('.composer textarea').focus(); JSON.stringify(true)");
await keys(context, down("\uE009"), down("l"), up("l"), up("\uE009"));
await new Promise((resolve) => setTimeout(resolve, 50));
state = await inspect(context);
assert(state.modelOpen && state.active === "Search models", `models: ${JSON.stringify(state)}`);
await keys(context, down("\uE00C"), up("\uE00C"));
await call("browsingContext.setViewport", {
  context,
  viewport: { width: 390, height: 844 },
  devicePixelRatio: 1,
});
state = await inspect(context);
assert(state.overflow === 0 && state.unlabeledButtons === 0, `mobile: ${JSON.stringify(state)}`);
console.log(JSON.stringify({
  status: "passed",
  checks: [
    "authenticated projection",
    "fragment removal",
    "dialog focus wrapping",
    "Escape and outside-click dismissal",
    "command shortcut",
    "model shortcut",
    "desktop and mobile overflow",
    "visible button labels",
  ],
}));
socket.close();
