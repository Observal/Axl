// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { RpcResult, SessionConfiguration, SessionId } from "@axl/protocol";
import type { AxlClient } from "./client.ts";

export type SessionConfigurationField = keyof SessionConfiguration;

export interface SessionConfigurationState {
  readonly sessionId?: SessionId;
  readonly pending: readonly SessionConfigurationField[];
  readonly errors: Readonly<Partial<Record<SessionConfigurationField, string>>>;
  readonly effective?: RpcResult<"session.configure">;
}

export class SessionConfigurationController {
  private stateValue: SessionConfigurationState = { pending: [], errors: {} };
  private readonly listeners = new Set<(state: SessionConfigurationState) => void>();
  private readonly pendingCounts = new Map<SessionConfigurationField, number>();
  private tail = Promise.resolve();
  private generation = 0;
  private disposed = false;
  private readonly client: AxlClient;

  constructor(client: AxlClient) {
    this.client = client;
  }

  get state(): SessionConfigurationState {
    return this.stateValue;
  }

  subscribe(listener: (state: SessionConfigurationState) => void): () => void {
    this.listeners.add(listener);
    listener(this.stateValue);
    return () => this.listeners.delete(listener);
  }

  configure(
    sessionId: SessionId,
    update: SessionConfiguration,
  ): Promise<RpcResult<"session.configure">> {
    if (this.disposed) return Promise.reject(new Error("Configuration controller is disposed"));
    const fields = Object.keys(update) as SessionConfigurationField[];
    const generation = this.generation;
    for (const field of fields)
      this.pendingCounts.set(field, (this.pendingCounts.get(field) ?? 0) + 1);
    this.publish({ sessionId });
    const mutation = this.tail.then(async () => {
      try {
        const effective = await this.client.request("session.configure", { sessionId, ...update });
        const errors = { ...this.stateValue.errors };
        for (const field of fields) delete errors[field];
        this.publishForSession(sessionId, generation, { effective, errors });
        return effective;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Configuration failed";
        this.publishForSession(sessionId, generation, {
          errors: {
            ...this.stateValue.errors,
            ...Object.fromEntries(fields.map((field) => [field, message])),
          },
        });
        throw error;
      } finally {
        if (generation === this.generation) {
          for (const field of fields) {
            const count = (this.pendingCounts.get(field) ?? 1) - 1;
            if (count === 0) this.pendingCounts.delete(field);
            else this.pendingCounts.set(field, count);
          }
          this.publishForSession(sessionId, generation, {});
        }
      }
    });
    this.tail = mutation.then(
      () => undefined,
      () => undefined,
    );
    return mutation;
  }

  reset(sessionId?: SessionId): void {
    this.generation += 1;
    this.pendingCounts.clear();
    this.stateValue = {
      ...(sessionId === undefined ? {} : { sessionId }),
      pending: [],
      errors: {},
    };
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private publishForSession(
    sessionId: SessionId,
    generation: number,
    update: Partial<SessionConfigurationState>,
  ): void {
    if (generation === this.generation && this.stateValue.sessionId === sessionId) {
      this.publish(update);
    }
  }

  private publish(update: Partial<SessionConfigurationState>): void {
    this.stateValue = {
      ...this.stateValue,
      ...update,
      pending: [...this.pendingCounts.keys()],
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.stateValue);
  }
}
