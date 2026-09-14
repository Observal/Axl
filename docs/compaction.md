<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Context compaction

Axl keeps the complete session in its canonical JSONL log. Compaction replaces only the model-visible prefix with a durable continuation summary.

## Automatic compaction

The daemon checks context size before each model request, including requests made after tool execution. It compacts when:

```text
estimatedInputTokens > contextWindow - reserveTokens
```

If a provider still reports a context-limit error before emitting output, Axl performs at most one compaction and retries that model request once.

Configure defaults in `~/.axl/settings.json`:

```json
{
  "version": 1,
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "anthropic/claude-sonnet-4-6": {
        "reserveTokens": 32768,
        "keepRecentTokens": 30000
      }
    }
  }
}
```

Model override keys use `provider/model` identity. All token values must be positive safe integers. Restart the daemon after changing the file.

## Manual compaction

Use `/compact` or `/compact <instructions>`. If an agent response is active, the daemon records the request and runs it after that response and its existing in-turn follow-ups finish. This behavior is shared by terminal and web clients.

Input submitted while compaction itself is running is queued as the next prompt. It never changes the frozen compaction input. Cancelling compaction leaves the previous model context active.

## Durable state

The log records queued, started, succeeded, and failed compaction state. A daemon restart records any queued or in-progress compaction as failed instead of pretending an interrupted summarization resumed. Summaries preserve complete tool-call/result groups, summarize oversized turn prefixes separately, and carry cumulative read and modified file lists forward.
