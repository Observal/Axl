---
# SPDX-FileCopyrightText: 2026 Hari Srinivasan
# SPDX-License-Identifier: Apache-2.0
name: Axl Web
description: A dense, calm command surface for one authoritative local agent session.
colors:
  accent: "#6d70c9"
  accent-strong: "#a6a8eb"
  dark-canvas: "#111113"
  dark-sidebar: "#151517"
  dark-panel: "#19191c"
  dark-raised: "#202023"
  dark-border: "#303036"
  dark-text: "#f4f4f5"
  dark-muted: "#a1a1aa"
  light-canvas: "#f7f7f8"
  light-panel: "#ffffff"
  light-border: "#d5d5db"
  light-text: "#202126"
  success: "#43b77b"
typography:
  title:
    fontFamily: "SF Pro Text, Segoe UI Variable, Helvetica Neue, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  body:
    fontFamily: "SF Pro Text, Segoe UI Variable, Helvetica Neue, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "SF Pro Text, Segoe UI Variable, Helvetica Neue, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 550
    lineHeight: 1.4
  code:
    fontFamily: "SFMono-Regular, Cascadia Code, Roboto Mono, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  tight: "4px"
  control: "7px"
  popover: "9px"
  surface: "11px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    height: "36px"
    padding: "0 14px"
  button-secondary:
    backgroundColor: "{colors.dark-raised}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.control}"
    height: "36px"
    padding: "0 14px"
  input:
    backgroundColor: "{colors.dark-canvas}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 11px"
---

# Design System: Axl Web

## Overview

**Creative North Star: "The Quiet Control Room"**

Axl Web is a dense operating surface for developers who need to understand and direct one durable agent session. It uses disciplined alignment, familiar controls, and quiet neutral layers so state and work remain more prominent than chrome. Its visual reference is the restraint and precision of Linear-style product interfaces, interpreted as an original Axl system.

The interface rejects decorative AI aesthetics. It has no gradients, glowing borders, oversized cards, ornamental blur, or novelty typography. Mild translucency appears only where a composer, menu, or modal physically overlays another surface.

**Key Characteristics:**

- Dense, calm information hierarchy
- Flat neutral surfaces separated by hairlines
- One restrained violet accent for selection and primary action
- Familiar controls with explicit hover, focus, disabled, loading, and error states
- Fast state transitions that yield to reduced-motion preferences

## Colors

The palette is neutral and low-chroma. Violet communicates selection and primary intent. Green, amber, and red are reserved for semantic state.

### Primary

- **Axl Violet:** The sole interactive accent for primary actions, selected controls, and focus.
- **Soft Violet:** Focus and selected-state detail on dark surfaces.

### Neutral

- **Charcoal Canvas:** The dark workspace behind the thread.
- **Graphite Rail:** The dark navigation rail and workspace panel.
- **Raised Graphite:** Controls, selected rows, and stacked surfaces.
- **Paper Canvas:** The light workspace.
- **White Panel:** Light-theme dialogs and composers.
- **Hairline Gray:** Structural borders and dividers in both themes.

**The One Accent Rule.** Violet marks action or selection. It does not decorate passive containers.

**The Semantic Color Rule.** Green, amber, and red appear only when they communicate status, warning, or failure.

## Typography

**Display Font:** Native workhorse sans stack
**Body Font:** Native workhorse sans stack
**Label/Mono Font:** SFMono-compatible native monospace stack

**Character:** Compact, direct, and platform-aware. Weight and spacing create hierarchy without display-font theatrics. Monospace is limited to code, identifiers, paths, shortcuts, and measurements.

### Hierarchy

- **Title** (650, 20px, 1.25): Session and primary dialog titles.
- **Body** (400, 14px, 1.65): Conversation prose with a maximum measure near 72 characters.
- **Label** (550, 12px, 1.4): Controls, field names, and navigation.
- **Code** (400, 11px, 1.55): Source, diffs, model identifiers, and paths.

**The Quiet Hierarchy Rule.** Use a small number of adjacent sizes. Establish priority with weight and position before increasing scale.

## Layout

Desktop uses a resizable session rail, a centered thread, and an optional workspace panel. The composer remains anchored below the thread. Task panels are revealed on demand rather than permanently competing for width.

Spacing follows a compact 4px base with common 8px, 12px, 16px, and 24px intervals. Related controls stay close; sections gain separation through 16px to 24px spacing and one-pixel dividers.

At 760px and below, the session rail becomes a drawer, the top bar prioritizes icon actions, panels become bottom sheets, and action targets grow to at least 40px. Forms collapse from paired columns to one linear sequence without horizontal overflow.

## Elevation & Depth

The system is flat by default. Tonal contrast and hairline borders define regions. Ambient shadows appear only on floating composers, menus, dialogs, and detached panels. Those overlays may use restrained backdrop blur because they occupy a real layer above content.

### Shadow Vocabulary

- **Floating surface** (`0 16px 42px rgba(0,0,0,.3)`): Composer and small detached controls.
- **Modal surface** (`0 28px 80px var(--shadow)`): Dialogs and protected-focus workflows.

**The Earned Glass Rule.** Blur belongs only to a real overlay. Navigation rows, settings groups, and content regions stay opaque and flat.

## Shapes

Controls use gently tightened corners. Small labels and chips use 4px, ordinary controls use 6px to 7px, menus use 9px, and primary floating surfaces stop at 11px. Circular shapes are reserved for status dots and radio indicators, not general buttons.

Hairline borders are the default boundary. Selected rows combine a subtle tonal change with a border instead of a colored side stripe.

## Components

### Buttons

- **Shape:** Compact rounded rectangle (7px), with 36px desktop height and 40px to 42px mobile height for key actions.
- **Primary:** Flat Axl Violet with white text. One primary action per dialog or task endpoint.
- **Hover / Focus:** Small tonal shift, visible two-pixel focus ring, and a one-pixel pressed translation.
- **Secondary:** Raised neutral fill and a hairline border.
- **Icon:** Square, labeled for assistive technology, and never represented by an emoji.

### Inputs / Fields

- **Style:** Opaque input canvas, one-pixel border, 7px corners, and compact internal padding.
- **Focus:** Accent border plus a restrained three-pixel translucent ring.
- **Error / Disabled:** Error text stays beside the originating field or surface. Disabled controls remain legible and explain unavailable capabilities.

### Navigation

The session rail uses borderless rows at rest. Hover adds a tonal fill. Selection adds a quiet raised fill and hairline border. Mobile navigation becomes a drawer and restores focus when dismissed.

### Composer

The composer is the persistent action surface. It uses mild functional translucency, a hairline border, one ambient shadow, and a single filled send button. Secondary tools stay compact and do not compete with the message field.

### Dialogs

Dialogs use a clear header, linear content sections, and a fixed action footer. The primary action is last. Focus is trapped, Escape dismisses the topmost surface, and focus returns to the initiating control.

### Diff and Code Surfaces

All diff rows use the same 11px monospace size, 1.55 line height, tabular numerals, and aligned 40px desktop line-number columns. Additions and deletions use semantic tint without changing type scale.

## Do's and Don'ts

### Do:

- **Do** reveal configuration in a task order and hide fields that do not apply.
- **Do** keep one unmistakable primary action in every protected workflow.
- **Do** use native interaction patterns, immediate feedback, and 140ms to 180ms state transitions.
- **Do** preserve complete keyboard operation and reduced-motion behavior.
- **Do** keep text and controls aligned to shared baselines and sizing rules.

### Don't:

- **Don't** use gradients, neon glow, gradient text, or decorative glass.
- **Don't** build pages from nested same-sized cards.
- **Don't** use monospace as a generic technical costume.
- **Don't** expose unavailable capabilities through controls that appear functional.
- **Don't** add motion that delays input, reading, or state confirmation.
