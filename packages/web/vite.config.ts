// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite";

// Inject the build version so the browser client reports a real version to the
// daemon (presence and diagnostics) instead of a placeholder. The same value
// feeds the asset metadata written after the build.
export default defineConfig({
  define: {
    __AXL_WEB_VERSION__: JSON.stringify(process.env.AXL_BUILD_VERSION ?? "0.0.0-dev"),
  },
});
