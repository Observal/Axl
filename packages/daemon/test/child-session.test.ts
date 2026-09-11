// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import { type ModelPort, ToolRegistry } from "@axl/kernel";
import { parseOperationId, parseSessionId } from "@axl/protocol";

import { type ChildStartResult, DaemonError, SessionManager } from "../src/session-manager.ts";

const model: ModelPort = {
  stream() {
    return (async function* () {
      yield { type: "text_delta" as const, text: "done" };
      yield {
        type: "completed" as const,
        stopReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    })();
  },
};

function reservation() {
  return {
    sessionId: parseSessionId(randomUUID(), "sessionId"),
    operationId: parseOperationId(randomUUID(), "operationId"),
  };
}

async function managerFixture(): Promise<{
  readonly manager: SessionManager;
  readonly cwd: string;
}> {
  const root = await mkdtemp(`${tmpdir()}/axl-child-session-`);
  const cwd = await realpath(root);
  return {
    cwd,
    manager: new SessionManager({
      dataDirectory: `${root}/state`,
      runtime: () => ({ model, tools: new ToolRegistry() }),
    }),
  };
}

test("starts an asynchronous child with durable parent and task metadata", async () => {
  const { manager, cwd } = await managerFixture();
  const parent = await manager.create(cwd);
  const childReservation = reservation();

  const child = await manager.startChild(
    parent.sessionId,
    {
      name: "researcher",
      task: "Research tmux",
      authority: "user",
      historyMode: "fresh",
      selection: {},
    },
    childReservation,
  );

  assert.equal(child.sessionId, childReservation.sessionId);
  const childRoot = child.events[0];
  assert.equal(childRoot?.type, "session.created");
  assert.deepEqual(childRoot?.type === "session.created" ? childRoot.payload : undefined, {
    cwd,
    parentSessionId: parent.sessionId,
    childName: "researcher",
    childTask: "Research tmux",
    spawnAuthority: "user",
    historyMode: "fresh",
  });

  const parentEvents = manager.subscribe(parent.sessionId, () => undefined).allEvents;
  const spawn = parentEvents.find((event) => event.type === "child.spawn_requested");
  assert.equal(
    spawn?.type === "child.spawn_requested" && spawn.payload.childSessionId,
    child.sessionId,
  );
  const childStarted = parentEvents.find((event) => event.type === "child.started");
  assert.equal(
    childStarted?.type === "child.started" && childStarted.payload.childSessionId,
    child.sessionId,
  );

  let childEvents = manager.subscribe(child.sessionId, () => undefined).allEvents;
  let updatedParentEvents = parentEvents;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    updatedParentEvents = manager.subscribe(parent.sessionId, () => undefined).allEvents;
    if (
      childEvents.some((event) => event.type === "assistant.message") &&
      updatedParentEvents.some((event) => event.type === "child.result")
    ) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    childEvents = manager.subscribe(child.sessionId, () => undefined).allEvents;
  }
  assert.ok(childEvents.some((event) => event.type === "user.message"));
  assert.ok(childEvents.some((event) => event.type === "assistant.message"));
  const childResult = updatedParentEvents.find((event) => event.type === "child.result");
  assert.equal(
    childResult?.type === "child.result" && childResult.payload.childSessionId,
    child.sessionId,
  );
  assert.equal(childResult?.type === "child.result" && childResult.payload.status, "completed");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    updatedParentEvents = manager.subscribe(parent.sessionId, () => undefined).allEvents;
    if (
      updatedParentEvents.some(
        (event) =>
          event.type === "user.message" &&
          event.payload.content.some(
            (content) =>
              content.type === "text" && content.text.includes("[Subagent result: researcher]"),
          ),
      )
    ) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(
    updatedParentEvents.some(
      (event) =>
        event.type === "user.message" &&
        event.payload.content.some(
          (content) =>
            content.type === "text" && content.text.includes("[Subagent result: researcher]"),
        ),
    ),
    true,
  );

  const summaries = await manager.list();
  const summary = summaries.find((candidate) => candidate.sessionId === child.sessionId);
  assert.equal(summary?.parentSessionId, parent.sessionId);
  assert.equal(summary?.childName, "researcher");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (manager.runtimeState(parent.sessionId).state === "idle") break;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }

  const duplicate = await manager.startChild(
    parent.sessionId,
    {
      name: "researcher",
      task: "Duplicate",
      authority: "user",
      historyMode: "fresh",
      selection: {},
    },
    reservation(),
  );
  assert.equal(duplicate.name, "researcher-2");
  const disposeOperationId = parseOperationId(randomUUID(), "operationId");
  await manager.dispose(parent.sessionId, disposeOperationId);
  assert.deepEqual(manager.runtimeState(parent.sessionId), { state: "inactive" });
  assert.deepEqual(manager.runtimeState(child.sessionId), { state: "inactive" });
  const childLog = await manager.resume(child.sessionId);
  const closed = childLog.events.findLast((event) => event.type === "session.closed");
  assert.equal(closed?.type, "session.closed");
  assert.ok(closed?.operationId);
  assert.notEqual(closed?.operationId, disposeOperationId);
  assert.equal(closed?.type === "session.closed" && closed.payload.reason, "disposed");
});

test("disposing a session does not dispose ordinary forks", async () => {
  const { manager, cwd } = await managerFixture();
  const parent = await manager.create(cwd);
  await manager.send(parent.sessionId, [{ type: "text", text: "parent turn" }]);
  const forkPoint = manager
    .subscribe(parent.sessionId, () => undefined)
    .allEvents.find((event) => event.type === "user.message");
  assert.ok(forkPoint);
  const fork = await manager.fork(parent.sessionId, forkPoint.id, reservation());

  await manager.dispose(parent.sessionId, parseOperationId(randomUUID(), "operationId"));

  assert.deepEqual(manager.runtimeState(parent.sessionId), { state: "inactive" });
  assert.notDeepEqual(manager.runtimeState(fork.sessionId), { state: "inactive" });
  const resumed = await manager.resume(fork.sessionId);
  assert.equal(
    resumed.events.some((event) => event.type === "session.closed"),
    false,
  );
  await manager.disposeAll();
});

test("bounds model-visible child result delivery while retaining the child transcript", async () => {
  const root = await mkdtemp(`${tmpdir()}/axl-child-result-bound-`);
  const cwd = await realpath(root);
  const completeText = "evidence ".repeat(12_000);
  const verboseModel: ModelPort = {
    stream() {
      return (async function* () {
        yield { type: "text_delta" as const, text: completeText };
        yield {
          type: "completed" as const,
          stopReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      })();
    },
  };
  const manager = new SessionManager({
    dataDirectory: `${root}/state`,
    runtime: ({ child }) => ({
      model: child === undefined ? model : verboseModel,
      tools: new ToolRegistry(),
    }),
  });
  try {
    const parent = await manager.create(cwd);
    const child = await manager.startChild(
      parent.sessionId,
      {
        name: "verbose",
        task: "Return detailed evidence",
        authority: "user",
        historyMode: "fresh",
        selection: {},
      },
      reservation(),
    );
    let parentEvents = manager.subscribe(parent.sessionId, () => undefined).allEvents;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (
        parentEvents.some(
          (event) =>
            event.type === "user.message" &&
            event.payload.content.some(
              (content) =>
                content.type === "text" && content.text.includes("[Subagent result: verbose]"),
            ),
        )
      ) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      parentEvents = manager.subscribe(parent.sessionId, () => undefined).allEvents;
    }
    const delivered = parentEvents.findLast(
      (event) =>
        event.type === "user.message" &&
        event.payload.content.some(
          (content) =>
            content.type === "text" && content.text.includes("[Subagent result: verbose]"),
        ),
    );
    const deliveredText =
      delivered?.type === "user.message"
        ? delivered.payload.content
            .flatMap((content) => (content.type === "text" ? [content.text] : []))
            .join("\n")
        : "";
    assert.match(deliveredText, /Subagent result truncated/u);
    assert.ok(deliveredText.length < 34_000);
    const childEvents = manager.subscribe(child.sessionId, () => undefined).allEvents;
    assert.equal(
      childEvents.some(
        (event) =>
          event.type === "assistant.message" &&
          event.payload.content.some(
            (content) => content.type === "text" && content.text === completeText,
          ),
      ),
      true,
    );
  } finally {
    await manager.disposeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("propagates bounded descendant authority through three levels", async () => {
  const { manager, cwd } = await managerFixture();
  const parent = await manager.create(cwd, { subagents: true });
  let parentSessionId = parent.sessionId;
  for (let depth = 1; depth <= 3; depth += 1) {
    const child = await manager.startChild(
      parentSessionId,
      {
        name: `level-${depth}`,
        task: `Complete level ${depth}`,
        authority: "user",
        historyMode: "fresh",
        selection: {},
      },
      reservation(),
      true,
    );
    parentSessionId = child.sessionId;
  }
  await assert.rejects(
    manager.startChild(
      parentSessionId,
      {
        name: "level-4",
        task: "Exceed the depth limit",
        authority: "user",
        historyMode: "fresh",
        selection: {},
      },
      reservation(),
      true,
    ),
    (error) => error instanceof DaemonError && /depth limit 3/u.test(error.message),
  );
  await manager.disposeAll();
});

test("serializes sibling names and enforces the direct-child limit", async () => {
  const { manager, cwd } = await managerFixture();
  const parent = await manager.create(cwd, { subagents: true });
  const children = await Promise.all(
    ["worker", "worker", "reviewer", "tester"].map((name) =>
      manager.startChild(
        parent.sessionId,
        {
          name,
          task: `Run ${name}`,
          authority: "user",
          historyMode: "fresh",
          selection: {},
        },
        reservation(),
        true,
      ),
    ),
  );
  assert.deepEqual(
    children.map((child) => child.name),
    ["worker", "worker-2", "reviewer", "tester"],
  );
  await assert.rejects(
    manager.startChild(
      parent.sessionId,
      {
        name: "fifth",
        task: "Exceed direct child limit",
        authority: "user",
        historyMode: "fresh",
        selection: {},
      },
      reservation(),
      true,
    ),
    (error) => error instanceof DaemonError && /Direct child limit 4/u.test(error.message),
  );
  await manager.disposeAll();
});

test("enforces the twelve-descendant tree limit", async () => {
  const { manager, cwd } = await managerFixture();
  const parent = await manager.create(cwd, { subagents: true });
  const children: ChildStartResult[] = [];
  for (let index = 0; index < 4; index += 1) {
    children.push(
      await manager.startChild(
        parent.sessionId,
        {
          name: `child-${index}`,
          task: `Run child ${index}`,
          authority: "user",
          historyMode: "fresh",
          selection: {},
        },
        reservation(),
        true,
      ),
    );
  }
  for (const [parentIndex, child] of children.entries()) {
    for (let index = 0; index < 2; index += 1) {
      await manager.startChild(
        child.sessionId,
        {
          name: `grandchild-${parentIndex}-${index}`,
          task: "Run grandchild",
          authority: "user",
          historyMode: "fresh",
          selection: {},
        },
        reservation(),
        true,
      );
    }
  }
  await assert.rejects(
    manager.startChild(
      children[0]?.sessionId,
      {
        name: "thirteenth",
        task: "Exceed descendant limit",
        authority: "user",
        historyMode: "fresh",
        selection: {},
      },
      reservation(),
      true,
    ),
    (error) => error instanceof DaemonError && /Descendant limit 12/u.test(error.message),
  );
  await manager.disposeAll();
});

test("a child waits for descendant results before completing to its parent", async () => {
  const root = await mkdtemp(`${tmpdir()}/axl-descendant-result-`);
  const cwd = await realpath(root);
  let releaseLead!: () => void;
  let releaseGrandchild!: () => void;
  let leadStarted!: () => void;
  let grandchildStarted!: () => void;
  const leadGate = new Promise<void>((resolve) => {
    releaseLead = resolve;
  });
  const grandchildGate = new Promise<void>((resolve) => {
    releaseGrandchild = resolve;
  });
  const leadActive = new Promise<void>((resolve) => {
    leadStarted = resolve;
  });
  const grandchildActive = new Promise<void>((resolve) => {
    grandchildStarted = resolve;
  });
  let leadCalls = 0;
  const leadModel: ModelPort = {
    stream() {
      leadCalls += 1;
      return (async function* () {
        if (leadCalls === 1) {
          leadStarted();
          await leadGate;
        }
        yield { type: "text_delta" as const, text: "lead synthesis" };
        yield {
          type: "completed" as const,
          stopReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      })();
    },
  };
  const grandchildModel: ModelPort = {
    stream() {
      return (async function* () {
        grandchildStarted();
        await grandchildGate;
        yield { type: "text_delta" as const, text: "grandchild result" };
        yield {
          type: "completed" as const,
          stopReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      })();
    },
  };
  const manager = new SessionManager({
    dataDirectory: `${root}/state`,
    runtime: ({ child }) => ({
      model: child?.name === "grandchild" ? grandchildModel : leadModel,
      tools: new ToolRegistry(),
    }),
  });
  try {
    const parent = await manager.create(cwd, { subagents: true });
    const lead = await manager.startChild(
      parent.sessionId,
      {
        name: "lead",
        task: "Coordinate descendants",
        authority: "user",
        historyMode: "fresh",
        selection: {},
      },
      reservation(),
      true,
    );
    await leadActive;
    const grandchild = await manager.startChild(
      lead.sessionId,
      {
        name: "grandchild",
        task: "Return evidence",
        authority: "user",
        historyMode: "fresh",
        selection: {},
      },
      reservation(),
      true,
    );
    await grandchildActive;
    releaseLead();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    let rootEvents = manager.subscribe(parent.sessionId, () => undefined).allEvents;
    assert.equal(
      rootEvents.some(
        (event) => event.type === "child.result" && event.payload.childSessionId === lead.sessionId,
      ),
      false,
    );
    releaseGrandchild();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      rootEvents = manager.subscribe(parent.sessionId, () => undefined).allEvents;
      if (
        rootEvents.some(
          (event) =>
            event.type === "child.result" && event.payload.childSessionId === lead.sessionId,
        )
      ) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(
      rootEvents.some(
        (event) => event.type === "child.result" && event.payload.childSessionId === lead.sessionId,
      ),
      true,
    );
    const leadEvents = manager.subscribe(lead.sessionId, () => undefined).allEvents;
    const grandchildResultIndex = leadEvents.findIndex(
      (event) =>
        event.type === "child.result" && event.payload.childSessionId === grandchild.sessionId,
    );
    const finalLeadMessageIndex = leadEvents.findLastIndex(
      (event) => event.type === "assistant.message" && event.payload.stopReason === "stop",
    );
    assert.ok(grandchildResultIndex >= 0);
    assert.ok(finalLeadMessageIndex > grandchildResultIndex);
  } finally {
    releaseLead();
    releaseGrandchild();
    await manager.disposeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("delivers a completed child into an active parent turn", async () => {
  const root = await mkdtemp(`${tmpdir()}/axl-child-delivery-`);
  const cwd = await realpath(root);
  let parentStarted!: () => void;
  let releaseParent!: () => void;
  const started = new Promise<void>((resolve) => {
    parentStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });
  const parentModel: ModelPort = {
    stream() {
      return (async function* () {
        parentStarted();
        await released;
        yield {
          type: "completed" as const,
          stopReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      })();
    },
  };
  const manager = new SessionManager({
    dataDirectory: `${root}/state`,
    runtime: ({ child }) => ({
      model: child === undefined ? parentModel : model,
      tools: new ToolRegistry(),
    }),
  });
  try {
    const parent = await manager.create(cwd);
    const parentTurn = manager.send(parent.sessionId, [{ type: "text", text: "coordinate" }]);
    await started;
    const child = await manager.startChild(
      parent.sessionId,
      {
        name: "researcher",
        task: "Research tmux",
        authority: "user",
        historyMode: "fresh",
        selection: {},
      },
      reservation(),
      true,
    );
    let parentEvents = manager.subscribe(parent.sessionId, () => undefined).allEvents;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (parentEvents.some((event) => event.type === "child.result")) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      parentEvents = manager.subscribe(parent.sessionId, () => undefined).allEvents;
    }
    assert.equal(
      parentEvents.some(
        (event) =>
          event.type === "child.result" && event.payload.childSessionId === child.sessionId,
      ),
      true,
    );
    releaseParent();
    await parentTurn;
    parentEvents = manager.subscribe(parent.sessionId, () => undefined).allEvents;
    assert.equal(
      parentEvents.some(
        (event) =>
          event.type === "user.message" &&
          event.payload.content.some(
            (content) =>
              content.type === "text" && content.text.includes("[Subagent result: researcher]"),
          ),
      ),
      true,
    );
    await manager.disposeAll();
  } finally {
    releaseParent();
    await manager.disposeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("addresses child follow-ups by stable name", async () => {
  const { manager, cwd } = await managerFixture();
  const parent = await manager.create(cwd);
  const childReservation = reservation();
  const child = await manager.startChild(
    parent.sessionId,
    {
      name: "researcher",
      task: "Research tmux",
      authority: "user",
      historyMode: "fresh",
      selection: {},
    },
    childReservation,
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (manager.runtimeState(child.sessionId).state === "idle") break;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  const result = await manager.sendToChild(
    parent.sessionId,
    "researcher",
    [{ type: "text", text: "Also inspect layouts" }],
    parseOperationId(randomUUID(), "operationId"),
  );
  assert.deepEqual(result, { queued: true, childSessionId: child.sessionId });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const events = manager.subscribe(child.sessionId, () => undefined).allEvents;
    if (
      events.some(
        (event) =>
          event.type === "user.message" &&
          event.payload.content.some(
            (content) => content.type === "text" && content.text === "Also inspect layouts",
          ),
      )
    ) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  const events = manager.subscribe(child.sessionId, () => undefined).allEvents;
  assert.equal(
    events.some(
      (event) =>
        event.type === "user.message" &&
        event.payload.content.some(
          (content) => content.type === "text" && content.text === "Also inspect layouts",
        ),
    ),
    true,
  );
  await manager.disposeAll();
});

test("interrupting a parent aborts active descendants", async () => {
  const root = await mkdtemp(`${tmpdir()}/axl-child-interrupt-`);
  const cwd = await realpath(root);
  const hangingModel: ModelPort = {
    stream(request) {
      return (async function* () {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) return resolve();
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "aborted" as const };
      })();
    },
  };
  const manager = new SessionManager({
    dataDirectory: `${root}/state`,
    runtime: () => ({ model: hangingModel, tools: new ToolRegistry() }),
  });
  try {
    const parent = await manager.create(cwd);
    const child = await manager.startChild(
      parent.sessionId,
      {
        name: "worker",
        task: "Wait until interrupted",
        authority: "user",
        historyMode: "fresh",
        selection: {},
      },
      reservation(),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (manager.runtimeState(child.sessionId).state === "running") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(manager.runtimeState(child.sessionId).state, "running");
    assert.deepEqual(manager.interrupt(parent.sessionId), { interrupted: true });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (manager.runtimeState(child.sessionId).state === "idle") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(manager.runtimeState(child.sessionId).state, "idle");
    const childEvents = manager.subscribe(child.sessionId, () => undefined).allEvents;
    assert.equal(
      childEvents.some(
        (event) => event.type === "assistant.message" && event.payload.stopReason === "aborted",
      ),
      true,
    );
  } finally {
    await manager.disposeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects child profiles that widen the parent's tool surface", async () => {
  const { manager, cwd } = await managerFixture();
  const parent = await manager.create(cwd, { profile: "minimal" });

  await assert.rejects(
    manager.startChild(
      parent.sessionId,
      {
        name: "worker",
        task: "Read the repository",
        authority: "user",
        historyMode: "fresh",
        selection: { profile: "standard" },
      },
      reservation(),
    ),
    (error) => error instanceof DaemonError && error.code === "invalid_spawn_authority",
  );
  await manager.disposeAll();
});

test("validates a child before appending its spawn event", async () => {
  const { manager, cwd } = await managerFixture();
  const parent = await manager.create(cwd, { profile: "minimal" });

  await assert.rejects(
    manager.startChild(
      parent.sessionId,
      {
        name: "worker",
        task: "Read the repository",
        authority: "user",
        historyMode: "fresh",
        selection: { profile: "standard" },
      },
      reservation(),
    ),
    (error) => error instanceof DaemonError && error.code === "invalid_spawn_authority",
  );

  const events = manager.subscribe(parent.sessionId, () => undefined).allEvents;
  assert.equal(
    events.some((event) => event.type === "child.spawn_requested"),
    false,
  );
  await manager.disposeAll();
});

test("rejects non-user spawn authority in the first child-session slice", async () => {
  const { manager, cwd } = await managerFixture();
  const parent = await manager.create(cwd);

  await assert.rejects(
    manager.startChild(
      parent.sessionId,
      {
        name: "worker",
        task: "Implement the feature",
        authority: "goal",
        historyMode: "fresh",
        selection: {},
      },
      reservation(),
    ),
    (error) => error instanceof DaemonError && error.code === "invalid_spawn_authority",
  );
  await manager.disposeAll();
});
