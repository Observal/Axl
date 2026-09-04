// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks";

import { ConversationProjector } from "@axl/sdk";
import {
  type CanonicalEvent,
  EVENT_FORMAT_VERSION,
  parseEvent,
  parseOperationId,
  parseSessionId,
} from "@axl/protocol";

import {
  DifferentialScreen,
  EditorFrameComponent,
  LineEditor,
  LiveAssistantComponent,
  PLAIN_PALETTE,
  SessionView,
} from "../src/index.ts";

const EVENT_COUNT = 100_000;
const ASSISTANT_COUNT = 1_000;
const TOOL_COUNT = 1_000;
const WIDTHS = [40, 80, 120] as const;
const RESIZE_SAMPLE_COUNT = 20;
const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
const operationId = parseOperationId("123e4567-e89b-42d3-a456-426614174001");

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * quantile) - 1);
  return ordered[Math.min(ordered.length - 1, index)] ?? 0;
}

function envelope(index: number) {
  return {
    version: EVENT_FORMAT_VERSION,
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    sessionId,
    parentId: null,
    timestamp: index,
  } as const;
}

function event(index: number): CanonicalEvent {
  if (index < ASSISTANT_COUNT) {
    return parseEvent({
      ...envelope(index),
      type: "assistant.message",
      payload: {
        content: [{ type: "text", text: `Response ${index} with Unicode 漢字 and emoji 🛰️.` }],
        stopReason: "stop",
      },
    });
  }
  if (index < ASSISTANT_COUNT + TOOL_COUNT) {
    const call = index - ASSISTANT_COUNT;
    return parseEvent({
      ...envelope(index),
      operationId,
      type: "tool.call",
      payload: { callId: `call-${call}`, name: "read", input: { path: `src/${call}.ts` } },
    });
  }
  if (index < ASSISTANT_COUNT + TOOL_COUNT * 2) {
    const call = index - ASSISTANT_COUNT - TOOL_COUNT;
    return parseEvent({
      ...envelope(index),
      operationId,
      type: "tool.result",
      payload: {
        callId: `call-${call}`,
        name: "read",
        content: [{ type: "text", text: `settled ${call}` }],
        isError: false,
      },
    });
  }
  return parseEvent({
    ...envelope(index),
    type: "prompt.section",
    payload: { name: `fixture-${index}`, source: "benchmark", content: "" },
  });
}

const events = Array.from({ length: EVENT_COUNT }, (_, index) => event(index));

function benchmarkProjection(width: number): { milliseconds: number; rows: number } {
  const view = new SessionView(width, PLAIN_PALETTE);
  let rows = 0;
  const started = performance.now();
  for (const canonical of events) rows += view.apply(canonical).length;
  return { milliseconds: performance.now() - started, rows };
}

function benchmarkKeystrokes(width: number): number {
  const screen = new DifferentialScreen(width);
  const view = new SessionView(width, PLAIN_PALETTE);
  const editor = new LineEditor();
  const frame = new EditorFrameComponent(editor, () => view);
  frame.update({ location: "~/benchmark" });
  frame.render(width);
  screen.frame([frame], frame.cursorPlacement());
  const timings: number[] = [];
  for (let index = 0; index < 200; index += 1) {
    const started = performance.now();
    editor.insertText(String(index % 10));
    frame.invalidate();
    frame.render(width);
    screen.frame([frame], frame.cursorPlacement());
    timings.push(performance.now() - started);
  }
  return percentile(timings, 0.95);
}

function benchmarkDeltas(width: number): number {
  const component = new LiveAssistantComponent(
    () => PLAIN_PALETTE,
    () => "compact",
  );
  const timings: number[] = [];
  const projector = new ConversationProjector();
  for (let index = 1; index <= 1_000; index += 1) {
    const started = performance.now();
    projector.applyActivity({ operationId, sequence: index, type: "text_delta", text: "token " });
    component.replace(projector.state.activity);
    component.render(width);
    timings.push(performance.now() - started);
  }
  return percentile(timings, 0.95);
}

const cold = new Map(WIDTHS.map((width) => [width, benchmarkProjection(width)]));
const results = WIDTHS.map((width) => {
  const resizeSamples = Array.from(
    { length: RESIZE_SAMPLE_COUNT },
    () => benchmarkProjection(width).milliseconds,
  );
  return {
    width,
    firstFrame: cold.get(width) as { milliseconds: number; rows: number },
    resizeP95Ms: percentile(resizeSamples, 0.95),
    keystrokeP95Ms: benchmarkKeystrokes(width),
    deltaP95Ms: benchmarkDeltas(width),
  };
});

const failed = results.some(
  (result) =>
    result.firstFrame.milliseconds > 250 ||
    result.resizeP95Ms > 100 ||
    result.keystrokeP95Ms > 20 ||
    result.deltaP95Ms > 50,
);
process.stdout.write(
  `${JSON.stringify(
    {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      fixture: {
        events: EVENT_COUNT,
        assistantMessages: ASSISTANT_COUNT,
        toolCards: TOOL_COUNT,
        warmUpCount: 1,
        resizeSamples: RESIZE_SAMPLE_COUNT,
      },
      budgets: {
        firstFrameMs: 250,
        resizeP95Ms: 100,
        keystrokeP95Ms: 20,
        deltaP95Ms: 50,
      },
      results,
    },
    null,
    2,
  )}\n`,
);
if (failed) throw new Error("Terminal latency benchmark exceeded its deterministic budget");
