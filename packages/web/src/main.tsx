// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@axl/ui/theme.css";
import "@axl/ui/conversation.css";
import { AxlApp, type WebPreview } from "./app.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing Axl application root");
let preview: WebPreview | undefined;
const parameters = new URLSearchParams(location.search);
const previewName = parameters.get("preview");
if (import.meta.env.DEV && (previewName === "tools" || previewName === "fixture")) {
  const local = import.meta.glob<{ readonly preview: WebPreview }>("./preview.local.ts")[
    "./preview.local.ts"
  ];
  const fixture = import.meta.glob<{ readonly previewFixture: WebPreview }>(
    "./preview.fixture.ts",
  )["./preview.fixture.ts"];
  const selected = previewName === "tools"
    ? local === undefined
      ? undefined
      : (await local()).preview
    : fixture === undefined
      ? undefined
      : (await fixture()).previewFixture;
  if (selected === undefined) throw new Error("Web preview fixture is unavailable");
  preview = {
    ...selected,
    ...(parameters.get("dialog") === "new" ? { openNewSession: true } : {}),
    ...(parameters.get("mode") === "code" ? { newSessionMode: "code" as const } : {}),
    ...(parameters.get("capabilities") === "none" ? { capabilities: [] } : {}),
  };
}
createRoot(root).render(
  <StrictMode>{preview === undefined ? <AxlApp /> : <AxlApp preview={preview} />}</StrictMode>,
);
