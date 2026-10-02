// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import type { InteractionKind, RemoteDeviceScope, RpcMethod } from "@axl/protocol";

const REMOTE_RPC_SCOPES = Object.freeze({
  "daemon.info": "observe",
  "session.list": "observe",
  "session.history": "observe",
  "session.ack": "observe",
  "session.unsubscribe": "observe",
  "session.subscribe": "observe",
  "session.workspace.list": "observe",
  "session.workspace.read": "observe",
  "session.workspace.status": "observe",
  "session.workspace.diff": "observe",
  // Reopening a closed session starts its runtime, so it needs steer like the requests that follow.
  "session.resume": "steer",
  "session.send": "steer",
  "session.steer": "steer",
  "session.followUp": "steer",
  "session.interruptAndDeliver": "steer",
  "session.queue.enqueue": "steer",
  "session.queue.requeue": "steer",
  "session.interrupt": "steer",
  // Answers only the agent's questions to the user; see remoteRespondableInteraction.
  "session.interaction.respond": "steer",
} as const satisfies Partial<Record<RpcMethod, RemoteDeviceScope>>);

export type RemoteRpcMethod = keyof typeof REMOTE_RPC_SCOPES;

export function requiredRemoteScope(method: RpcMethod): RemoteDeviceScope | undefined {
  return REMOTE_RPC_SCOPES[method as RemoteRpcMethod];
}

/**
 * Interactions a remote device may resolve. Answering the agent's question is steering, like
 * sending a message. MCP tool approvals, sampling review, and elicitation approve actions, which
 * waits for the remote permission contract and its own scope, so they stay on the computer.
 */
const REMOTE_RESPONDABLE_INTERACTIONS: ReadonlySet<InteractionKind> = new Set(["user_question"]);

export function remoteRespondableInteraction(kind: InteractionKind): boolean {
  return REMOTE_RESPONDABLE_INTERACTIONS.has(kind);
}

export function remoteRpcMethods(): readonly RemoteRpcMethod[] {
  return Object.keys(REMOTE_RPC_SCOPES) as RemoteRpcMethod[];
}
