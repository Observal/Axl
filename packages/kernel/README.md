<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/kernel`

This package contains Axl's deterministic core: append-only JSONL history, session trees, replay, the agent loop, canonical tools, prompt construction, redaction, and path policy. The standard built-ins are `read`, `write`, `edit`, `bash`, `web_fetch`, and `web_search`. Web requests pin validated public DNS addresses, reject private destinations, and bound redirects, time, and response size. Its only dependencies are `@axl/protocol` and Node.js built-ins.
