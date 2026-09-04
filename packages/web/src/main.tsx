// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { createRoot } from "react-dom/client";
import { connectBrowserClient } from "@axl/sdk/websocket";

import { App } from "./app.tsx";
import { gatewayRpcPath, SessionStorageCursorStore } from "./browser.ts";
import { ApplicationShell, BROWSER_CAPABILITIES } from "./shell.ts";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Axl application root is missing");

const rpcPath = gatewayRpcPath(window.location.pathname);
const shell = new ApplicationShell(
  {
    connect: (onStateChange) =>
      connectBrowserClient(rpcPath, {
        requestedCapabilities: BROWSER_CAPABILITIES,
        onStateChange,
      }),
  },
  new SessionStorageCursorStore(window.sessionStorage),
);

createRoot(root).render(<App shell={shell} />);
