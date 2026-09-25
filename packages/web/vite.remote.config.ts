// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

// Deployment-test phone page. It is served from the stack's CloudFront origin under /remote/ next
// to the deployment-test browser binding (./e2ee/), so every asset path stays relative.
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist/remote",
    emptyOutDir: true,
    rollupOptions: { input: "remote.html" },
  },
});
