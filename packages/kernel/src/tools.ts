// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type {
  EventPayloadMap,
  JsonObject,
  JsonValue,
  ToolDeclaration,
  UserContent,
} from "@axl/protocol";

export type SessionToolEffect =
  | {
      readonly type: "capability.searched";
      readonly payload: EventPayloadMap["capability.searched"];
    }
  | {
      readonly type: "capability.activated";
      readonly payload: EventPayloadMap["capability.activated"];
    }
  | { readonly type: "capability.denied"; readonly payload: EventPayloadMap["capability.denied"] };

export interface ToolExecutionResult {
  readonly content: readonly UserContent[];
  readonly isError: boolean;
  readonly details?: JsonValue;
  /** Canonical daemon effects applied only after the paired tool result is durable. */
  readonly sessionEffects?: readonly SessionToolEffect[];
}

export interface ToolExecutionContext {
  readonly activeCapabilities: ReadonlySet<string>;
  readonly reportProgress?: (progress: JsonValue) => void;
}

/** A canonical tool: identity, schema, and execution. Dialect rendering is provider-side. */
export interface KernelTool extends ToolDeclaration {
  execute(
    input: JsonObject,
    signal: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRegistryError";
  }
}

/**
 * Dispatch-registry membership is tool authority: a call is executable exactly
 * when its canonical name is registered here. Registration returns a disposer;
 * a disposer never removes a different tool registered later under the same
 * name.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, KernelTool>();
  private readonly capabilityTools = new Map<string, KernelTool>();

  register(tool: KernelTool): () => void {
    if (
      this.tools.has(tool.name) ||
      [...this.capabilityTools.values()].some((candidate) => candidate.name === tool.name)
    ) {
      throw new ToolRegistryError(`Tool ${tool.name} is already registered`);
    }
    this.tools.set(tool.name, tool);
    return () => {
      if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name);
    };
  }

  registerCapability(identity: string, tool: KernelTool): () => void {
    if (
      this.capabilityTools.has(identity) ||
      this.tools.has(tool.name) ||
      [...this.capabilityTools.values()].some((candidate) => candidate.name === tool.name)
    ) {
      throw new ToolRegistryError(
        `Capability tool ${identity} or ${tool.name} is already registered`,
      );
    }
    this.capabilityTools.set(identity, tool);
    return () => {
      if (this.capabilityTools.get(identity) !== tool) return;
      this.capabilityTools.delete(identity);
      if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name);
    };
  }

  activateCapability(identity: string): ToolDeclaration | undefined {
    const tool = this.capabilityTools.get(identity);
    if (tool === undefined || this.tools.get(tool.name) === tool) return undefined;
    this.tools.set(tool.name, tool);
    return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  }

  get(name: string): KernelTool | undefined {
    return this.tools.get(name);
  }

  declarations(): readonly ToolDeclaration[] {
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }
}
