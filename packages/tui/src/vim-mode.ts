// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { EditorKey, LineEditor } from "./editor.ts";

export type VimMode = "normal" | "insert";

/** Small, explicit Vim command layer over the standard editor. */
export class VimModeController {
  private current: VimMode = "insert";
  private pending = "";

  get mode(): VimMode {
    return this.current;
  }

  reset(): void {
    this.current = "insert";
    this.pending = "";
  }

  handle(key: EditorKey, editor: LineEditor): boolean {
    if (this.current === "insert") {
      if (key.kind !== "escape") return false;
      this.current = "normal";
      this.pending = "";
      return true;
    }

    if (key.kind === "escape") {
      this.pending = "";
      return true;
    }
    if (key.kind === "enter" || key.kind === "follow-up" || key.kind === "tab") return false;
    if (key.kind === "ctrl" && key.char === "r") {
      editor.apply({ kind: "redo" });
      return true;
    }
    if (key.kind !== "char") return this.handleNavigation(key, editor);

    const char = key.char;
    if (this.pending === "f") {
      this.pending = "";
      editor.moveToNextCharacter(char);
      return true;
    }
    if (this.pending === "d") {
      this.pending = "";
      if (char === "d") editor.deleteCurrentLine();
      else if (char === "w") editor.deleteWordForward();
      return true;
    }
    if (char === "d" || char === "f") {
      this.pending = char;
      return true;
    }
    if (char === "/" || char === ":") {
      editor.apply({ kind: "char", char: "/" });
      this.current = "insert";
    } else if (char === "i") this.current = "insert";
    else if (char === "a") {
      editor.apply({ kind: "right" });
      this.current = "insert";
    } else if (char === "I") {
      editor.apply({ kind: "home" });
      this.current = "insert";
    } else if (char === "A") {
      editor.apply({ kind: "end" });
      this.current = "insert";
    } else if (char === "o" || char === "O") {
      editor.openLine(char === "O" ? "above" : "below");
      this.current = "insert";
    } else if (char === "h") editor.apply({ kind: "left" });
    else if (char === "j") editor.moveVerticalOnly(1);
    else if (char === "k") editor.moveVerticalOnly(-1);
    else if (char === "l") editor.apply({ kind: "right" });
    else if (char === "w") editor.apply({ kind: "word-right" });
    else if (char === "b") editor.apply({ kind: "word-left" });
    else if (char === "0") editor.apply({ kind: "home" });
    else if (char === "$") editor.apply({ kind: "end" });
    else if (char === "x") editor.apply({ kind: "delete" });
    else if (char === "u") editor.apply({ kind: "ctrl", char: "_" });
    else if (char === "p" || char === "P") editor.apply({ kind: "ctrl", char: "y" });
    return true;
  }

  private handleNavigation(key: EditorKey, editor: LineEditor): boolean {
    if (key.kind === "up" || key.kind === "down") {
      editor.moveVerticalOnly(key.kind === "up" ? -1 : 1);
      return true;
    }
    if (key.kind === "left" || key.kind === "right") {
      editor.apply(key);
      return true;
    }
    if (
      key.kind === "home" ||
      key.kind === "end" ||
      key.kind === "word-left" ||
      key.kind === "word-right"
    ) {
      editor.apply(key);
      return true;
    }
    return true;
  }
}
