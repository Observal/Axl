// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { graphemeWidth } from "../src/render.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
type Cell = string | null | undefined;

/** Minimal semantic terminal for the control sequences emitted by Axl's renderers. */
export class VirtualTerminal {
  readonly width: number;
  readonly height: number;
  cursorRow = 0;
  cursorColumn = 0;
  cursorVisible = true;
  bracketedPaste = false;
  alternateScreen = false;
  keyboardProtocol = false;
  synchronized = false;
  autowrap = true;
  readonly mouseModes = new Set<number>();
  private cells: Cell[][] = [[]];

  constructor(width = 80, height = 24) {
    this.width = width;
    this.height = height;
  }

  write(data: string): void {
    for (let index = 0; index < data.length; ) {
      if (data[index] === "\x1b") {
        index += this.consumeEscape(data.slice(index));
        continue;
      }
      if (data[index] === "\n") {
        this.cursorRow += 1;
        this.ensureRow();
        index += 1;
        continue;
      }
      if (data[index] === "\r") {
        this.cursorColumn = 0;
        index += 1;
        continue;
      }

      let end = index;
      while (
        end < data.length &&
        data[end] !== "\x1b" &&
        data[end] !== "\n" &&
        data[end] !== "\r"
      ) {
        end += 1;
      }
      for (const part of segmenter.segment(data.slice(index, end)))
        this.writeGrapheme(part.segment);
      index = end;
    }
  }

  rows(): string[] {
    const rows = this.cells.map((row) =>
      row
        .filter((cell): cell is string => typeof cell === "string" && cell.length > 0)
        .join("")
        .trimEnd(),
    );
    while (rows.at(-1) === "") rows.pop();
    return rows;
  }

  private consumeEscape(value: string): number {
    if (value.startsWith("\x1b]")) return this.consumeString(value, true);
    if (value.startsWith("\x1bP") || value.startsWith("\x1b_"))
      return this.consumeString(value, false);
    if (!value.startsWith("\x1b[")) return Math.min(2, value.length);

    const match = /^([0-9;?<>]*)([A-Za-z~])/.exec(value.slice(2));
    if (!match) throw new Error("Virtual terminal received an incomplete CSI sequence");
    const parameters = match[1] ?? "";
    const final = match[2] ?? "";
    this.applyCsi(parameters, final);
    return match[0].length + 2;
  }

  private consumeString(value: string, allowBell: boolean): number {
    for (let index = 2; index < value.length; index += 1) {
      if (allowBell && value[index] === "\x07") return index + 1;
      if (value[index] === "\x1b" && value[index + 1] === "\\") return index + 2;
    }
    throw new Error("Virtual terminal received an unterminated string sequence");
  }

  private applyCsi(parameters: string, final: string): void {
    if (final === "u" && /^>\d+$/.test(parameters)) {
      this.keyboardProtocol = true;
      return;
    }
    if (final === "u" && parameters === "<") {
      this.keyboardProtocol = false;
      return;
    }
    if (
      (final === "u" && parameters === "?") ||
      (final === "c" && (parameters === "" || parameters.startsWith("?")))
    ) {
      return;
    }
    if (final === "m" || (parameters === "?2026" && (final === "h" || final === "l"))) {
      if (parameters === "?2026") this.synchronized = final === "h";
      return;
    }
    if (parameters === "?25" && (final === "h" || final === "l")) {
      this.cursorVisible = final === "h";
      return;
    }
    if (parameters === "?2004" && (final === "h" || final === "l")) {
      this.bracketedPaste = final === "h";
      return;
    }
    if (parameters === "?1049" && (final === "h" || final === "l")) {
      this.alternateScreen = final === "h";
      return;
    }
    if (parameters === "?7" && (final === "h" || final === "l")) {
      this.autowrap = final === "h";
      return;
    }
    const mouse = /^\?(1000|1002|1003|1004|1006)$/.exec(parameters);
    if (mouse !== null && (final === "h" || final === "l")) {
      const mode = Number(mouse[1]);
      if (final === "h") this.mouseModes.add(mode);
      else this.mouseModes.delete(mode);
      return;
    }
    if ((parameters === ">1" && final === "u") || (parameters === "<" && final === "u")) {
      this.keyboardProtocol = parameters === ">1";
      return;
    }

    const amount = Number.parseInt(parameters || "1", 10) || 1;
    if (final === "F") {
      this.cursorRow = Math.max(0, this.cursorRow - amount);
      this.cursorColumn = 0;
    } else if (final === "E") {
      this.cursorRow += amount;
      this.cursorColumn = 0;
      this.ensureRow();
    } else if (final === "G") {
      this.cursorColumn = Math.max(0, amount - 1);
    } else if (final === "H") {
      const [row = "1", column = "1"] = parameters.split(";");
      this.cursorRow = Math.max(0, (Number.parseInt(row, 10) || 1) - 1);
      this.cursorColumn = Math.max(0, (Number.parseInt(column, 10) || 1) - 1);
      this.ensureRow();
    } else if (final === "K" && parameters === "2") {
      this.ensureRow();
      this.cells[this.cursorRow] = [];
    } else if (final === "J" && parameters === "0") {
      this.ensureRow();
      this.cells[this.cursorRow]?.splice(this.cursorColumn);
      this.cells.length = this.cursorRow + 1;
    } else if (final === "J" && parameters === "2") {
      this.cells = [[]];
      this.cursorRow = 0;
      this.cursorColumn = 0;
    } else if (final === "J" && parameters === "3") {
      return;
    } else {
      throw new Error(
        `Virtual terminal received unsupported CSI sequence ESC[${parameters}${final}`,
      );
    }
  }

  private writeGrapheme(grapheme: string): void {
    this.ensureRow();
    const width = graphemeWidth(grapheme);
    if (width === 0) {
      const row = this.cells[this.cursorRow] as Cell[];
      for (let column = Math.min(this.cursorColumn - 1, row.length - 1); column >= 0; column -= 1) {
        if (typeof row[column] === "string" && row[column] !== "") {
          row[column] = `${row[column]}${grapheme}`;
          return;
        }
      }
      return;
    }
    if (this.cursorColumn + width > this.width) {
      this.cursorRow += 1;
      this.cursorColumn = 0;
      this.ensureRow();
    }
    const row = this.cells[this.cursorRow] as Cell[];
    row[this.cursorColumn] = grapheme;
    for (let offset = 1; offset < width; offset += 1) row[this.cursorColumn + offset] = null;
    this.cursorColumn += width;
  }

  private ensureRow(): void {
    while (this.cells.length <= this.cursorRow) this.cells.push([]);
  }
}
