// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { EffectiveCommand, PresentationCommand, WorkspaceStatusScope } from "@axl/sdk";

export type WebTheme = "system" | "light" | "dark";

export function workspaceReviewScope(argument?: string): WorkspaceStatusScope | undefined {
  if (argument === "off") return undefined;
  return argument === "last-turn" ? "last-turn" : "working";
}

export function webPresentationCommands({
  canLogin,
  openNewSession,
  openProviders,
  openTheme,
  setTheme,
}: {
  readonly canLogin: boolean;
  readonly openNewSession: (mode?: "chat" | "code") => void;
  readonly openProviders: () => void;
  readonly openTheme: () => void;
  readonly setTheme: (theme: WebTheme) => void;
}): readonly PresentationCommand[] {
  return [
    {
      id: "web.new",
      name: "new",
      description: "Create a Chat or Code session",
      argument: { required: false, hint: "chat | code" },
      run: (argument?: string) => {
        if (argument !== undefined && argument !== "chat" && argument !== "code") {
          throw new Error("Session mode must be chat or code");
        }
        openNewSession(argument);
      },
    },
    ...(canLogin
      ? [
          {
            id: "web.login",
            name: "login",
            description: "Authenticate a provider",
            run: openProviders,
          },
        ]
      : []),
    {
      id: "web.theme",
      name: "theme",
      description: "Choose system, light, or dark appearance",
      argument: { required: false, hint: "system | light | dark" },
      run: (argument?: string) => {
        if (argument === undefined) {
          openTheme();
          return;
        }
        if (argument !== "system" && argument !== "light" && argument !== "dark") {
          throw new Error("Theme must be system, light, or dark");
        }
        setTheme(argument);
      },
    },
  ];
}

export function filterCommands(
  commands: readonly EffectiveCommand[],
  query: string,
): readonly EffectiveCommand[] {
  const term = query.trim().replace(/^\//, "").toLowerCase();
  if (!term) return commands;
  return commands.filter(
    (command) =>
      command.name.includes(term) ||
      command.aliases.some((alias) => alias.includes(term)) ||
      command.description.toLowerCase().includes(term),
  );
}
