// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { ExtensionDisposer } from "@axl/extension-api";

/** The browser owns the modal; extensions only receive a disposable content root. */
export function extensionDialog<T>(
  title: string,
  signal: AbortSignal,
  render: (
    root: HTMLElement,
    done: (value: T | undefined) => void,
    signal: AbortSignal,
    // biome-ignore lint/suspicious/noConfusingVoidType: Render callbacks may return nothing or a disposer.
  ) => void | ExtensionDisposer,
): Promise<T | undefined> {
  if (typeof title !== "string" || title.length > 512 || signal.aborted)
    return Promise.reject(new Error("Invalid or disposed web extension dialog"));
  return new Promise<T | undefined>((resolve, reject) => {
    const dialog = document.createElement("dialog");
    dialog.className = "extension-dialog";
    dialog.setAttribute("aria-label", title);
    const heading = document.createElement("h2");
    heading.textContent = title;
    const root = document.createElement("div");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    dialog.append(heading, root, cancel);
    const opener = document.activeElement as HTMLElement | null;
    let disposed = false;
    let cleanup: ExtensionDisposer | undefined;
    const finish = (value: T | undefined, error?: unknown): void => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", onAbort);
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      dialog.remove();
      if (opener?.isConnected) opener.focus();
      void Promise.resolve()
        .then(() => cleanup?.())
        .then(() => {
          if (error === undefined) resolve(value);
          else reject(error);
        }, reject);
    };
    const done = (value: T | undefined): void => finish(value);
    const onAbort = (): void => done(undefined);
    const onCancel = (event: Event): void => {
      event.preventDefault();
      done(undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    dialog.addEventListener("cancel", onCancel);
    cancel.addEventListener("click", () => done(undefined));
    try {
      document.body.append(dialog);
      dialog.showModal();
      const returned = render(root, done, signal);
      if (returned !== undefined && typeof returned !== "function")
        throw new Error("Web dialog cleanup must be a function");
      cleanup = returned ?? undefined;
    } catch (cause) {
      finish(undefined, cause);
    }
  });
}

export function textDialog(
  title: string,
  initial: string | undefined,
  multiline: boolean,
  signal: AbortSignal,
): Promise<string | undefined> {
  return extensionDialog(title, signal, (root, done) => {
    const form = document.createElement("form");
    const input = document.createElement(multiline ? "textarea" : "input");
    input.setAttribute("aria-label", title);
    input.value = initial ?? "";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Save";
    form.append(input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      done(input.value);
    });
    root.append(form);
    input.focus();
  });
}

export function selectDialog(
  title: string,
  choices: readonly string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  if (
    !Array.isArray(choices) ||
    choices.length === 0 ||
    choices.length > 100 ||
    choices.some((choice) => typeof choice !== "string" || choice.length > 512)
  )
    return Promise.reject(new Error("Invalid web selection choices"));
  return extensionDialog(title, signal, (root, done) => {
    const list = document.createElement("div");
    list.className = "extension-dialog-choices";
    for (const choice of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = choice;
      button.addEventListener("click", () => done(choice));
      list.append(button);
    }
    root.append(list);
    list.querySelector("button")?.focus();
  });
}

export function confirmDialog(
  title: string,
  message: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (typeof message !== "string" || message.length > 2048)
    return Promise.reject(new Error("Invalid web confirmation message"));
  return extensionDialog(title, signal, (root, done) => {
    const text = document.createElement("p");
    text.textContent = message;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Confirm";
    button.addEventListener("click", () => done(true));
    root.append(text, button);
    button.focus();
  }).then((value) => value === true);
}
