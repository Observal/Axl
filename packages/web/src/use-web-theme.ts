// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import type { WebTheme } from "./commands.ts";

/**
 * Owns the color theme state and reflects it onto the document root. When the
 * theme is "system" it also tracks the OS color-scheme preference. Persistence
 * is the caller's responsibility so the theme can be written through the same
 * host preferences path as the rest of the layout.
 */
export function useWebTheme(initial: WebTheme): {
  readonly theme: WebTheme;
  readonly setTheme: (theme: WebTheme) => void;
} {
  const [theme, setTheme] = useState<WebTheme>(initial);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return { theme, setTheme };
}
