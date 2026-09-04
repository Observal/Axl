// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

export interface MouseInput {
  readonly button: number;
  readonly column: number;
  readonly row: number;
  readonly release: boolean;
  readonly motion: boolean;
  readonly wheel: -1 | 1 | 0;
}

export type FullscreenAction =
  | "page-up"
  | "page-down"
  | "half-page-up"
  | "half-page-down"
  | "line-up"
  | "line-down"
  | "top"
  | "bottom"
  | "previous-prompt"
  | "next-prompt"
  | "search";

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR mouse reports begin with Escape
const SGR_MOUSE_PREFIX = /^\x1b\[</;
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR mouse reports begin with Escape
const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/** Returns true for a complete mouse report, including unsupported reports. */
export function isMouseReport(data: string): boolean {
  return SGR_MOUSE_PREFIX.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
}

/** Parses SGR and legacy X10 reports into zero-based terminal coordinates. */
export function parseMouseInput(data: string): MouseInput | undefined {
  const sgr = SGR_MOUSE.exec(data);
  if (sgr !== null) {
    const button = Number.parseInt(sgr[1] as string, 10);
    const direction = button & 3;
    return {
      button,
      column: Math.max(0, Number.parseInt(sgr[2] as string, 10) - 1),
      row: Math.max(0, Number.parseInt(sgr[3] as string, 10) - 1),
      release: sgr[4] === "m" || direction === 3,
      motion: (button & 32) !== 0,
      wheel: (button & 64) === 0 ? 0 : direction === 0 ? -1 : direction === 1 ? 1 : 0,
    };
  }
  if (data.length === 6 && data.startsWith("\x1b[M")) {
    const button = data.charCodeAt(3) - 32;
    const direction = button & 3;
    return {
      button,
      column: Math.max(0, data.charCodeAt(4) - 33),
      row: Math.max(0, data.charCodeAt(5) - 33),
      release: direction === 3,
      motion: (button & 32) !== 0,
      wheel: (button & 64) === 0 ? 0 : direction === 0 ? -1 : direction === 1 ? 1 : 0,
    };
  }
  return undefined;
}

/** Maps portable fullscreen shortcuts without exposing terminal bytes downstream. */
export function fullscreenAction(data: string): FullscreenAction | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Kitty keys begin with Escape
  if (/^\x1b\[102;5(?::[123])?u$/.test(data) || data === "\x1b[27;5;102~") {
    return "search";
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal function keys begin with Escape
  const page = /^\x1b\[(5|6)(?:;(\d+))?(?::[123])?~$/.exec(data);
  if (page !== null) {
    const down = page[1] === "6";
    const modifier = Number(page[2] ?? 1);
    if (modifier === 1) return down ? "page-down" : "page-up";
    if (modifier === 2) return down ? "half-page-down" : "half-page-up";
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal arrows begin with Escape
  const arrow = /^\x1b\[1;(\d+)(?::[123])?([AB])$/.exec(data);
  if (arrow !== null) {
    const down = arrow[2] === "B";
    const modifier = Number(arrow[1]);
    if (modifier === 3) return down ? "line-down" : "line-up";
    if (modifier === 6) return down ? "next-prompt" : "previous-prompt";
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal Home begins with Escape
  if (/^\x1b\[1;1(?::[123])?H$/.test(data)) return "top";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal End begins with Escape
  if (/^\x1b\[1;1(?::[123])?F$/.test(data)) return "bottom";
  switch (data) {
    case "\x1b[5~":
      return "page-up";
    case "\x1b[6~":
      return "page-down";
    case "\x1b[5$":
      return "half-page-up";
    case "\x1b[6$":
      return "half-page-down";
    case "\x1b[1;3A":
    case "\x1bp":
      return "line-up";
    case "\x1b[1;3B":
    case "\x1bn":
      return "line-down";
    case "\x1b[H":
    case "\x1bOH":
    case "\x1b[1~":
    case "\x1b[1;1H":
      return "top";
    case "\x1b[F":
    case "\x1bOF":
    case "\x1b[4~":
    case "\x1b[1;1F":
      return "bottom";
    case "\x1b[1;6A":
      return "previous-prompt";
    case "\x1b[1;6B":
      return "next-prompt";
    case "\x06":
      return "search";
    default:
      return undefined;
  }
}
