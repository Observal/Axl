// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

export interface TranscriptRow {
  readonly text: string;
  readonly sourceId?: string;
  readonly toolGroupId?: string;
  readonly prompt: boolean;
  readonly rowInSource: number;
}

export interface TranscriptAppendOptions {
  readonly sourceId?: string;
  readonly toolGroupId?: string;
  readonly prompt?: boolean;
}

/**
 * Renderer-neutral transcript rows with enough identity for viewport anchoring,
 * prompt navigation, search, and selection. Canonical events remain authoritative.
 */
export class TranscriptDocument {
  private readonly content: TranscriptRow[] = [];

  get rows(): readonly TranscriptRow[] {
    return this.content;
  }

  get length(): number {
    return this.content.length;
  }

  append(lines: readonly string[], options: TranscriptAppendOptions = {}): void {
    for (const [rowInSource, text] of lines.entries()) {
      this.content.push({
        text,
        ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
        ...(options.toolGroupId === undefined ? {} : { toolGroupId: options.toolGroupId }),
        prompt: options.prompt === true && rowInSource === 0,
        rowInSource,
      });
    }
  }

  appendRows(rows: readonly TranscriptRow[]): void {
    for (const row of rows) this.content.push(row);
  }

  replace(rows: readonly TranscriptRow[]): void {
    this.content.length = 0;
    this.appendRows(rows);
  }

  clear(): void {
    this.content.length = 0;
  }

  textLines(): readonly string[] {
    return this.content.map((row) => row.text);
  }
}
