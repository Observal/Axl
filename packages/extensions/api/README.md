<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Axl extension API

This package owns the public, presentation-only extension registrations used by Axl clients. Every registration returns a disposer. Extensions must declare each capability before activation.

The current surface is intentionally limited to terminal commands, shortcuts, status, working labels, widgets, event listeners, and tool renderers with working first-party consumers. It does not expose daemon or kernel internals.
