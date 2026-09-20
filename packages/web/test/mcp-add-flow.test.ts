// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { MCP_ADD_SERVER_QUESTIONS } from "@axl/sdk";
import { QuestionnaireForm } from "@axl/ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("the shared add flow renders its first step as direct text entry", () => {
  const html = renderToStaticMarkup(
    createElement(QuestionnaireForm, {
      title: "Add MCP server",
      questions: MCP_ADD_SERVER_QUESTIONS,
      onSubmit: () => Promise.resolve(),
      onCancel: () => undefined,
    }),
  );
  assert.match(html, /aria-label="Add MCP server"/u);
  assert.match(html, /Name for this server/u);
  assert.match(html, /Name · 1\/5/u);
  assert.match(html, /<textarea[^>]*aria-label="Answer for Name"/u);
  assert.doesNotMatch(html, /Type something else/u);
  assert.doesNotMatch(html, /deepwiki|context7|tested server/u);
});

test("option questions keep the free-text escape hatch", () => {
  const html = renderToStaticMarkup(
    createElement(QuestionnaireForm, {
      questions: [MCP_ADD_SERVER_QUESTIONS[1] as (typeof MCP_ADD_SERVER_QUESTIONS)[number]],
      onSubmit: () => Promise.resolve(),
      onCancel: () => undefined,
    }),
  );
  assert.match(html, /Remote server/u);
  assert.match(html, /Local process/u);
  assert.match(html, /Type something else/u);
});
