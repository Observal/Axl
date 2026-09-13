// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type BrowserLaunchEnvironment,
  browserLaunchCommand,
  isWindowsSubsystemForLinux,
  launchBrowser,
} from "../src/browser-launch.ts";

function environment(
  platform: NodeJS.Platform,
  osRelease: string,
  variables: Readonly<Record<string, string | undefined>> = {},
): BrowserLaunchEnvironment {
  return { platform, osRelease, variables };
}

test("browser launch selects the native opener without passing URLs through a shell", () => {
  const url = "http://127.0.0.1:43127/a/process/#token=one&session=two";
  const wsl = environment("linux", "6.6.87.2-microsoft-standard-WSL2");

  assert.equal(isWindowsSubsystemForLinux(wsl), true);
  assert.equal(
    isWindowsSubsystemForLinux(environment("linux", "6.8.0", { WSL_INTEROP: "/run/WSL/1" })),
    true,
  );
  assert.deepEqual(browserLaunchCommand(url, wsl), {
    file: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", url],
  });
  assert.deepEqual(browserLaunchCommand(url, environment("linux", "6.8.0")), {
    file: "xdg-open",
    args: [url],
  });
  assert.deepEqual(browserLaunchCommand(url, environment("darwin", "24.0.0")), {
    file: "open",
    args: [url],
  });
  assert.deepEqual(browserLaunchCommand(url, environment("win32", "10.0.0")), {
    file: "rundll32",
    args: ["url.dll,FileProtocolHandler", url],
  });
});

test("browser launch waits for opener acceptance and reports non-zero exits", async () => {
  const selected: string[] = [];
  await launchBrowser("https://example.com", {
    environment: environment("linux", "6.8.0"),
    spawn: (command, handlers) => {
      selected.push(command.file);
      handlers.exit(0, null);
    },
  });
  assert.deepEqual(selected, ["xdg-open"]);

  await assert.rejects(
    launchBrowser("https://example.com", {
      environment: environment("linux", "6.8.0"),
      spawn: (_command, handlers) => handlers.exit(3, null),
    }),
    /xdg-open exited with code 3/,
  );
});
