// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import type { CursorStore } from "@axl/sdk";

const CURSOR_PREFIX = "axl.cursor.";
const AUTHENTICATED_PATH = /^\/_axl\/[0-9a-f]{32}(?:\/|$)/;

export interface BrowserSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Disposable browser cursor persistence. Canonical state always remains daemon-owned. */
export class SessionStorageCursorStore implements CursorStore {
  private readonly storage: BrowserSessionStorage;

  constructor(storage: BrowserSessionStorage) {
    this.storage = storage;
  }

  async load(key: string): Promise<string | undefined> {
    return this.storage.getItem(`${CURSOR_PREFIX}${key}`) ?? undefined;
  }

  async save(key: string, cursor: string): Promise<void> {
    this.storage.setItem(`${CURSOR_PREFIX}${key}`, cursor);
  }

  async delete(key: string): Promise<void> {
    this.storage.removeItem(`${CURSOR_PREFIX}${key}`);
  }
}

export function gatewayRpcPath(pathname: string): string {
  const match = AUTHENTICATED_PATH.exec(pathname);
  if (match === null) {
    throw new Error("Axl must run under its authenticated gateway path");
  }
  return `${match[0].replace(/\/$/, "")}/rpc`;
}
