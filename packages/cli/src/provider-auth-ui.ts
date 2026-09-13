// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import type { AuthEvent, AuthPrompt } from "@axl/ai";
import type { TrustedProviderLoginAdapter } from "@axl/runtime";
import type { ProviderLoginPresentation } from "@axl/tui";
import { promptLine, type SetupInput, type SetupOutput, sanitizeTerminalText } from "@axl/tui";

import { type BrowserLaunchOptions, launchBrowser } from "./browser-launch.ts";

export function validatedAuthorizationUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error("Provider supplied an invalid authorization URL", { cause });
  }
  if (url.protocol !== "https:") {
    throw new Error("Provider authorization URLs must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Provider authorization URLs must not contain credentials");
  }
  return url;
}

export async function openAuthorizationUrl(
  url: URL,
  output: SetupOutput,
  options: BrowserLaunchOptions = {},
): Promise<void> {
  try {
    await launchBrowser(url.href, options);
  } catch (error) {
    output.write(
      `  Could not open the authorization URL automatically: ${safe(error instanceof Error ? error.message : String(error))}\n`,
    );
  }
}

function safe(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
}

async function answerPrompt(
  input: SetupInput,
  output: SetupOutput,
  prompt: AuthPrompt,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (prompt.type === "select") {
    output.write(`${safe(prompt.message)}\n`);
    prompt.options.forEach((option, index) => {
      const description = option.description ? `: ${safe(option.description)}` : "";
      output.write(`  ${index + 1}. ${safe(option.label)}${description}\n`);
    });
    while (true) {
      const answer = await promptLine(input, output, "  Select: ", { signal });
      const numeric = Number(answer);
      const selected = Number.isSafeInteger(numeric) ? prompt.options[numeric - 1] : undefined;
      const byId = prompt.options.find((option) => option.id === answer);
      if (selected !== undefined || byId !== undefined) return (selected ?? byId)?.id as string;
      output.write("  Choose one of the listed options.\n");
    }
  }
  return promptLine(input, output, `  ${safe(prompt.message)}: `, {
    mask: prompt.type === "secret" || prompt.type === "manual_code",
    signal:
      prompt.type === "manual_code" && prompt.signal
        ? AbortSignal.any([signal, prompt.signal])
        : signal,
    allowEmpty: prompt.type === "text",
  });
}

function presentEvent(output: SetupOutput, event: AuthEvent): void {
  if (event.type === "state") return;
  if (event.type === "auth_url") {
    const url = validatedAuthorizationUrl(event.url);
    output.write(`  ${safe(event.instructions ?? "Complete authorization in your browser.")}\n`);
    output.write(`  ${url.href}\n`);
    void openAuthorizationUrl(url, output);
    return;
  }
  if (event.type === "device_code") {
    const url = validatedAuthorizationUrl(event.verificationUri);
    output.write(`  Open ${url.href}\n  Code: ${safe(event.userCode)}\n`);
    void openAuthorizationUrl(url, output);
    return;
  }
  output.write(`  ${safe(event.message)}\n`);
  if (event.type === "info") {
    for (const link of event.links ?? []) {
      const url = validatedAuthorizationUrl(link.url);
      output.write(`  ${safe(link.label ?? "Open")}: ${url.href}\n`);
    }
  }
}

/** Keeps provider prompts and answers inside the invoking trusted process host. */
export function createTerminalProviderLoginAdapter(
  input: SetupInput,
  output: SetupOutput,
  presentation?: ProviderLoginPresentation,
): TrustedProviderLoginAdapter {
  return {
    createInteraction: ({ signal }) => {
      if (input.isTTY !== true || output.isTTY !== true) {
        throw new Error(
          "Interactive provider login requires a terminal attached to the invoking host",
        );
      }
      return {
        signal,
        prompt: (prompt) =>
          presentation === undefined
            ? answerPrompt(input, output, prompt, signal)
            : presentation.prompt({
                message: prompt.message,
                ...(prompt.type === "select"
                  ? {
                      options: prompt.options.map((option) => ({
                        value: option.id,
                        label: option.label,
                        ...(option.description === undefined
                          ? {}
                          : { description: option.description }),
                      })),
                    }
                  : {
                      ...(prompt.placeholder === undefined
                        ? {}
                        : { placeholder: prompt.placeholder }),
                      mask: prompt.type === "secret" || prompt.type === "manual_code",
                      allowEmpty: prompt.type === "text",
                      ...(prompt.type === "manual_code" && prompt.signal
                        ? { signal: prompt.signal }
                        : {}),
                    }),
              }),
        notify: (event) => {
          if (presentation === undefined) {
            presentEvent(output, event);
            return;
          }
          if (event.type === "state") return;
          // Browser opening stays in the host; only safe presentation text enters the TUI.
          const lines: string[] = [];
          presentEvent(
            {
              write: (text) => {
                lines.push(text);
                presentation.notify(lines.join("").trim());
              },
            },
            event,
          );
        },
      };
    },
  };
}
