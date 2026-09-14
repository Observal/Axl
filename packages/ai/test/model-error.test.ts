// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { consumeContextLimitResponse, isContextLimitError } from "../src/model-error.ts";

test("classifies provider context overflow without broad invalid-request matching", () => {
  assert.equal(isContextLimitError("context_length_exceeded", "request rejected"), true);
  assert.equal(isContextLimitError("invalid_request_error", "prompt is too long"), true);
  assert.equal(isContextLimitError("http_413", "payload too large", 413), true);
  assert.equal(isContextLimitError("invalid_request_error", "temperature is invalid", 400), false);
});

test("classifies bounded HTTP error payloads used before streaming starts", async () => {
  assert.equal(
    await consumeContextLimitResponse(
      new Response(
        JSON.stringify({
          error: { code: "invalid_request_error", message: "maximum context length exceeded" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    ),
    true,
  );
  assert.equal(
    await consumeContextLimitResponse(
      new Response(JSON.stringify({ error: { message: "temperature is invalid" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ),
    false,
  );
});
