// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

export type ExtensionCapability =
  | "terminal.commands"
  | "terminal.shortcuts"
  | "terminal.status"
  | "terminal.widgets"
  | "terminal.events"
  | "terminal.tool-renderers";

export interface ExtensionManifest {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly ExtensionCapability[];
}

export type TerminalTone = "text" | "muted" | "accent" | "success" | "warning" | "error";

export interface TerminalLine {
  readonly text: string;
  readonly tone?: TerminalTone;
}

export interface TerminalCommandContext {
  readonly signal: AbortSignal;
  notify(message: string, tone?: Exclude<TerminalTone, "text">): void;
  select(
    title: string,
    items: readonly {
      readonly value: string;
      readonly label: string;
      readonly description?: string;
    }[],
  ): Promise<string | undefined>;
  getEditorText(): string;
  setEditorText(text: string): void;
}

export interface TerminalCommand {
  readonly name: string;
  readonly description: string;
  readonly complete?: (argumentPrefix: string) => readonly string[];
  readonly run: (arguments_: string, context: TerminalCommandContext) => void | Promise<void>;
}

export interface TerminalShortcut {
  readonly key: string;
  readonly description: string;
  readonly run: (context: TerminalCommandContext) => void | Promise<void>;
}

export interface TerminalWidget {
  readonly placement?: "aboveEditor" | "belowEditor";
  /** Increment when external widget state changes. */
  readonly revision?: number;
  render(width: number): readonly TerminalLine[];
  dispose?(): void | Promise<void>;
}

export interface TerminalToolRenderInput {
  readonly callId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly result?: string;
  readonly isError: boolean;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "denied" | "aborted";
  readonly durationMs?: number;
  readonly detail: "compact" | "full" | "focus";
}

export interface TerminalToolRenderResult {
  readonly label?: string;
  readonly target?: string;
  readonly lines?: readonly TerminalLine[];
  readonly hideWhenSuccessfulInFocus?: boolean;
}

export type TerminalToolRenderer = (
  input: TerminalToolRenderInput,
) => TerminalToolRenderResult | undefined;

export type TerminalExtensionEventInput =
  | { readonly type: "session.event"; readonly event: unknown }
  | { readonly type: "working.start" }
  | { readonly type: "working.end" };

export type TerminalExtensionEvent = TerminalExtensionEventInput & {
  readonly signal: AbortSignal;
};

export type ExtensionDisposer = () => void | Promise<void>;

export interface TerminalExtensionApi {
  registerCommand(command: TerminalCommand): ExtensionDisposer;
  registerShortcut(shortcut: TerminalShortcut): ExtensionDisposer;
  registerStatus(key: string, text: TerminalLine): ExtensionDisposer;
  registerWorkingLabel(label: string): ExtensionDisposer;
  registerWidget(key: string, widget: TerminalWidget): ExtensionDisposer;
  registerToolRenderer(toolName: string, renderer: TerminalToolRenderer): ExtensionDisposer;
  on(
    event: TerminalExtensionEventInput["type"],
    handler: (event: TerminalExtensionEvent) => void | Promise<void>,
  ): ExtensionDisposer;
  track(disposer: ExtensionDisposer): ExtensionDisposer;
}

export interface TerminalExtension {
  readonly manifest: ExtensionManifest;
  activate(
    api: TerminalExtensionApi,
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export interface OwnedTerminalCommand extends TerminalCommand {
  readonly extensionId: string;
}

export interface OwnedTerminalShortcut extends TerminalShortcut {
  readonly extensionId: string;
}

export interface OwnedTerminalToolRenderer {
  readonly extensionId: string;
  readonly renderer: TerminalToolRenderer;
}

interface OwnedStatus {
  readonly extensionId: string;
  readonly line: TerminalLine;
}

interface OwnedWidget {
  readonly extensionId: string;
  readonly widget: TerminalWidget;
}

interface OwnedListener {
  readonly extensionId: string;
  readonly handler: (event: TerminalExtensionEvent) => void | Promise<void>;
}

export interface TerminalExtensionHostOptions {
  readonly cleanupTimeoutMs?: number;
}

interface OwnedDisposer {
  readonly extensionId: string;
  readonly dispose: ExtensionDisposer;
}

const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const EXTENSION_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

export class ExtensionRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionRegistrationError";
  }
}

function once(dispose: ExtensionDisposer): ExtensionDisposer {
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    return dispose();
  };
}

async function withinCleanupBudget(
  tasks: readonly Promise<void>[],
  milliseconds: number,
): Promise<void> {
  if (tasks.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Extension cleanup exceeded ${milliseconds}ms`)),
      milliseconds,
    );
  });
  try {
    await Promise.race([Promise.all(tasks), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Owns trusted terminal registrations without exposing client or daemon internals. */
export class TerminalExtensionHost {
  private readonly definitions: readonly TerminalExtension[];
  private readonly commandsByName = new Map<string, OwnedTerminalCommand>();
  private readonly shortcutsByKey = new Map<string, OwnedTerminalShortcut>();
  private readonly statusesByKey = new Map<string, OwnedStatus>();
  private readonly widgetsByKey = new Map<string, OwnedWidget>();
  private readonly toolRenderersByName = new Map<string, OwnedTerminalToolRenderer>();
  private readonly listenersByEvent = new Map<
    TerminalExtensionEventInput["type"],
    Set<OwnedListener>
  >();
  private readonly workingLabels: Array<{ extensionId: string; label: string }> = [];
  private readonly pendingEvents = new Map<string, Set<Promise<Error | undefined>>>();
  private readonly lifecycles = new Map<string, AbortController>();
  private readonly activeExtensions = new Set<string>();
  private ownedDisposers: OwnedDisposer[] = [];
  private readonly cleanupTimeoutMs: number;
  private widgetRevisionValue = 0;
  private active = false;

  constructor(
    definitions: readonly TerminalExtension[] = [],
    options: TerminalExtensionHostOptions = {},
  ) {
    this.definitions = [...definitions];
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.cleanupTimeoutMs) || this.cleanupTimeoutMs < 1) {
      throw new ExtensionRegistrationError("cleanupTimeoutMs must be a positive integer");
    }
    const ids = new Set<string>();
    for (const definition of definitions) {
      const { id, name } = definition.manifest;
      if (!EXTENSION_ID.test(id))
        throw new ExtensionRegistrationError(`Invalid extension id ${id}`);
      if (!name.trim()) throw new ExtensionRegistrationError(`Extension ${id} has no display name`);
      if (ids.has(id)) throw new ExtensionRegistrationError(`Duplicate extension id ${id}`);
      ids.add(id);
    }
  }

  async activate(): Promise<void> {
    if (this.active) throw new ExtensionRegistrationError("Terminal extensions are already active");
    this.active = true;
    try {
      for (const definition of this.definitions)
        await this.activateExtension(definition.manifest.id);
    } catch (error) {
      try {
        await this.dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Extension activation cleanup failed");
      }
      throw error;
    }
  }

  async activateExtension(extensionId: string): Promise<void> {
    if (!this.active) throw new ExtensionRegistrationError("Terminal extension host is not active");
    if (this.activeExtensions.has(extensionId)) return;
    const definition = this.definitions.find((candidate) => candidate.manifest.id === extensionId);
    if (definition === undefined) {
      throw new ExtensionRegistrationError(`Unknown extension ${extensionId}`);
    }
    const lifecycle = new AbortController();
    this.lifecycles.set(extensionId, lifecycle);
    this.activeExtensions.add(extensionId);
    try {
      const cleanup = await definition.activate(this.apiFor(definition, lifecycle));
      if (cleanup !== undefined) {
        this.ownedDisposers.push({ extensionId, dispose: once(cleanup) });
      }
    } catch (error) {
      const activationError = new ExtensionRegistrationError(
        `Extension ${extensionId} failed to activate: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        await this.deactivate(extensionId);
      } catch (cleanupError) {
        throw new AggregateError(
          [activationError, cleanupError],
          `Extension ${extensionId} activation rollback failed`,
        );
      }
      throw activationError;
    }
  }

  async deactivate(extensionId: string): Promise<void> {
    if (!this.activeExtensions.has(extensionId)) return;
    this.activeExtensions.delete(extensionId);
    this.lifecycles.get(extensionId)?.abort();
    this.lifecycles.delete(extensionId);
    const failures: unknown[] = [];
    const owned = this.ownedDisposers.filter((entry) => entry.extensionId === extensionId);
    this.ownedDisposers = this.ownedDisposers.filter((entry) => entry.extensionId !== extensionId);
    const pending: Promise<void>[] = [];
    for (const entry of owned.reverse()) {
      try {
        const result = entry.dispose();
        if (result !== undefined) {
          pending.push(
            Promise.resolve(result).catch((error: unknown) => {
              failures.push(error);
            }),
          );
        }
      } catch (error) {
        failures.push(error);
      }
    }
    const eventWork = [...(this.pendingEvents.get(extensionId) ?? [])].map((task) =>
      task.then((error) => {
        if (error !== undefined) failures.push(error);
      }),
    );
    this.pendingEvents.delete(extensionId);
    try {
      await withinCleanupBudget([...pending, ...eventWork], this.cleanupTimeoutMs);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Extension ${extensionId} cleanup failed`);
    }
  }

  async reload(): Promise<void> {
    await this.dispose();
    await this.activate();
  }

  async dispose(): Promise<void> {
    const failures: unknown[] = [];
    for (const definition of [...this.definitions].reverse()) {
      try {
        await this.deactivate(definition.manifest.id);
      } catch (error) {
        failures.push(error);
      }
    }
    this.active = false;
    if (failures.length > 0)
      throw new AggregateError(failures, "Terminal extension cleanup failed");
  }

  extensionStates(): readonly { readonly id: string; readonly active: boolean }[] {
    return this.definitions.map((definition) => ({
      id: definition.manifest.id,
      active: this.activeExtensions.has(definition.manifest.id),
    }));
  }

  commands(): readonly OwnedTerminalCommand[] {
    return [...this.commandsByName.values()];
  }

  shortcuts(): readonly OwnedTerminalShortcut[] {
    return [...this.shortcutsByKey.values()];
  }

  statuses(): readonly TerminalLine[] {
    return [...this.statusesByKey.values()].map((status) => status.line);
  }

  get widgetRevision(): number {
    return this.widgetRevisionValue;
  }

  widgets(placement: "aboveEditor" | "belowEditor"): readonly TerminalWidget[] {
    return [...this.widgetsByKey.values()]
      .map((entry) => entry.widget)
      .filter((widget) => (widget.placement ?? "aboveEditor") === placement);
  }

  workingLabel(): string | undefined {
    return this.workingLabels.at(-1)?.label;
  }

  toolRenderer(name: string): OwnedTerminalToolRenderer | undefined {
    return this.toolRenderersByName.get(name);
  }

  async emit(input: TerminalExtensionEventInput): Promise<readonly Error[]> {
    if (!this.active) return [];
    const tasks: Promise<Error | undefined>[] = [];
    for (const listener of this.listenersByEvent.get(input.type) ?? []) {
      const lifecycle = this.lifecycles.get(listener.extensionId);
      if (lifecycle === undefined || lifecycle.signal.aborted) continue;
      const event = { ...input, signal: lifecycle.signal } as TerminalExtensionEvent;
      const task = Promise.resolve()
        .then(() => (lifecycle.signal.aborted ? undefined : listener.handler(event)))
        .then(
          () => undefined,
          (error: unknown) =>
            new Error(
              `Extension ${listener.extensionId} ${event.type} handler failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
        );
      const pending = this.pendingEvents.get(listener.extensionId) ?? new Set();
      pending.add(task);
      this.pendingEvents.set(listener.extensionId, pending);
      void task.finally(() => {
        pending.delete(task);
        if (pending.size === 0) this.pendingEvents.delete(listener.extensionId);
      });
      tasks.push(task);
    }
    const results = await Promise.all(tasks);
    return results.filter((error): error is Error => error !== undefined);
  }

  private apiFor(definition: TerminalExtension, lifecycle: AbortController): TerminalExtensionApi {
    const extensionId = definition.manifest.id;
    const declared = new Set(definition.manifest.capabilities);
    const assertActive = (): void => {
      if (
        !this.active ||
        this.lifecycles.get(extensionId) !== lifecycle ||
        lifecycle.signal.aborted
      ) {
        throw new ExtensionRegistrationError(`Extension ${extensionId} API is stale`);
      }
    };
    const requireCapability = (capability: ExtensionCapability): void => {
      assertActive();
      if (!declared.has(capability)) {
        throw new ExtensionRegistrationError(
          `Extension ${extensionId} did not declare capability ${capability}`,
        );
      }
    };
    const own = (dispose: ExtensionDisposer): ExtensionDisposer => {
      const tracked = once(dispose);
      this.ownedDisposers.push({ extensionId, dispose: tracked });
      return tracked;
    };
    return {
      registerCommand: (command) => {
        requireCapability("terminal.commands");
        if (!COMMAND_NAME.test(command.name)) {
          throw new ExtensionRegistrationError(`Invalid command name ${command.name}`);
        }
        if (this.commandsByName.has(command.name)) {
          throw new ExtensionRegistrationError(`Command /${command.name} is already registered`);
        }
        const owned = { ...command, extensionId };
        this.commandsByName.set(command.name, owned);
        return own(() => {
          if (this.commandsByName.get(command.name) === owned)
            this.commandsByName.delete(command.name);
        });
      },
      registerShortcut: (shortcut) => {
        requireCapability("terminal.shortcuts");
        if (!shortcut.key) throw new ExtensionRegistrationError("Shortcut key cannot be empty");
        if (this.shortcutsByKey.has(shortcut.key)) {
          throw new ExtensionRegistrationError(`Shortcut ${shortcut.key} is already registered`);
        }
        const owned = { ...shortcut, extensionId };
        this.shortcutsByKey.set(shortcut.key, owned);
        return own(() => {
          if (this.shortcutsByKey.get(shortcut.key) === owned)
            this.shortcutsByKey.delete(shortcut.key);
        });
      },
      registerStatus: (key, line) => {
        requireCapability("terminal.status");
        const owned = { extensionId, line };
        this.statusesByKey.set(`${extensionId}:${key}`, owned);
        return own(() => {
          if (this.statusesByKey.get(`${extensionId}:${key}`) === owned) {
            this.statusesByKey.delete(`${extensionId}:${key}`);
          }
        });
      },
      registerWorkingLabel: (label) => {
        requireCapability("terminal.status");
        const owned = { extensionId, label };
        this.workingLabels.push(owned);
        return own(() => {
          const index = this.workingLabels.indexOf(owned);
          if (index >= 0) this.workingLabels.splice(index, 1);
        });
      },
      registerWidget: (key, widget) => {
        requireCapability("terminal.widgets");
        const owned = { extensionId, widget };
        const registryKey = `${extensionId}:${key}`;
        if (this.widgetsByKey.has(registryKey)) {
          throw new ExtensionRegistrationError(`Widget ${registryKey} is already registered`);
        }
        this.widgetsByKey.set(registryKey, owned);
        this.widgetRevisionValue += 1;
        return own(async () => {
          if (this.widgetsByKey.get(registryKey) !== owned) return;
          this.widgetsByKey.delete(registryKey);
          this.widgetRevisionValue += 1;
          await widget.dispose?.();
        });
      },
      registerToolRenderer: (toolName, renderer) => {
        requireCapability("terminal.tool-renderers");
        if (this.toolRenderersByName.has(toolName)) {
          throw new ExtensionRegistrationError(`Tool renderer ${toolName} is already registered`);
        }
        const owned = { extensionId, renderer };
        this.toolRenderersByName.set(toolName, owned);
        return own(() => {
          if (this.toolRenderersByName.get(toolName) === owned) {
            this.toolRenderersByName.delete(toolName);
          }
        });
      },
      on: (event, handler) => {
        requireCapability("terminal.events");
        const owned = { extensionId, handler };
        const listeners = this.listenersByEvent.get(event) ?? new Set<OwnedListener>();
        listeners.add(owned);
        this.listenersByEvent.set(event, listeners);
        return own(() => {
          listeners.delete(owned);
          if (listeners.size === 0) this.listenersByEvent.delete(event);
        });
      },
      track: (disposer) => {
        assertActive();
        return own(disposer);
      },
    };
  }
}
