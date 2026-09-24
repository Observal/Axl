// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { WebExtension, WebExtensionApi } from "@axl/extension-api";
import type { ConversationState, ExtensionListResult } from "@axl/sdk";
import { confirmDialog, extensionDialog, selectDialog, textDialog } from "./extension-dialog.ts";

interface WebCommand {
  readonly extensionId: string;
  readonly name: string;
  readonly description: string;
  run(argument: string): void | Promise<void>;
}

/** Browser-local presentation only. Canonical session operations remain SDK-owned. */
/**
 * Normalize a browser key event to the registered shortcut form, such as Ctrl+Shift+Y.
 * Physical key codes keep Shift+digit and macOS Option layouts stable.
 */
export function webShortcutKey(event: {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}): string | undefined {
  const key = /^Key([A-Z])$|^Digit([0-9])$/u.exec(event.code);
  if (key === null) return undefined;
  return [
    event.ctrlKey && "Ctrl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.metaKey && "Meta",
    key[1] ?? key[2],
  ]
    .filter(Boolean)
    .join("+");
}

export class WebExtensionHost {
  private readonly controllers: AbortController[] = [];
  private readonly disposers: (() => void | Promise<void>)[] = [];
  private readonly commandsByName = new Map<string, WebCommand>();
  private readonly statusesById = new Map<string, string>();
  private readonly widgetsById = new Map<
    string,
    string | { mount(root: HTMLElement, signal: AbortSignal): void | (() => void | Promise<void>) }
  >();
  private readonly shortcutsByKey = new Map<
    string,
    { readonly description: string; run(): void | Promise<void> }
  >();
  private readonly toolRenderers = new Map<string, (tool: unknown) => string | undefined>();
  private readonly messageRenderers = new Map<string, (event: unknown) => string | undefined>();
  private readonly entryRenderers = new Map<string, (event: unknown) => string | undefined>();
  private readonly eventHandlers: ((event: {
    readonly type: "session.event" | "working.start" | "working.end";
    readonly event?: unknown;
  }) => void | Promise<void>)[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly transformers: ((text: string, role: "user" | "assistant") => string)[] = [];
  private active = true;

  private constructor() {}

  static async load(
    inventory: ExtensionListResult,
    sessionId: string,
    baseUrl: string,
    notify: (message: string) => void,
    importModule: (url: string) => Promise<unknown> = (url) => import(/* @vite-ignore */ url),
    setTheme?: (name: "light" | "dark" | "system") => void,
    builtins: readonly WebExtension[] = [],
  ): Promise<WebExtensionHost> {
    const host = new WebExtensionHost();
    try {
      const entries = [
        ...builtins.map((definition) => ({
          id: definition.manifest.id,
          load: async (): Promise<{ default: unknown }> => ({ default: definition }),
        })),
        ...inventory.extensions
          .filter((entry) => entry.enabled && entry.webPath !== undefined)
          .map((entry) => ({
            id: entry.id,
            load: async (): Promise<{ default?: unknown }> => {
              const url = new URL(
                `extension/${encodeURIComponent(sessionId)}/${encodeURIComponent(entry.id)}.mjs`,
                baseUrl,
              );
              // A new URL invalidates the browser module cache on explicit reload.
              url.searchParams.set("reload", crypto.randomUUID());
              return (await importModule(url.href)) as { default?: unknown };
            },
          })),
      ];
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.id)) throw new Error(`Duplicate web extension ${entry.id}`);
        seen.add(entry.id);
        const module = await entry.load();
        const definition = module.default as WebExtension | undefined;
        if (
          definition?.manifest?.id !== entry.id ||
          definition.manifest.apiVersion !== 1 ||
          typeof definition.manifest.name !== "string" ||
          definition.manifest.name.length > 128 ||
          typeof definition.activate !== "function"
        )
          throw new Error(`Web extension ${entry.id} must export a matching version-1 extension`);
        const controller = new AbortController();
        host.controllers.push(controller);
        const assertActive = () => {
          if (!host.active || controller.signal.aborted)
            throw new Error(`Web extension ${entry.id} is disposed`);
        };
        const owned = <T>(items: T[], item: T): (() => void) => {
          items.push(item);
          const dispose = () => {
            const index = items.indexOf(item);
            if (index !== -1) items.splice(index, 1);
          };
          host.disposers.push(dispose);
          return dispose;
        };
        const registerText = (
          map: Map<string, string>,
          id: string,
          value: string,
        ): (() => void) => {
          assertActive();
          if (
            typeof id !== "string" ||
            !/^[a-z][a-z0-9-]{0,63}$/u.test(id) ||
            map.has(`${entry.id}/${id}`) ||
            typeof value !== "string" ||
            value.length > 512
          )
            throw new Error(`Invalid or duplicate web extension slot ${entry.id}/${id}`);
          const key = `${entry.id}/${id}`;
          map.set(key, value);
          host.changed();
          const dispose = () => {
            if (map.delete(key)) host.changed();
          };
          host.disposers.push(dispose);
          return dispose;
        };
        const api: WebExtensionApi = {
          signal: controller.signal,
          sessionId,
          ui: {
            notify: (message) => {
              assertActive();
              if (typeof message !== "string" || message.length > 512)
                throw new Error("Web notification is too long");
              notify(message);
            },
            select: (title, choices) => {
              assertActive();
              return selectDialog(title, choices, controller.signal);
            },
            confirm: (title, message) => {
              assertActive();
              return confirmDialog(title, message, controller.signal);
            },
            input: (title, initial) => {
              assertActive();
              return textDialog(title, initial, false, controller.signal);
            },
            editor: (title, initial) => {
              assertActive();
              return textDialog(title, initial, true, controller.signal);
            },
            custom: (title, render) => {
              assertActive();
              if (typeof render !== "function")
                throw new Error("Web dialog renderer must be a function");
              return extensionDialog(title, controller.signal, render);
            },
            theme: {
              get name() {
                return document.documentElement.dataset.theme === "light" ? "light" : "dark";
              },
              color(role) {
                const value = getComputedStyle(document.documentElement)
                  .getPropertyValue(`--${role}`)
                  .trim();
                if (!value) throw new Error(`Web theme role ${role} is unavailable`);
                return value;
              },
            },
            setTheme: (name) => {
              assertActive();
              if (name !== "light" && name !== "dark" && name !== "system")
                throw new Error("Invalid web theme");
              if (setTheme === undefined) throw new Error("Web theme changes are unavailable");
              setTheme(name);
            },
          },
          registerCommand: (command) => {
            assertActive();
            if (
              typeof command?.name !== "string" ||
              !/^[a-z][a-z0-9-]{0,63}$/u.test(command.name) ||
              typeof command.description !== "string" ||
              command.description.length > 512 ||
              typeof command.run !== "function" ||
              host.commandsByName.has(command.name)
            )
              throw new Error(`Invalid or duplicate web command /${command.name}`);
            const registered = {
              ...command,
              extensionId: entry.id,
              run: (argument: string) => command.run(argument, controller.signal),
            };
            host.commandsByName.set(command.name, registered);
            const dispose = () => {
              if (host.commandsByName.get(command.name) === registered)
                host.commandsByName.delete(command.name);
            };
            host.disposers.push(dispose);
            return dispose;
          },
          registerStatus: (id, label) => registerText(host.statusesById, id, label),
          registerShortcut: (shortcut) => {
            assertActive();
            if (
              typeof shortcut?.key !== "string" ||
              !/^(?=.*\+)(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:Meta\+)?[A-Z0-9]$/u.test(
                shortcut.key,
              ) ||
              /^(?:Ctrl|Meta)\+(?:[A-Z0-9]|Shift\+(?:I|J|N|P|R|T|W))$/u.test(shortcut.key) ||
              typeof shortcut.description !== "string" ||
              shortcut.description.length > 512 ||
              typeof shortcut.run !== "function" ||
              host.shortcutsByKey.has(shortcut.key)
            )
              throw new Error(`Invalid, reserved, or duplicate web shortcut ${shortcut?.key}`);
            const registered = {
              description: shortcut.description,
              run: () => shortcut.run(controller.signal),
            };
            host.shortcutsByKey.set(shortcut.key, registered);
            const dispose = () => {
              if (host.shortcutsByKey.get(shortcut.key) === registered)
                host.shortcutsByKey.delete(shortcut.key);
            };
            host.disposers.push(dispose);
            return dispose;
          },
          registerWidget: (id, widget) => {
            assertActive();
            if (
              typeof id !== "string" ||
              !/^[a-z][a-z0-9-]{0,63}$/u.test(id) ||
              (typeof widget !== "string" && typeof widget?.mount !== "function") ||
              (typeof widget === "string" && widget.length > 512) ||
              host.widgetsById.has(`${entry.id}/${id}`)
            )
              throw new Error(`Invalid or duplicate web extension slot ${entry.id}/${id}`);
            const key = `${entry.id}/${id}`;
            host.widgetsById.set(key, widget);
            host.changed();
            const dispose = () => {
              if (host.widgetsById.delete(key)) host.changed();
            };
            host.disposers.push(dispose);
            return dispose;
          },
          registerToolRenderer: (name, render) =>
            host.registerRenderer(host.toolRenderers, entry.id, name, render, assertActive),
          registerMessageRenderer: (source, render) =>
            host.registerRenderer(host.messageRenderers, entry.id, source, render, assertActive),
          registerEntryRenderer: (channel, render) =>
            host.registerRenderer(host.entryRenderers, entry.id, channel, render, assertActive),
          onEvent: (handler) => {
            assertActive();
            if (typeof handler !== "function")
              throw new Error("Web event handler must be a function");
            return owned(host.eventHandlers, (event) =>
              handler({ ...event, signal: controller.signal }),
            );
          },
          registerMarkdownTransformer: (transform) => {
            assertActive();
            if (typeof transform !== "function")
              throw new Error("Web Markdown transformer must be a function");
            return owned(host.transformers, transform);
          },
        };
        const dispose = await definition.activate(api);
        if (typeof dispose === "function") host.disposers.push(dispose);
      }
      return host;
    } catch (error) {
      try {
        await host.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Web extension activation and cleanup failed",
        );
      }
      throw error;
    }
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    if (!this.active) throw new Error("Web extension host is disposed");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private registerRenderer(
    map: Map<string, (value: unknown) => string | undefined>,
    extensionId: string,
    name: string,
    render: (value: unknown) => string | undefined,
    assertActive: () => void,
  ): () => void {
    assertActive();
    if (
      typeof name !== "string" ||
      !/^[a-z][a-z0-9._:/-]{0,127}$/u.test(name) ||
      typeof render !== "function"
    )
      throw new Error("Invalid web renderer");
    const key = map === this.toolRenderers ? name : `${extensionId}/${name}`;
    if (map.has(key)) throw new Error(`Duplicate web renderer ${key}`);
    map.set(key, render);
    const dispose = () => {
      if (map.get(key) === render) map.delete(key);
    };
    this.disposers.push(dispose);
    return dispose;
  }

  private render(
    map: Map<string, (value: unknown) => string | undefined>,
    key: string,
    value: unknown,
  ): string | undefined {
    const renderer = map.get(key);
    if (renderer === undefined) return undefined;
    try {
      const result = renderer(value);
      if (result !== undefined && (typeof result !== "string" || result.length > 100_000))
        throw new Error("Web renderer returned invalid text");
      return result;
    } catch (cause) {
      return `Extension display failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  renderTool(name: string, tool: unknown): string | undefined {
    return this.render(this.toolRenderers, name, tool);
  }
  renderMessage(extensionId: string, source: string, event: unknown): string | undefined {
    return this.render(this.messageRenderers, `${extensionId}/${source}`, event);
  }
  renderEntry(extensionId: string, channel: string, event: unknown): string | undefined {
    return this.render(this.entryRenderers, `${extensionId}/${channel}`, event);
  }

  async dispatch(
    type: "session.event" | "working.start" | "working.end",
    event?: unknown,
  ): Promise<void> {
    const errors: unknown[] = [];
    for (const handler of [...this.eventHandlers]) {
      if (!this.active) break;
      try {
        await handler({ type, event });
      } catch (cause) {
        errors.push(cause);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Web extension event handler failed");
  }

  shortcut(key: string): (() => void | Promise<void>) | undefined {
    return this.shortcutsByKey.get(key)?.run;
  }

  commands(): readonly WebCommand[] {
    return [...this.commandsByName.values()];
  }
  statuses(): readonly string[] {
    return [...this.statusesById.values()];
  }
  widgets(): readonly string[] {
    return [...this.widgetsById.values()].filter(
      (value): value is string => typeof value === "string",
    );
  }
  widgetEntries(): readonly {
    readonly key: string;
    readonly widget:
      | string
      | { mount(root: HTMLElement, signal: AbortSignal): void | (() => void | Promise<void>) };
  }[] {
    return [...this.widgetsById].map(([key, widget]) => ({ key, widget }));
  }
  mountWidget(key: string, root: HTMLElement): () => Promise<void> {
    if (!this.active) throw new Error("Web extension host is disposed");
    const widget = this.widgetsById.get(key);
    if (typeof widget !== "object" || widget === null)
      throw new Error(`Web widget ${key} is unavailable`);
    const controller = new AbortController();
    this.controllers.push(controller);
    let cleanup: (() => void | Promise<void>) | undefined;
    try {
      const returned = widget.mount(root, controller.signal);
      if (returned !== undefined && typeof returned !== "function")
        throw new Error("Web widget cleanup must be a function");
      cleanup = returned ?? undefined;
    } catch (cause) {
      controller.abort();
      this.controllers.splice(this.controllers.indexOf(controller), 1);
      throw cause;
    }
    let unmounted: Promise<void> | undefined;
    // Host disposal and React unmount may both run; the widget cleanup runs exactly once.
    const unmount = (): Promise<void> => {
      unmounted ??= (async () => {
        controller.abort();
        const index = this.controllers.indexOf(controller);
        if (index !== -1) this.controllers.splice(index, 1);
        const disposerIndex = this.disposers.indexOf(unmount);
        if (disposerIndex !== -1) this.disposers.splice(disposerIndex, 1);
        await cleanup?.();
      })();
      return unmounted;
    };
    this.disposers.push(unmount);
    return unmount;
  }

  transform(text: string, role: "user" | "assistant"): string {
    let result = text;
    for (const transform of this.transformers) {
      result = transform(result, role);
      if (typeof result !== "string" || result.length > 100_000)
        throw new Error("Web Markdown transformer returned invalid text");
    }
    return result;
  }

  safeTransform(text: string, role: "user" | "assistant"): string {
    try {
      return this.transform(text, role);
    } catch (cause) {
      return `Extension display failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  /** Change only a derived display snapshot, never the SDK projection or canonical record. */
  display(conversation: ConversationState): ConversationState {
    return {
      ...conversation,
      records: conversation.records.map((record) => {
        if (record.kind !== "event") return record;
        const event = record.event;
        if (event.type !== "assistant.message" && event.type !== "user.message") return record;
        const role = event.type === "assistant.message" ? "assistant" : "user";
        return {
          ...record,
          event: {
            ...event,
            payload: {
              ...event.payload,
              content: event.payload.content.map((item) => {
                if (item.type !== "text") return item;
                return { ...item, text: this.safeTransform(item.text, role) };
              }),
            },
          },
        };
      }),
    } as ConversationState;
  }

  async dispose(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    for (const controller of this.controllers) controller.abort();
    const errors: unknown[] = [];
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        await dispose();
      } catch (cause) {
        errors.push(cause);
      }
    }
    this.commandsByName.clear();
    this.statusesById.clear();
    this.widgetsById.clear();
    this.shortcutsByKey.clear();
    this.toolRenderers.clear();
    this.messageRenderers.clear();
    this.entryRenderers.clear();
    this.eventHandlers.length = 0;
    this.listeners.clear();
    this.transformers.length = 0;
    if (errors.length > 0) throw new AggregateError(errors, "Web extension cleanup failed");
  }
}
