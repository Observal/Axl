// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { type CanonicalEvent, parseEvent } from "./events.ts";

export const MAX_CANONICAL_EVENT_BYTES = 768 * 1024;

export class CanonicalEventSizeError extends Error {
  readonly code = "content_too_large";
  readonly event: CanonicalEvent;
  readonly encodedBytes: number;
  readonly maximumBytes = MAX_CANONICAL_EVENT_BYTES;
  readonly details: {
    readonly field: "canonicalEvent";
    readonly encodedBytes: number;
    readonly maximumBytes: number;
  };

  constructor(event: CanonicalEvent, encodedBytes: number) {
    super(
      `Canonical event ${event.id} (${event.type}) is ${encodedBytes} bytes; maximum is ${MAX_CANONICAL_EVENT_BYTES}`,
    );
    this.name = "CanonicalEventSizeError";
    this.event = event;
    this.encodedBytes = encodedBytes;
    this.details = {
      field: "canonicalEvent",
      encodedBytes,
      maximumBytes: MAX_CANONICAL_EVENT_BYTES,
    };
  }
}

/** Validates and encodes exactly the bytes persisted for one canonical event. */
export function encodeCanonicalEvent(value: unknown): Uint8Array {
  const event = parseEvent(value);
  const encoded = new TextEncoder().encode(JSON.stringify(event));
  if (encoded.byteLength > MAX_CANONICAL_EVENT_BYTES) {
    throw new CanonicalEventSizeError(event, encoded.byteLength);
  }
  return encoded;
}
