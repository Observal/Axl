// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

export interface DialogKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  preventDefault(): void;
}

interface Focusable {
  focus(): void;
}

interface DialogRoot {
  querySelectorAll<Control extends Focusable>(selector: string): ArrayLike<Control>;
}

const FOCUSABLE =
  'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled):not([tabindex="-1"]):not([type="hidden"]), select:not(:disabled):not([tabindex="-1"]), textarea:not(:disabled):not([tabindex="-1"]), summary:not([tabindex="-1"]), a[href]:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

export function trapDialogFocus(
  event: DialogKeyEvent,
  root: DialogRoot | null,
  active: unknown = document.activeElement,
): void {
  if (event.key !== "Tab" || root === null) return;
  const controls = Array.from(root.querySelectorAll<Focusable>(FOCUSABLE)).filter(
    (control) =>
      typeof HTMLElement === "undefined" ||
      !(control instanceof HTMLElement) ||
      (control.closest("[inert]") === null && control.getClientRects().length > 0),
  );
  const first = controls[0];
  const last = controls.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
