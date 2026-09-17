// SPDX-FileCopyrightText: 2026 Tanvi Reddy
// SPDX-License-Identifier: Apache-2.0

/**
 * Translates workspace and network policy into Chromium launch arguments.
 * Pure function: policy in, string array out.
 */

export interface BrowserLaunchPolicy {
  readonly userDataDir: string;
  readonly downloadDirectory: string;
  readonly outerSandboxActive: boolean;
  readonly proxyUrl?: string;
}

export function buildChromiumFlags(policy: BrowserLaunchPolicy): readonly string[] {
  const flags: string[] = [
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-translate",
    "--disable-default-apps",
    "--no-first-run",
    "--no-default-browser-check",
    "--metrics-recording-only",
  ];

  if (policy.outerSandboxActive) {
    flags.push("--no-sandbox");
  }

  if (policy.proxyUrl !== undefined) {
    flags.push(`--proxy-server=${policy.proxyUrl}`);
  }

  return flags;
}

export function validateNavigationUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`browser: invalid URL ${JSON.stringify(input)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("browser: URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("browser: URL credentials are not allowed");
  }
  return url;
}
