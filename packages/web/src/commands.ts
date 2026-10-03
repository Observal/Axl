// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import {
  closestMatch,
  type EffectiveCommand,
  type PresentationCommand,
  type WorkspaceStatusScope,
} from "@axl/sdk";

export type WebTheme = "system" | "light" | "dark";

function hint(input: string, options: readonly string[]): string {
  const match = closestMatch(input, options);
  return match === undefined ? "" : ` · did you mean ${match}?`;
}

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
  toggleLounge,
  toggleMascot,
}: {
  readonly canLogin: boolean;
  readonly openNewSession: (mode?: "chat" | "code") => void;
  readonly openProviders: () => void;
  readonly openTheme: () => void;
  readonly setTheme: (theme: WebTheme) => void;
  /** Present only when the host enabled Lounge. */
  readonly toggleLounge?: (open?: boolean) => void;
  /** Turns the mascot on or off, or picks its colour. */
  readonly toggleMascot?: (argument?: string) => void;
}): readonly PresentationCommand[] {
  return [
    {
      id: "web.new",
      name: "new",
      description: "Create a Chat or Code session",
      argument: { required: false, hint: "chat | code" },
      run: (argument?: string) => {
        if (argument !== undefined && argument !== "chat" && argument !== "code") {
          throw new Error(`Session mode must be chat or code${hint(argument, ["chat", "code"])}`);
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
          throw new Error(
            `Theme must be system, light, or dark${hint(argument, ["system", "light", "dark"])}`,
          );
        }
        setTheme(argument);
      },
    },
    ...(toggleLounge === undefined
      ? []
      : [
          {
            id: "web.lounge",
            name: "lounge",
            description: "Show or hide the Lounge game pane",
            argument: { required: false, hint: "on | off" },
            run: (argument?: string) => {
              if (argument !== undefined && argument !== "on" && argument !== "off") {
                throw new Error(`Lounge must be on or off${hint(argument, ["on", "off"])}`);
              }
              toggleLounge(argument === undefined ? undefined : argument === "on");
            },
          },
        ]),
    ...(toggleMascot === undefined
      ? []
      : [
          {
            id: "web.mascot",
            name: "mascot",
            description: "Show or hide the axolotl above the composer",
            argument: { required: false, hint: "Pink | Albino | Purple | Deep_Sea | sas" },
            run: (argument?: string) => toggleMascot(argument),
          },
        ]),
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

/** Suggests a command name for a palette query that matched nothing. */
export function suggestCommand(
  commands: readonly EffectiveCommand[],
  query: string,
): string | undefined {
  const term = query.trim().replace(/^\//, "");
  if (!term) return undefined;
  return closestMatch(
    term,
    commands.flatMap((command) => [command.name, ...command.aliases]),
  );
}
