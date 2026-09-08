<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Model provider protocol compatibility

## Scope

The issue 10 provider contract extends the in-process model stream shared by `packages/protocol`, `packages/ai`, and `packages/kernel`. Provider-management RPCs changed the daemon wire surface. Another branch independently added model-request configuration under wire version 11. Wire version 12 combines those surfaces, and version 13 adds atomic interrupt-and-deliver. The persisted JSONL event format remains version 1.

## Additive stream behavior

Existing providers and consumers remain valid. `ModelProvider.refreshModels(): Promise<readonly ModelInfo[]>` remains the legacy additive refresh hook. Context-aware providers use `refreshModelCatalog(context)`, which returns `ModelCatalogRefreshResult`. Legacy string dialect identifiers and boolean compatibility maps remain assignable; built-in codecs still require and validate their typed dialect records.

- Text and thinking deltas may omit `contentIndex`.
- A complete `tool_call` remains the authoritative instruction consumed by the kernel.
- `tool_call_start` and `tool_call_delta` provide optional progress without replacing the complete call.
- Completion, error, and abort remain the only terminal variants, and exactly one terminal event is still required.
- Response attribution, partial-content status, retry guidance, and diagnostics are optional terminal metadata.
- `replay_metadata` is optional nonterminal metadata for one positioned thinking, text, or tool-call block. It does not replace visible content or a complete `tool_call`. Signed thinking may additionally set `redacted: true` when its opaque signature must be replayed as a provider redacted-thinking block rather than ordinary signed thinking.

New codecs should provide stable `contentIndex` values whenever the upstream protocol can interleave text, thinking, and tool blocks. Consumers that do not render incremental tool arguments may ignore progress events and wait for `tool_call`. Consumers that retain provider replay metadata must bind it to the identified content block and exact provider, dialect, and model.

## Trust boundary

`parseModelStreamEvent` validates provider events before normalized streams enter the kernel. The safe diagnostic contract accepts only a code, message, and severity. It intentionally has no arbitrary details, headers, request bodies, stack traces, or credential fields.

Response metadata may contain provider identity, requested and routed model identity, a response ID, native stop detail, and latency. A `replay_metadata` event may contain only exact issuing provider, dialect, and model identity, a content position, an optional tool-call ID, the narrow opaque signature or continuation fields needed for same-model replay, and an optional redacted-thinking marker. That marker is valid only for a thinking target with a signature. Replay metadata cannot carry headers, credentials, arbitrary provider objects, or diagnostics. Empty replay metadata, malformed identities, and mismatched targets fail validation.

The OpenAI Responses codec emits these events for completed reasoning, text, and tool-call items. Azure OpenAI uses the same stream grammar and records the canonical `azure-openai-responses` provider and dialect identity. OpenAI Codex records the `openai-codex-responses` dialect and replays the complete prepared history for stateless SSE requests. It does not infer `previous_response_id` from history because the reviewed Codex continuation is scoped to a proven live connection, account, request baseline, and response prefix. Anthropic Messages emits signed-thinking replay metadata and marks opaque redacted-thinking signatures so the next request reconstructs the correct Anthropic block type. Google Generative AI may attach a thought signature to text, thinking, or tool-call parts. The signature does not classify a part as thinking, only the native `thought` marker does that. Session model-port adapters retain Google signatures on their matching block without inventing continuation state when no continuation identifier was emitted. Google Vertex AI uses the same event conversion but binds replay metadata to the distinct `google-vertex` dialect and provider identity. Bedrock Converse Stream emits signed or encrypted reasoning replay metadata under the `bedrock-converse-stream` dialect and retains provider event positions across interleaved text, thinking, and tool calls. Mistral Conversations replays native visible thinking without opaque replay metadata, preserves positions across interleaved thinking, text, and fragmented tool calls, and reports the native finish reason with requested and routed model identity. Gateway messages carries prepared context to a dynamically routed backend, preserves text, thinking, and tool signatures only for the exact gateway model, accepts gateway-reported usage and cost rather than applying one guessed route price, and reports requested and routed model identity plus the native stop reason. Session model-port adapters retain replay events in memory and attach them to matching assistant history before the next prepared dispatch. Retention is limited to the live port instance and exact issuing model identity. Persisted JSONL events and daemon wire versions remain unchanged, so restart and history reconstruction intentionally do not restore this metadata.

## Model and request metadata

The `packages/ai` additions are optional for existing callers. API dialects, compatibility controls, endpoint policy, cache policy, availability, tiered prices, sampling, cache preferences, timeout, and bounded retry controls are interpreted by provider adapters. The kernel remains provider independent.

Native image generation is an optional capability on `ModelProvider`. Image bytes travel through blob reader and writer callbacks, while results contain content-addressed blob references rather than inline bytes. The OpenRouter image codec keeps this operation outside the canonical text stream: it validates and reads content-addressed reference images, stores each generated image through `writeBlob`, and returns provider, requested model, optional routed model and response identity, revised prompt, usage, cost, and blob references. Cancellation and codec or provider failures reject the image operation with typed, redacted errors rather than inventing text-stream terminal events.
