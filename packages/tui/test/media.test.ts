// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ConversationProjector } from "@axl/sdk";
import { parseOperationId, parseSessionId, type SessionActivityFrame } from "@axl/protocol";

import {
  detectImageMediaType,
  detectTerminalMedia,
  droppedImages,
  imageDimensions,
  LiveAssistantComponent,
  MediaCache,
  PLAIN_PALETTE,
  renderInlineImage,
  uploadBlob,
} from "../src/index.ts";

function projectActivity(
  projector: ConversationProjector,
  component: LiveAssistantComponent,
  frame: SessionActivityFrame,
): boolean {
  const changed = projector.applyActivity(frame);
  if (changed) component.replace(projector.state.activity);
  return changed;
}

function png(width = 2, height = 1): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
  bytes.set(Buffer.from("IHDR"), 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");

const blob = {
  sha256: "a".repeat(64),
  mediaType: "image/png",
  sizeBytes: 32,
  name: "pixel.png",
} as const;

test("reads pasted image paths without treating mixed text as attachments", async (context: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-media-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "pixel.png");
  await writeFile(path, png());

  const attachments = await droppedImages(path, directory);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]?.name, "pixel.png");
  assert.deepEqual(attachments[0]?.bytes, png());
  assert.deepEqual(await droppedImages(`${path}\nnot an image`, directory), []);
});

test("detects image bytes and conservative terminal protocols", () => {
  const bytes = png(12, 8);
  assert.equal(detectImageMediaType(bytes), "image/png");
  assert.deepEqual(imageDimensions(bytes, "image/png"), { width: 12, height: 8 });
  assert.deepEqual(detectTerminalMedia({ TERM_PROGRAM: "iTerm.app" }), { images: "iterm2" });
  assert.deepEqual(detectTerminalMedia({ KITTY_WINDOW_ID: "1" }), { images: "kitty" });
  assert.deepEqual(detectTerminalMedia({ KITTY_WINDOW_ID: "1", TMUX: "/tmp/tmux" }), {
    images: null,
  });
  assert.deepEqual(detectTerminalMedia({ TMUX: "/tmp/tmux", AXL_IMAGE_PROTOCOL: "kitty" }), {
    images: "kitty",
  });
});

test("renders bounded Kitty and iTerm2 images with metadata fallback", () => {
  const bytes = png();
  const kitty = renderInlineImage(bytes, blob, "kitty", 40);
  assert.equal(kitty[0]?.startsWith("\x1b_G"), true);
  assert.equal(kitty.length <= 12, true);
  const iterm = renderInlineImage(bytes, blob, "iterm2", 40);
  assert.equal(
    iterm.some((row) => row.includes("\x1b]1337;File=")),
    true,
  );
  const fallback = renderInlineImage(bytes, blob, null, 20);
  assert.match(fallback[0] ?? "", /Image · pixel\.png/);
});

test("rejects a committed blob reference that does not match the upload", async () => {
  const methods: string[] = [];
  const client = {
    request(method: string): Promise<unknown> {
      methods.push(method);
      if (method === "session.blob.start") {
        return Promise.resolve({ uploadId: "upload-1", chunkBytes: 384 * 1024 });
      }
      if (method === "session.blob.chunk") return Promise.resolve({ nextOffset: 32 });
      if (method === "session.blob.commit") return Promise.resolve(blob);
      if (method === "session.blob.abort") return Promise.resolve({ aborted: false });
      throw new Error(`Unexpected request ${method}`);
    },
  };
  await assert.rejects(
    uploadBlob(client as never, sessionId, png(), "image/png", "pixel.png"),
    /does not match the upload/,
  );
  assert.equal(methods.at(-1), "session.blob.abort");
});

test("fullscreen suppresses inline image placement", () => {
  const cache = new MediaCache(
    () => ({}) as never,
    sessionId,
    { images: "kitty" },
    () => "auto",
    () => undefined,
  );
  cache.put(blob, png());
  assert.equal(cache.rows(blob, 40, false, PLAIN_PALETTE)[0]?.startsWith("\x1b_G"), true);
  const fullscreen = cache.rows(blob, 40, true, PLAIN_PALETTE).join("\n");
  assert.equal(fullscreen.includes("\x1b_G"), false);
  assert.match(fullscreen, /Image · pixel\.png/);
});

test("live assistant ignores stale frames and clears finalized content", () => {
  const component = new LiveAssistantComponent(
    () => PLAIN_PALETTE,
    () => "show",
  );
  const operationId = parseOperationId("123e4567-e89b-42d3-a456-426614174001");
  const projector = new ConversationProjector();
  assert.equal(
    projectActivity(projector, component, {
      operationId,
      sequence: 1,
      type: "thinking_delta",
      text: "plan",
    }),
    true,
  );
  projectActivity(projector, component, {
    operationId,
    sequence: 2,
    type: "text_delta",
    text: "answer",
  });
  assert.match(component.render(40).join("\n"), /plan/);
  assert.match(component.render(40).join("\n"), /answer/);
  assert.equal(
    projectActivity(projector, component, {
      operationId,
      sequence: 1,
      type: "text_delta",
      text: "stale",
    }),
    false,
  );
  projectActivity(projector, component, { operationId, sequence: 3, type: "clear" });
  assert.deepEqual(component.render(40), []);
  assert.equal(
    projectActivity(projector, component, {
      operationId,
      sequence: 2,
      type: "text_delta",
      text: "delayed",
    }),
    false,
  );
  component.reset();
  projector.resetActivity();
  assert.equal(
    projectActivity(projector, component, {
      operationId,
      sequence: 3,
      type: "snapshot",
      text: "resumed",
      thinking: "",
      toolCalls: [],
    }),
    true,
  );
  assert.match(component.render(40).join("\n"), /resumed/);
});

test("tool-call activity waits for the canonical retained card", () => {
  const component = new LiveAssistantComponent(
    () => PLAIN_PALETTE,
    () => "compact",
  );
  const operationId = parseOperationId("123e4567-e89b-42d3-a456-426614174001");
  const projector = new ConversationProjector();
  projectActivity(projector, component, {
    operationId,
    sequence: 1,
    type: "tool_call",
    call: { callId: "call-1", name: "read" },
  });
  assert.deepEqual(component.render(80), []);
});

test("regular streaming rows stay within their viewport budget", () => {
  const component = new LiveAssistantComponent(
    () => PLAIN_PALETTE,
    () => "show",
  );
  const operationId = parseOperationId("123e4567-e89b-42d3-a456-426614174001");
  const projector = new ConversationProjector();
  projectActivity(projector, component, {
    operationId,
    sequence: 1,
    type: "text_delta",
    text: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"),
  });
  component.setMaxRows(4);
  const rows = component.render(40);
  assert.equal(rows.length, 4);
  assert.match(rows[0] ?? "", /earlier streaming output hidden/);
  assert.match(rows.at(-1) ?? "", /line 19/);
});

test("one hundred thousand deltas remain bounded and render the latest tail", () => {
  const component = new LiveAssistantComponent(
    () => PLAIN_PALETTE,
    () => "compact",
  );
  const operationId = parseOperationId("123e4567-e89b-42d3-a456-426614174001");
  const projector = new ConversationProjector();
  for (let sequence = 1; sequence <= 100_000; sequence += 1) {
    projector.applyActivity({ operationId, sequence, type: "text_delta", text: `t${sequence} ` });
  }
  component.replace(projector.state.activity);
  const rows = component.render(80);
  assert.equal(rows.join("\n").includes("t1 "), false);
  assert.equal(rows.join("\n").includes("t100000 "), true);
  assert.equal(rows.length < 10_000, true);
});
