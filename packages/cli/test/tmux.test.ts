// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  closeTmuxManagedPanes,
  closeTmuxPane,
  createTmuxChildPane,
  diagnoseTmux,
  focusTmuxPane,
  type TmuxCommandRunner,
} from "../src/tmux.ts";

function recordingRunner(
  responses: readonly { readonly stdout?: string; readonly error?: Error }[],
): { readonly calls: Array<readonly string[]>; readonly run: TmuxCommandRunner } {
  const calls: Array<readonly string[]> = [];
  let index = 0;
  return {
    calls,
    run: async (executable, arguments_) => {
      calls.push([executable, ...arguments_]);
      const response = responses[index++];
      if (response?.error !== undefined) throw response.error;
      return { stdout: response?.stdout ?? "", stderr: "" };
    },
  };
}

test("diagnoses and captures the active tmux server, window, and pane", async () => {
  const runner = recordingRunner([
    { stdout: "tmux 3.7c\n" },
    { stdout: "/tmp/tmux-501/default\t$1\t@3\t%7\n" },
  ]);
  const result = await diagnoseTmux(
    { TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%7" },
    runner.run,
  );
  assert.deepEqual(result, {
    installed: true,
    active: true,
    usable: true,
    version: "tmux 3.7c",
    serverSocket: "/tmp/tmux-501/default",
    sessionId: "$1",
    windowId: "@3",
    paneId: "%7",
  });
  assert.deepEqual(runner.calls, [
    ["tmux", "-V"],
    [
      "tmux",
      "display-message",
      "-p",
      "-t",
      "%7",
      "#{socket_path}\t#{session_id}\t#{window_id}\t#{pane_id}",
    ],
  ]);
});

test("does not select an installed tmux outside an active session", async () => {
  const runner = recordingRunner([{ stdout: "tmux 3.7c\n" }]);
  const result = await diagnoseTmux({}, runner.run);
  assert.equal(result.installed, true);
  assert.equal(result.active, false);
  assert.equal(result.usable, false);
  assert.equal(runner.calls.length, 1);
});

test("creates, names, focuses, and closes tmux panes with fixed argv", async () => {
  const runner = recordingRunner([
    { stdout: "@3\t%7\tparent\n" },
    { stdout: "" },
    {},
    { stdout: "%9\n" },
    {},
    {},
    {},
    {},
    {},
    { stdout: "@3\t%9\taxl:worker; touch /tmp/nope\n" },
    {},
    { stdout: "@3\t%9\taxl:worker; touch /tmp/nope\n" },
    {},
    {},
  ]);
  const pane = await createTmuxChildPane(
    {
      childSessionId: "123e4567-e89b-42d3-a456-426614174000",
      childName: "worker; touch /tmp/nope",
      cwd: "/repo with spaces",
      socketPath: "/tmp/axl socket",
      serverSocket: "/tmp/tmux-501/default",
      windowId: "@3",
      parentPaneId: "%7",
      executable: "/opt/Axl/bin/axl",
    },
    runner.run,
  );
  await focusTmuxPane(pane.paneId, "/tmp/tmux-501/default", runner.run, pane.title, "@3");
  await closeTmuxPane(pane.paneId, "/tmp/tmux-501/default", runner.run, "%7", "@3", pane.title);
  assert.deepEqual(pane, {
    multiplexer: "tmux",
    paneId: "%9",
    title: "axl:worker; touch /tmp/nope",
  });
  assert.deepEqual(runner.calls, [
    [
      "tmux",
      "-S",
      "/tmp/tmux-501/default",
      "display-message",
      "-p",
      "-t",
      "%7",
      "#{window_id}\t#{pane_id}\t#{pane_title}",
    ],
    [
      "tmux",
      "-S",
      "/tmp/tmux-501/default",
      "show-options",
      "-w",
      "-v",
      "-t",
      "@3",
      "remain-on-exit",
    ],
    ["tmux", "-S", "/tmp/tmux-501/default", "set-option", "-w", "-t", "@3", "remain-on-exit", "on"],
    [
      "tmux",
      "-S",
      "/tmp/tmux-501/default",
      "split-window",
      "-h",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      "@3",
      "-c",
      "/repo with spaces",
      "--",
      "/opt/Axl/bin/axl",
      "123e4567-e89b-42d3-a456-426614174000",
      "--socket",
      "/tmp/axl socket",
    ],
    ["tmux", "-S", "/tmp/tmux-501/default", "set-option", "-p", "-t", "%9", "remain-on-exit", "on"],
    [
      "tmux",
      "-S",
      "/tmp/tmux-501/default",
      "set-option",
      "-p",
      "-t",
      "%9",
      "@axl_child_session",
      "123e4567-e89b-42d3-a456-426614174000",
    ],
    ["tmux", "-S", "/tmp/tmux-501/default", "set-option", "-w", "-u", "-t", "@3", "remain-on-exit"],
    [
      "tmux",
      "-S",
      "/tmp/tmux-501/default",
      "select-pane",
      "-t",
      "%9",
      "-T",
      "axl:worker; touch /tmp/nope",
    ],
    ["tmux", "-S", "/tmp/tmux-501/default", "select-layout", "-t", "@3", "tiled"],
    [
      "tmux",
      "-S",
      "/tmp/tmux-501/default",
      "display-message",
      "-p",
      "-t",
      "%9",
      "#{window_id}\t#{pane_id}\t#{pane_title}",
    ],
    ["tmux", "-S", "/tmp/tmux-501/default", "select-pane", "-t", "%9"],
    [
      "tmux",
      "-S",
      "/tmp/tmux-501/default",
      "display-message",
      "-p",
      "-t",
      "%9",
      "#{window_id}\t#{pane_id}\t#{pane_title}",
    ],
    ["tmux", "-S", "/tmp/tmux-501/default", "kill-pane", "-t", "%9"],
    ["tmux", "-S", "/tmp/tmux-501/default", "select-layout", "-t", "@3", "tiled"],
  ]);
});

test("closes every verified managed pane when the parent daemon shuts down", async () => {
  const runner = recordingRunner([
    {
      stdout: [
        "%7\tparent\t",
        "%9\taxl:worker\t123e4567-e89b-42d3-a456-426614174000",
        "%10\tunrelated\t",
      ].join("\n"),
    },
    {},
    {},
  ]);
  await closeTmuxManagedPanes("/tmp/tmux-501/default", "@3", "%7", runner.run);
  assert.deepEqual(runner.calls, [
    [
      "tmux",
      "-S",
      "/tmp/tmux-501/default",
      "list-panes",
      "-t",
      "@3",
      "-F",
      "#{pane_id}\t#{pane_title}\t#{@axl_child_session}",
    ],
    ["tmux", "-S", "/tmp/tmux-501/default", "kill-pane", "-t", "%9"],
    ["tmux", "-S", "/tmp/tmux-501/default", "select-layout", "-t", "@3", "tiled"],
  ]);
});

test("refuses pane creation after the captured tmux pane moves windows", async () => {
  const runner = recordingRunner([{ stdout: "@4\t%7\tparent\n" }]);
  await assert.rejects(
    createTmuxChildPane(
      {
        childSessionId: "123e4567-e89b-42d3-a456-426614174000",
        childName: "worker",
        cwd: "/repo",
        socketPath: "/tmp/axl.sock",
        serverSocket: "/tmp/tmux-501/default",
        windowId: "@3",
        parentPaneId: "%7",
        executable: "/opt/Axl/bin/axl",
      },
      runner.run,
    ),
    /moved to another window/,
  );
  assert.equal(runner.calls.length, 1);
});

test("rejects invalid tmux pane metadata", async () => {
  const runner = recordingRunner([
    { stdout: "tmux 3.7c\n" },
    { stdout: "/tmp/tmux-501/default\t$1\t@3\tmalformed\n" },
  ]);
  const result = await diagnoseTmux(
    { TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%7" },
    runner.run,
  );
  assert.equal(result.usable, false);
  assert.match(result.reason ?? "", /invalid pane ID/);
});
