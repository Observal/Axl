// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { extensionDialog } from "../src/extension-dialog.ts";

type Listener = (event: { preventDefault(): void }) => void;

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  parent: FakeElement | undefined;
  className = "";
  textContent = "";
  type = "";
  open = false;
  private readonly fake: FakeDocument;
  constructor(fake: FakeDocument) {
    this.fake = fake;
  }
  setAttribute(): void {}
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  remove(): void {
    if (this.parent === undefined) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }
  get isConnected(): boolean {
    let node: FakeElement | undefined = this;
    while (node?.parent !== undefined) node = node.parent;
    return node === this.fake.body;
  }
  addEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  removeEventListener(name: string, listener: Listener): void {
    this.listeners.set(
      name,
      (this.listeners.get(name) ?? []).filter((entry) => entry !== listener),
    );
  }
  dispatch(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener({ preventDefault() {} });
  }
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
  }
  focus(): void {
    this.fake.activeElement = this;
  }
}

class FakeDocument {
  readonly body: FakeElement = new FakeElement(this);
  activeElement: FakeElement | null = null;
  createElement(_tag: string): FakeElement {
    return new FakeElement(this);
  }
}

function installDocument(): FakeDocument {
  const fake = new FakeDocument();
  Object.defineProperty(globalThis, "document", { value: fake, configurable: true });
  return fake;
}

test("web dialogs run cleanup when an extension completes synchronously during render", async () => {
  const fake = installDocument();
  let cleaned = 0;
  const result = await extensionDialog<string>(
    "Sync",
    new AbortController().signal,
    (_root, done) => {
      done("value");
      return () => {
        cleaned++;
      };
    },
  );
  assert.equal(result, "value");
  assert.equal(cleaned, 1);
  assert.equal(fake.body.children.length, 0);
});

test("web dialogs report an invalid cleanup value instead of masking it", async () => {
  installDocument();
  await assert.rejects(
    extensionDialog("Invalid", new AbortController().signal, () => 42 as never),
    /Web dialog cleanup must be a function/u,
  );
});

test("web dialogs close, clean up, and restore focus on abort", async () => {
  const fake = installDocument();
  const trigger = fake.createElement("button");
  fake.body.append(trigger);
  trigger.focus();
  const controller = new AbortController();
  let cleaned = 0;
  let dialog: FakeElement | undefined;
  const pending = extensionDialog<string>("Abort", controller.signal, (root) => {
    dialog = (root as unknown as FakeElement).parent;
    (root as unknown as FakeElement).focus();
    return () => {
      cleaned++;
    };
  });
  controller.abort();
  assert.equal(await pending, undefined);
  assert.equal(cleaned, 1);
  assert.equal(dialog?.open, false);
  assert.equal(dialog?.isConnected, false);
  assert.equal(fake.activeElement, trigger);
});

test("web dialogs resolve undefined on Escape cancellation", async () => {
  installDocument();
  let dialog: FakeElement | undefined;
  const pending = extensionDialog<string>("Escape", new AbortController().signal, (root) => {
    dialog = (root as unknown as FakeElement).parent;
  });
  dialog?.dispatch("cancel");
  assert.equal(await pending, undefined);
  assert.equal(dialog?.isConnected, false);
});
