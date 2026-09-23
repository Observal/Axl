// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { WebExtension, WebExtensionApi } from "@axl/extension-api";
import type { ConversationState, ExtensionListResult } from "@axl/sdk";

interface WebCommand {
  readonly extensionId: string;
  readonly name: string;
  readonly description: string;
  run(argument: string): void | Promise<void>;
}

/** Browser-local presentation only. Canonical session operations remain SDK-owned. */
export class WebExtensionHost {
  private readonly controllers: AbortController[] = [];
  private readonly disposers: (() => void | Promise<void>)[] = [];
  private readonly commandsByName = new Map<string, WebCommand>();
  private readonly statusesById = new Map<string, string>();
  private readonly widgetsById = new Map<string, string>();
  private readonly transformers: ((text: string, role: "user" | "assistant") => string)[] = [];
  private active = true;

  private constructor() {}

  static async load(
    inventory: ExtensionListResult,
    sessionId: string,
    baseUrl: string,
    notify: (message: string) => void,
    importModule: (url: string) => Promise<unknown> = (url) => import(/* @vite-ignore */ url),
  ): Promise<WebExtensionHost> {
    const host = new WebExtensionHost();
    try {
      for (const entry of inventory.extensions) {
        if (!entry.enabled || entry.webPath === undefined) continue;
        const url = new URL(
          `extension/${encodeURIComponent(sessionId)}/${encodeURIComponent(entry.id)}.mjs`,
          baseUrl,
        );
        // A new URL invalidates the browser module cache on explicit reload.
        url.searchParams.set("reload", crypto.randomUUID());
        const module = (await importModule(url.href)) as { default?: unknown };
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
          const dispose = () => {
            map.delete(key);
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
          registerWidget: (id, text) => registerText(host.widgetsById, id, text),
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

  commands(): readonly WebCommand[] {
    return [...this.commandsByName.values()];
  }
  statuses(): readonly string[] {
    return [...this.statusesById.values()];
  }
  widgets(): readonly string[] {
    return [...this.widgetsById.values()];
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
    for (const dispose of this.disposers.reverse()) {
      try {
        await dispose();
      } catch (cause) {
        errors.push(cause);
      }
    }
    this.disposers.length = 0;
    this.commandsByName.clear();
    this.statusesById.clear();
    this.widgetsById.clear();
    this.transformers.length = 0;
    if (errors.length > 0) throw new AggregateError(errors, "Web extension cleanup failed");
  }
}
