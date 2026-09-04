// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  // The authenticated gateway rewrites this fixed development base to its random process path.
  base: command === "serve" ? "/__axl_dev__/" : "./",
  build: {
    sourcemap: false,
  },
}));
