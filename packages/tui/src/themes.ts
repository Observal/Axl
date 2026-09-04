// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { Palette } from "./transcript.ts";

function sgr(open: string, close: string): (text: string) => string {
  return (text) => `\x1b[${open}m${text}\x1b[${close}m`;
}

function fg256(color: number): (text: string) => string {
  return (text) => `\x1b[38;5;${color}m${text}\x1b[39m`;
}

function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
}

function foreground(hex: string): (text: string) => string {
  const color = rgb(hex);
  return (text) => `\x1b[38;2;${color}m${text}\x1b[39m`;
}

function background(hex: string): (text: string) => string {
  const color = rgb(hex);
  return (text) => `\x1b[48;2;${color}m${text}\x1b[49m`;
}

function foregroundOn(fg: string, bg: string): (text: string) => string {
  const foregroundColor = rgb(fg);
  const backgroundColor = rgb(bg);
  return (text) => `\x1b[38;2;${foregroundColor};48;2;${backgroundColor}m${text}\x1b[39;49m`;
}

const bold = sgr("1", "22");

const axl: Palette = {
  dim: sgr("2", "22"),
  accent: sgr("36", "39"),
  error: sgr("31", "39"),
  bold,
  border: sgr("90", "39"),
  success: sgr("32", "39"),
  warning: sgr("33", "39"),
  text: sgr("97", "39"),
  userMessage: background("#14252b"),
  selection: foregroundOn("#e7f6ff", "#164e63"),
  searchMatch: background("#3f3f46"),
  searchCurrent: foregroundOn("#082f49", "#67e8f9"),
  toolBackground: background("#111c20"),
  toolPendingBackground: background("#2b2414"),
  toolSuccessBackground: background("#14281d"),
  toolErrorBackground: background("#30191c"),
  toolDeniedBackground: background("#2c2314"),
  diffAdded: sgr("32", "39"),
  diffRemoved: sgr("31", "39"),
  diffContext: sgr("2", "22"),
  thinking: (_level, text) => sgr("36", "39")(text),
  syntaxComment: sgr("90", "39"),
  syntaxKeyword: fg256(175),
  syntaxFunction: fg256(81),
  syntaxVariable: fg256(117),
  syntaxString: fg256(114),
  syntaxNumber: fg256(179),
  syntaxType: fg256(81),
  syntaxOperator: fg256(215),
  syntaxPunctuation: fg256(250),
  keyword: fg256(175),
  literal: fg256(114),
};

const ember: Palette = {
  dim: fg256(243),
  accent: fg256(214),
  error: fg256(203),
  bold,
  border: fg256(243),
  success: fg256(114),
  warning: fg256(220),
  text: foreground("#fff1d6"),
  userMessage: background("#302016"),
  selection: foregroundOn("#fff7ed", "#9a3412"),
  searchMatch: background("#4a2c1c"),
  searchCurrent: foregroundOn("#431407", "#fdba74"),
  toolBackground: background("#261b15"),
  toolPendingBackground: background("#332617"),
  toolSuccessBackground: background("#20301f"),
  toolErrorBackground: background("#351b19"),
  toolDeniedBackground: background("#352815"),
  diffAdded: fg256(114),
  diffRemoved: fg256(203),
  diffContext: fg256(243),
  thinking: (_level, text) => fg256(214)(text),
  syntaxComment: fg256(243),
  syntaxKeyword: fg256(209),
  syntaxFunction: fg256(214),
  syntaxVariable: fg256(223),
  syntaxString: fg256(114),
  syntaxNumber: fg256(179),
  syntaxType: fg256(117),
  syntaxOperator: fg256(215),
  syntaxPunctuation: fg256(250),
  keyword: fg256(209),
  literal: fg256(179),
};

const ocean: Palette = {
  dim: fg256(245),
  accent: fg256(75),
  error: fg256(210),
  bold,
  border: fg256(245),
  success: fg256(79),
  warning: fg256(221),
  text: foreground("#e7f6ff"),
  userMessage: background("#10283a"),
  selection: foregroundOn("#eff6ff", "#1d4ed8"),
  searchMatch: background("#173b57"),
  searchCurrent: foregroundOn("#082f49", "#7dd3fc"),
  toolBackground: background("#0c202f"),
  toolPendingBackground: background("#2b2915"),
  toolSuccessBackground: background("#112d27"),
  toolErrorBackground: background("#351f29"),
  toolDeniedBackground: background("#302815"),
  diffAdded: fg256(79),
  diffRemoved: fg256(210),
  diffContext: fg256(245),
  thinking: (_level, text) => fg256(75)(text),
  syntaxComment: fg256(245),
  syntaxKeyword: fg256(111),
  syntaxFunction: fg256(79),
  syntaxVariable: fg256(117),
  syntaxString: fg256(114),
  syntaxNumber: fg256(221),
  syntaxType: fg256(81),
  syntaxOperator: fg256(75),
  syntaxPunctuation: fg256(250),
  keyword: fg256(111),
  literal: fg256(79),
};

const grove: Palette = {
  dim: fg256(244),
  accent: fg256(142),
  error: fg256(167),
  bold,
  border: fg256(244),
  success: fg256(108),
  warning: fg256(180),
  text: foreground("#edf4dc"),
  userMessage: background("#20291a"),
  selection: foregroundOn("#f7fee7", "#4d7c0f"),
  searchMatch: background("#334025"),
  searchCurrent: foregroundOn("#1a2e05", "#bef264"),
  toolBackground: background("#192117"),
  toolPendingBackground: background("#2d2918"),
  toolSuccessBackground: background("#1b2d1b"),
  toolErrorBackground: background("#331f1f"),
  toolDeniedBackground: background("#302817"),
  diffAdded: fg256(108),
  diffRemoved: fg256(167),
  diffContext: fg256(244),
  thinking: (_level, text) => fg256(142)(text),
  syntaxComment: fg256(244),
  syntaxKeyword: fg256(108),
  syntaxFunction: fg256(142),
  syntaxVariable: fg256(109),
  syntaxString: fg256(180),
  syntaxNumber: fg256(173),
  syntaxType: fg256(109),
  syntaxOperator: fg256(142),
  syntaxPunctuation: fg256(250),
  keyword: fg256(108),
  literal: fg256(180),
};

const gruvbox = {
  bg0Hard: "#1d2021",
  bg1: "#3c3836",
  bg3: "#665c54",
  bg4: "#7c6f64",
  gray: "#928374",
  fg1: "#ebdbb2",
  fg3: "#bdae93",
  fg4: "#a89984",
  red: "#fb4934",
  green: "#b8bb26",
  yellow: "#fabd2f",
  blue: "#83a598",
  aqua: "#8ec07c",
  orange: "#fe8019",
} as const;

const dark: Palette = {
  dim: foreground(gruvbox.gray),
  accent: foreground(gruvbox.orange),
  error: foreground(gruvbox.red),
  bold,
  border: foreground(gruvbox.bg4),
  success: foreground(gruvbox.green),
  warning: foreground(gruvbox.yellow),
  text: foreground(gruvbox.fg1),
  userMessage: foregroundOn(gruvbox.fg1, gruvbox.bg0Hard),
  selection: foregroundOn(gruvbox.fg1, gruvbox.bg1),
  searchMatch: background(gruvbox.bg1),
  searchCurrent: foregroundOn(gruvbox.bg0Hard, gruvbox.yellow),
  toolBackground: background("#202324"),
  toolPendingBackground: background("#332d20"),
  toolSuccessBackground: background("#24332b"),
  toolErrorBackground: background("#35282c"),
  toolDeniedBackground: background("#352f20"),
  diffAdded: foreground(gruvbox.green),
  diffRemoved: foreground(gruvbox.red),
  diffContext: foreground(gruvbox.gray),
  diffAddedBackground: background("#24332b"),
  diffRemovedBackground: background("#35282c"),
  mdHeading: foreground(gruvbox.yellow),
  mdCode: foreground(gruvbox.aqua),
  mdCodeBlockBorder: foreground(gruvbox.bg4),
  mdQuote: foreground(gruvbox.fg3),
  mdQuoteBorder: foreground(gruvbox.orange),
  mdListBullet: foreground(gruvbox.orange),
  thinking: (level, text) => {
    const colors: Readonly<Record<string, string>> = {
      off: gruvbox.bg3,
      minimal: gruvbox.fg4,
      low: gruvbox.orange,
      medium: gruvbox.yellow,
      high: gruvbox.orange,
      xhigh: gruvbox.red,
      max: gruvbox.red,
    };
    return foreground(colors[level] ?? gruvbox.bg4)(text);
  },
  syntaxComment: foreground(gruvbox.gray),
  syntaxKeyword: foreground(gruvbox.red),
  syntaxFunction: foreground(gruvbox.green),
  syntaxVariable: foreground(gruvbox.blue),
  syntaxString: foreground(gruvbox.aqua),
  syntaxNumber: foreground("#d3869b"),
  syntaxType: foreground(gruvbox.yellow),
  syntaxOperator: foreground(gruvbox.orange),
  syntaxPunctuation: foreground(gruvbox.fg4),
  keyword: foreground(gruvbox.red),
  literal: foreground(gruvbox.yellow),
};

const light: Palette = {
  dim: foreground("#6b7280"),
  accent: foreground("#075985"),
  error: foreground("#b91c1c"),
  bold,
  border: foreground("#9ca3af"),
  success: foreground("#047857"),
  warning: foreground("#a16207"),
  text: foreground("#111827"),
  userMessage: foregroundOn("#111827", "#f3f4f6"),
  selection: foregroundOn("#ffffff", "#075985"),
  searchMatch: background("#e0f2fe"),
  searchCurrent: foregroundOn("#ffffff", "#075985"),
  toolBackground: background("#f8fafc"),
  toolPendingBackground: background("#fff7ed"),
  toolSuccessBackground: background("#ecfdf5"),
  toolErrorBackground: background("#fef2f2"),
  toolDeniedBackground: background("#fffbeb"),
  diffAdded: foreground("#047857"),
  diffRemoved: foreground("#b91c1c"),
  diffContext: foreground("#6b7280"),
  diffAddedBackground: background("#dcfce7"),
  diffRemovedBackground: background("#fee2e2"),
  mdHeading: foreground("#854d0e"),
  mdCode: foreground("#0f766e"),
  mdCodeBlockBorder: foreground("#9ca3af"),
  mdQuote: foreground("#4b5563"),
  mdQuoteBorder: foreground("#075985"),
  mdListBullet: foreground("#075985"),
  thinking: (_level, text) => foreground("#7c3aed")(text),
  syntaxComment: foreground("#6b7280"),
  syntaxKeyword: foreground("#be123c"),
  syntaxFunction: foreground("#047857"),
  syntaxVariable: foreground("#075985"),
  syntaxString: foreground("#047857"),
  syntaxNumber: foreground("#7c3aed"),
  syntaxType: foreground("#a16207"),
  syntaxOperator: foreground("#9f1239"),
  syntaxPunctuation: foreground("#4b5563"),
  keyword: foreground("#be123c"),
  literal: foreground("#a16207"),
};

const system: Palette = {
  dim: sgr("2", "22"),
  accent: sgr("36", "39"),
  error: sgr("31", "39"),
  bold,
  border: sgr("2", "22"),
  success: sgr("32", "39"),
  warning: sgr("33", "39"),
  selection: sgr("7", "27"),
  searchMatch: sgr("4", "24"),
  searchCurrent: sgr("1;7", "22;27"),
  thinking: (_level, text) => sgr("36", "39")(text),
  syntaxComment: sgr("90", "39"),
  syntaxKeyword: sgr("35", "39"),
  syntaxFunction: sgr("32", "39"),
  syntaxVariable: sgr("36", "39"),
  syntaxString: sgr("32", "39"),
  syntaxNumber: sgr("33", "39"),
  syntaxType: sgr("33", "39"),
  syntaxOperator: sgr("36", "39"),
  syntaxPunctuation: sgr("2", "22"),
};

const highContrast: Palette = {
  dim: sgr("37", "39"),
  accent: sgr("96", "39"),
  error: sgr("91", "39"),
  bold,
  border: sgr("97", "39"),
  success: sgr("92", "39"),
  warning: sgr("93", "39"),
  text: sgr("97", "39"),
  selection: sgr("7", "27"),
  searchMatch: sgr("4", "24"),
  searchCurrent: sgr("1;7", "22;27"),
  diffAdded: sgr("92", "39"),
  diffRemoved: sgr("91", "39"),
  diffContext: sgr("37", "39"),
  thinking: (_level, text) => sgr("95", "39")(text),
  syntaxComment: sgr("37", "39"),
  syntaxKeyword: sgr("95", "39"),
  syntaxFunction: sgr("92", "39"),
  syntaxVariable: sgr("96", "39"),
  syntaxString: sgr("92", "39"),
  syntaxNumber: sgr("93", "39"),
  syntaxType: sgr("93", "39"),
  syntaxOperator: sgr("96", "39"),
  syntaxPunctuation: sgr("97", "39"),
  keyword: sgr("95", "39"),
  literal: sgr("93", "39"),
};

const plain: Palette = {
  dim: (text) => text,
  accent: (text) => text,
  error: (text) => text,
  bold: (text) => text,
  selection: (text) => `\x1b[7m${text}\x1b[27m`,
  searchMatch: (text) => `\x1b[4m${text}\x1b[24m`,
  searchCurrent: (text) => `\x1b[1;7m${text}\x1b[22;27m`,
};

export interface ThemeDefinition {
  readonly version: 1;
  readonly id: string;
  readonly label: string;
  readonly appearance: "dark" | "light" | "system" | "accessible" | "plain";
  readonly palette: Palette;
  readonly origin?: "global" | "project";
}

export const THEME_DEFINITIONS: readonly ThemeDefinition[] = [
  { version: 1, id: "axl-dark", label: "Axl Dark", appearance: "dark", palette: dark },
  { version: 1, id: "axl-light", label: "Axl Light", appearance: "light", palette: light },
  { version: 1, id: "system", label: "Terminal System", appearance: "system", palette: system },
  {
    version: 1,
    id: "high-contrast",
    label: "High Contrast",
    appearance: "accessible",
    palette: highContrast,
  },
  { version: 1, id: "axl", label: "Axl ANSI", appearance: "system", palette: axl },
  { version: 1, id: "ember", label: "Ember", appearance: "dark", palette: ember },
  { version: 1, id: "ocean", label: "Ocean", appearance: "dark", palette: ocean },
  { version: 1, id: "grove", label: "Grove", appearance: "dark", palette: grove },
  { version: 1, id: "plain", label: "No Color", appearance: "plain", palette: plain },
];

export const THEMES: Readonly<Record<string, Palette>> = Object.fromEntries(
  THEME_DEFINITIONS.map((theme) => [theme.id, theme.palette]),
);

export const DEFAULT_THEME = "axl-dark";

export function themeNames(definitions = THEME_DEFINITIONS): readonly string[] {
  return definitions.map((theme) => theme.id);
}
