// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import type { UserQuestion, UserQuestionAnswer } from "@axl/protocol";

import { dialogInnerWidth, renderDialog } from "./dialog.ts";
import { decodeOneKey } from "./editor.ts";
import type { Overlay } from "./overlay.ts";
import { sanitizeTerminalText, truncateToWidth, visibleWidth, wrapLine } from "./render.ts";
import type { Palette } from "./transcript.ts";

interface QuestionnaireOptions {
  readonly questions: readonly UserQuestion[];
  readonly palette: () => Palette;
  readonly refresh: () => void;
  readonly submit: (answers: readonly UserQuestionAnswer[]) => Promise<void>;
  readonly cancel: () => Promise<void>;
  /** Optional dialog title; model questionnaires render without one. */
  readonly title?: string;
  /** Extra review-step lines derived from the answers, e.g. the exact effect of submitting. */
  readonly review?: (answers: readonly UserQuestionAnswer[]) => readonly string[];
  /** Footer shown while `submit` is running. */
  readonly pendingLabel?: string;
  readonly submitLabel?: string;
}

export class QuestionnaireOverlay implements Overlay {
  private readonly options: QuestionnaireOptions;
  private readonly answers: UserQuestionAnswer[];
  private step = 0;
  private option = 0;
  private editingCustom = false;
  private customValue = "";
  private error: string | undefined;
  private pending = false;
  private position: { row: number; column: number } | undefined;

  constructor(options: QuestionnaireOptions) {
    this.options = options;
    this.answers = options.questions.map((_, questionIndex) => ({
      questionIndex,
      selectedLabels: [],
    }));
    this.enterStep();
  }

  render(width: number): string[] {
    const palette = this.options.palette();
    const inner = dialogInnerWidth(width);
    const reviewing = this.step === this.options.questions.length;
    const rows = [this.navigation(inner, palette), ""];
    this.position = undefined;

    if (reviewing) {
      rows.push(palette.accent((palette.bold ?? ((text) => text))("Review answers")), "");
      for (const [index, question] of this.options.questions.entries()) {
        const answer = this.answers[index];
        rows.push(`${palette.dim(`${index + 1}.`)} ${sanitizeTerminalText(question.header)}`);
        const echoed =
          [...(answer?.selectedLabels ?? []), answer?.customAnswer]
            .flatMap((value) => (value === undefined ? [] : [sanitizeTerminalText(value)]))
            .join(", ")
            .replace(/\s+/gu, " ")
            .trim() || "(unanswered)";
        rows.push(`   ${palette.dim(truncateToWidth(echoed, Math.max(8, inner - 3), "…"))}`);
      }
      const review = this.options.review?.(this.answers) ?? [];
      if (review.length > 0) {
        rows.push("");
        for (const line of review) rows.push(...wrapLine(sanitizeTerminalText(line), inner));
      }
      if (this.error) rows.push("", palette.error(this.error));
      return renderDialog({
        title: this.options.title ?? "",
        rows,
        footer: this.pending
          ? (this.options.pendingLabel ?? "Submitting…")
          : `Enter to ${this.options.submitLabel ?? "submit"} · ←/Tab to edit · Esc to cancel`,
        width,
        palette,
      });
    }

    const question = this.options.questions[this.step];
    if (question === undefined) return [];
    rows.push(
      ...wrapLine(
        palette.accent((palette.bold ?? ((text) => text))(sanitizeTerminalText(question.question))),
        inner,
      ),
      "",
    );
    const answer = this.answers[this.step] as UserQuestionAnswer;
    const itemCount = question.options.length + 1;
    this.option = Math.min(this.option, itemCount - 1);
    for (const [index, choice] of question.options.entries()) {
      const selected = answer.selectedLabels.includes(choice.label);
      rows.push(
        this.optionLine(
          index,
          choice.label,
          question.multiSelect === true
            ? selected
              ? palette.accent("[✓]")
              : palette.dim("[ ]")
            : undefined,
          inner,
          palette,
        ),
      );
      rows.push(...this.descriptionLines(choice.description, inner, palette));
    }
    if (question.options.length > 0) {
      rows.push(
        this.optionLine(
          question.options.length,
          "Type something.",
          question.multiSelect === true
            ? answer.customAnswer === undefined
              ? palette.dim("[ ]")
              : palette.accent("[✓]")
            : undefined,
          inner,
          palette,
        ),
      );
    }

    let promptRow: number | undefined;
    let promptWidth = 0;
    if (this.editingCustom) {
      // Pasted text may contain newlines; show a single-line tail so the caret stays visible.
      const value = this.customValue.replace(/\s+/gu, " ");
      const available = Math.max(1, inner - 2);
      const shown =
        visibleWidth(value) <= available
          ? value
          : `…${value.slice(Math.max(0, value.length - (available - 1)))}`;
      const prompt = `> ${shown}`;
      if (question.options.length > 0) rows.push("");
      rows.push(prompt);
      promptRow = rows.length - 1;
      promptWidth = visibleWidth(prompt);
    } else {
      const preview = question.options[this.option]?.preview;
      if (preview) {
        rows.push(
          "",
          ...sanitizeTerminalText(preview)
            .split("\n")
            .flatMap((line) => wrapLine(palette.dim(line), inner)),
        );
      }
    }
    if (this.error) rows.push("", palette.error(this.error));
    const rendered = renderDialog({
      title: this.options.title ?? "",
      rows,
      footer: this.editingCustom
        ? question.options.length === 0
          ? "Enter to continue · Tab/Arrow keys to navigate · Esc to cancel"
          : "Enter to save · Esc to go back"
        : "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
      width,
      palette,
    });
    if (promptRow !== undefined) {
      // Locate the prompt in the final output so title rows and wrapping cannot skew the caret.
      const marker = `  ${rows[promptRow] ?? ""}`;
      const row = rendered.indexOf(marker);
      if (row >= 0) this.position = { row, column: 2 + promptWidth };
    }
    return rendered;
  }

  cursor(): { row: number; column: number } | undefined {
    return this.position;
  }

  paste(text: string): void {
    if (!this.editingCustom || this.pending) return;
    this.customValue += sanitizeTerminalText(text).slice(
      0,
      Math.max(0, 4_000 - this.customValue.length),
    );
    this.options.refresh();
  }

  handleKey(data: string): void {
    if (this.pending) return;
    for (let at = 0; at < data.length; ) {
      const decoded = decodeOneKey(data, at);
      at = decoded.next;
      const key = decoded.key;
      if (this.editingCustom) {
        const textOnly = (this.options.questions[this.step]?.options.length ?? 0) === 0;
        if (key.kind === "escape") {
          if (textOnly) {
            void this.cancel();
            return;
          }
          this.editingCustom = false;
          this.customValue = "";
        } else if (textOnly && (key.kind === "tab" || key.kind === "right")) {
          this.saveCustom(false);
          this.moveStep(1);
        } else if (textOnly && (key.kind === "shift-tab" || key.kind === "left")) {
          this.saveCustom(false);
          this.moveStep(-1);
        } else if (key.kind === "enter") {
          this.saveCustom();
        } else if (key.kind === "backspace") {
          const segments = [...new Intl.Segmenter().segment(this.customValue)];
          this.customValue = this.customValue.slice(0, segments.at(-1)?.index ?? 0);
        } else if (key.kind === "char" && this.customValue.length < 4_000) {
          this.customValue += sanitizeTerminalText(key.char);
        }
        this.options.refresh();
        continue;
      }
      if (key.kind === "escape" || (key.kind === "ctrl" && key.char === "c")) {
        void this.cancel();
        return;
      }
      if (key.kind === "tab" || key.kind === "right") {
        this.moveStep(1);
      } else if (key.kind === "shift-tab" || key.kind === "left") {
        this.moveStep(-1);
      } else if (this.step < this.options.questions.length) {
        const count = (this.options.questions[this.step]?.options.length ?? 0) + 1;
        if (key.kind === "up") this.option = (this.option - 1 + count) % count;
        else if (key.kind === "down") this.option = (this.option + 1) % count;
        else if (key.kind === "enter") this.select();
        else if (key.kind === "char" && /^[1-9]$/.test(key.char) && Number(key.char) <= count) {
          this.option = Number(key.char) - 1;
          this.select();
        }
      } else if (key.kind === "enter") {
        void this.submit();
        return;
      }
      this.options.refresh();
    }
  }

  private navigation(width: number, palette: Palette): string {
    const tabs = this.options.questions.map((question, index) => {
      const answer = this.answers[index];
      const answered =
        (answer?.selectedLabels.length ?? 0) > 0 || answer?.customAnswer !== undefined;
      const text = `${answered ? "☒" : "☐"} ${sanitizeTerminalText(question.header)}`;
      return index === this.step ? (palette.selection ?? palette.accent)(` ${text} `) : text;
    });
    const submit =
      this.step === this.options.questions.length
        ? (palette.selection ?? palette.accent)(" ✓ Submit ")
        : "✓ Submit";
    return truncateToWidth(`←  ${[...tabs, submit].join("   ")}  →`, width, "");
  }

  private optionLine(
    index: number,
    label: string,
    marker: string | undefined,
    width: number,
    palette: Palette,
  ): string {
    const pointer = index === this.option ? palette.accent("›") : " ";
    const number = palette.dim(`${index + 1}.`);
    const text = `${pointer} ${number} ${marker === undefined ? "" : `${marker} `}${sanitizeTerminalText(label)}`;
    return index === this.option
      ? (palette.bold ?? ((value) => value))(truncateToWidth(text, width, ""))
      : truncateToWidth(text, width, "");
  }

  private descriptionLines(description: string, width: number, palette: Palette): string[] {
    return wrapLine(sanitizeTerminalText(description), Math.max(1, width - 5)).map(
      (line) => `     ${palette.dim(line)}`,
    );
  }

  private moveStep(offset: number): void {
    this.step =
      (this.step + offset + this.options.questions.length + 1) %
      (this.options.questions.length + 1);
    this.option = 0;
    this.error = undefined;
    this.enterStep();
  }

  /** Questions without options go straight to text entry. */
  private enterStep(): void {
    const question = this.options.questions[this.step];
    if (question !== undefined && question.options.length === 0) {
      this.editingCustom = true;
      this.customValue = this.answers[this.step]?.customAnswer ?? "";
    } else {
      this.editingCustom = false;
      this.customValue = "";
    }
  }

  private select(): void {
    const question = this.options.questions[this.step];
    const answer = this.answers[this.step];
    if (question === undefined || answer === undefined) return;
    const choice = question.options[this.option];
    if (choice === undefined) {
      this.editingCustom = true;
      this.customValue = answer.customAnswer ?? "";
      return;
    }
    if (question.multiSelect === true) {
      const selected = new Set(answer.selectedLabels);
      if (selected.has(choice.label)) selected.delete(choice.label);
      else selected.add(choice.label);
      this.answers[this.step] = { ...answer, selectedLabels: [...selected] };
      return;
    }
    this.answers[this.step] = { questionIndex: this.step, selectedLabels: [choice.label] };
    this.moveStep(1);
  }

  private saveCustom(advance = true): void {
    const value = this.customValue.trim();
    const question = this.options.questions[this.step];
    const answer = this.answers[this.step];
    if (question === undefined || answer === undefined) return;
    if (!value) {
      if (advance && question.options.length === 0) {
        this.answers[this.step] = { questionIndex: this.step, selectedLabels: [] };
        this.moveStep(1);
      }
      return;
    }
    this.answers[this.step] = {
      questionIndex: this.step,
      selectedLabels: question.multiSelect === true ? answer.selectedLabels : [],
      customAnswer: value,
    };
    if (!advance) return;
    this.editingCustom = false;
    this.customValue = "";
    if (question.multiSelect !== true) this.moveStep(1);
  }

  private async submit(): Promise<void> {
    const missing = this.answers.findIndex(
      (answer) => answer.selectedLabels.length === 0 && answer.customAnswer === undefined,
    );
    if (missing >= 0) {
      this.step = missing;
      this.option = 0;
      this.error = "Answer this question before submitting";
      this.options.refresh();
      return;
    }
    this.pending = true;
    this.options.refresh();
    try {
      await this.options.submit(this.answers);
    } catch (error) {
      this.pending = false;
      this.error = error instanceof Error ? error.message : "Could not submit answers";
      this.options.refresh();
    }
  }

  private async cancel(): Promise<void> {
    this.pending = true;
    this.options.refresh();
    try {
      await this.options.cancel();
    } catch (error) {
      this.pending = false;
      this.error = error instanceof Error ? error.message : "Could not cancel questionnaire";
      this.options.refresh();
    }
  }
}
