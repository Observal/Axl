<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @axl/ui

Shared Axl presentation primitives for web-based clients.

The package owns the common charcoal theme, native workhorse font stack, syntax highlighting, edit-diff projection, and reusable React conversation renderer. The renderer consumes the SDK's exhaustive presentation-item contract, including compacted-history membership, rather than reducing canonical events itself. It depends only on the public SDK and presentation libraries. It does not connect to the daemon or own session state.

Native clients should map the same visual tokens into their platform design systems rather than embedding browser CSS.
