// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

// Shared terminal line input for process-host setup workflows.

import { decodeOneKey } from "./editor.ts";
import { TerminalInputBuffer } from "./input-buffer.ts";

export interface SetupInput {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  setRawMode?(mode: boolean): unknown;
}

export interface SetupOutput {
  write(data: string): unknown;
}

export class SetupAbortedError extends Error {
  constructor() {
    super("Setup aborted");
    this.name = "SetupAbortedError";
  }
}

export interface PromptOptions {
  readonly mask?: boolean;
  readonly allowEmpty?: boolean;
}

/**
 * Reads one line in raw mode through the editor's key decoder, so pasted
 * values arrive clean: bracketed-paste markers are consumed, escape sequences
 * are dropped, and pasted newlines end the line. Masked input echoes `*`;
 * Ctrl+C or Ctrl+D aborts.
 */
export function promptLine(
  input: SetupInput,
  output: SetupOutput,
  label: string,
  options: PromptOptions = {},
): Promise<string> {
  output.write(label);
  input.setRawMode?.(true);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let inputBuffer: TerminalInputBuffer | undefined;
    const done = (): void => {
      inputBuffer?.dispose();
      input.off("data", listener);
    };
    const finish = (result: string): void => {
      output.write("\n");
      done();
      resolve(result);
    };
    const processSequence = (data: string): void => {
      let index = 0;
      while (index < data.length) {
        const { key, next } = decodeOneKey(data, index);
        index = next;
        if (key.kind === "ctrl" && (key.char === "c" || key.char === "d")) {
          done();
          reject(new SetupAbortedError());
          return;
        }
        if (key.kind === "enter") {
          const result = value.trim();
          if (result.length === 0 && !options.allowEmpty) continue;
          finish(result);
          return;
        }
        if (key.kind === "backspace") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
        } else if (key.kind === "char") {
          value += key.char;
          output.write(options.mask ? "*" : key.char);
        }
        // Paste markers, arrows, and other escapes contribute nothing.
      }
    };
    const listener = (chunk: Buffer | string): void => {
      inputBuffer?.push(chunk);
    };
    inputBuffer = new TerminalInputBuffer({
      onSequence: processSequence,
      onError: (error) => {
        output.write("\n");
        done();
        reject(error);
      },
    });
    input.on("data", listener);
  });
}
