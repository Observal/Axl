// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const fixturesRoot = resolve(packageRoot, "../../fixtures/v1");
const port = Number(process.env.AXL_E2EE_BROWSER_PORT ?? "4178");
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'";
const roots = [
  ["/package/", join(packageRoot, "dist/package")],
  ["/test-artifact/", join(packageRoot, "dist/test-artifact")],
  ["/fixtures/", fixturesRoot],
  ["/test/", join(packageRoot, "test")],
];
const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".tls", "application/octet-stream"],
]);

createServer((request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
    const route =
      pathname === "/"
        ? [join(packageRoot, "test"), "index.html"]
        : roots
            .map(([prefix, root]) =>
              pathname.startsWith(prefix) ? [root, pathname.slice(prefix.length)] : undefined,
            )
            .find(Boolean);
    if (!route) throw new Error("not found");
    const [root, relative] = route;
    const path = resolve(root, normalize(relative));
    if (path !== root && !path.startsWith(`${root}/`)) throw new Error("invalid path");
    if (!statSync(path).isFile()) throw new Error("not found");
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": csp,
      "Content-Type": types.get(extname(path)) ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(readFileSync(path));
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`READY http://127.0.0.1:${port}`));
