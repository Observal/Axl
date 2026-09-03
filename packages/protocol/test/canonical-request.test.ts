// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  encodeCanonicalRequest,
  hashCanonicalRequest,
  parseWireRequest,
  type RpcMethod,
} from "../src/index.ts";

interface CanonicalRequestFixture {
  readonly name: string;
  readonly method: RpcMethod;
  readonly params: Record<string, unknown>;
  readonly canonical: string;
  readonly sha256: string;
}

const fixtureDocument = JSON.parse(
  await readFile(new URL("./fixtures/canonical-requests.json", import.meta.url), "utf8"),
) as { readonly cases: readonly CanonicalRequestFixture[] };

for (const fixture of fixtureDocument.cases) {
  test(`matches canonical request fixture: ${fixture.name}`, () => {
    const request = parseWireRequest({
      kind: "request",
      id: 7,
      method: fixture.method,
      params: fixture.params,
    });
    const encoded = encodeCanonicalRequest(request.method, request.params);
    assert.equal(new TextDecoder().decode(encoded), fixture.canonical);
    assert.equal(hashCanonicalRequest(request.method, request.params), fixture.sha256);
  });
}

test("canonical request hashes ignore input object ordering and delivery metadata", () => {
  const first = parseWireRequest({
    kind: "request",
    id: 1,
    method: "session.create",
    params: { cwd: "/repo", modelId: "openai/gpt-5", thinkingLevel: "high" },
  });
  const second = parseWireRequest({
    params: { thinkingLevel: "high", modelId: "openai/gpt-5", cwd: "/repo" },
    method: "session.create",
    id: 999,
    kind: "request",
  });
  assert.equal(
    hashCanonicalRequest(first.method, first.params),
    hashCanonicalRequest(second.method, second.params),
  );
});

test("canonical request encoding rejects non-JSON values", () => {
  assert.throws(
    () =>
      encodeCanonicalRequest("session.create", {
        cwd: "/repo",
        invalid: undefined,
      } as never),
    /JSON-compatible/,
  );
  assert.throws(
    () => encodeCanonicalRequest("session.create", { cwd: "/repo", invalid: Number.NaN } as never),
    /finite numbers/,
  );
  const cyclic: Record<string, unknown> = { cwd: "/repo" };
  cyclic.self = cyclic;
  assert.throws(() => encodeCanonicalRequest("session.create", cyclic as never), /cycles/);
});
