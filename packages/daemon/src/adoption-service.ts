// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type {
  AdoptionDiscoverParams,
  AdoptionDiscoverResult,
  AdoptionInspectParams,
  AdoptionInspectResult,
  AdoptionRpcMethodMap,
  ClientIdentity,
  JsonObject,
} from "@axl/protocol";

/** Safe request metadata passed to the daemon-owned adoption boundary. */
export interface AdoptionRequestContext {
  readonly attachmentId: string;
  readonly client: ClientIdentity;
  /** Exact canonical project roots already opened by an Axl session. */
  readonly openedProjectRoots: readonly string[];
}

/**
 * Daemon-facing adoption discovery boundary. Concrete compiler composition belongs
 * in the runtime package so the daemon never imports foreign-format parsers.
 */
export interface AdoptionService {
  discover(
    params: AdoptionDiscoverParams,
    context: AdoptionRequestContext,
    signal?: AbortSignal,
  ): Promise<AdoptionDiscoverResult>;
  inspect(
    params: AdoptionInspectParams,
    context: AdoptionRequestContext,
    signal?: AbortSignal,
  ): Promise<AdoptionInspectResult>;
  plan?(
    params: AdoptionRpcMethodMap["adoption.plan"]["params"],
    context: AdoptionRequestContext,
    signal?: AbortSignal,
  ): Promise<AdoptionRpcMethodMap["adoption.plan"]["result"]>;
  start?(
    params: AdoptionRpcMethodMap["adoption.start"]["params"],
    context: AdoptionRequestContext,
    signal?: AbortSignal,
  ): Promise<AdoptionRpcMethodMap["adoption.start"]["result"]>;
  approveActivation?(
    params: AdoptionRpcMethodMap["adoption.operation.approveActivation"]["params"],
    context: AdoptionRequestContext,
  ): Promise<AdoptionRpcMethodMap["adoption.operation.approveActivation"]["result"]>;
  prime?(): Promise<void>;
  dispose?(): Promise<void>;
}

/** Typed, disclosure-safe failure raised by an adoption service implementation. */
export class AdoptionServiceError extends Error {
  readonly code: string;
  readonly details: JsonObject | undefined;

  constructor(code: string, message: string, details?: JsonObject) {
    super(message);
    this.name = "AdoptionServiceError";
    this.code = code;
    this.details = details;
  }
}
