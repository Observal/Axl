// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import type { RemoteDeviceScope, RpcMethod } from "@axl/protocol";

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
  "session.send": "steer",
  "session.steer": "steer",
  "session.followUp": "steer",
  "session.interruptAndDeliver": "steer",
  "session.queue.enqueue": "steer",
  "session.queue.requeue": "steer",
  "session.interrupt": "steer",
} as const satisfies Partial<Record<RpcMethod, RemoteDeviceScope>>);

export type RemoteRpcMethod = keyof typeof REMOTE_RPC_SCOPES;

export function requiredRemoteScope(method: RpcMethod): RemoteDeviceScope | undefined {
  return REMOTE_RPC_SCOPES[method as RemoteRpcMethod];
}

export function remoteRpcMethods(): readonly RemoteRpcMethod[] {
  return Object.keys(REMOTE_RPC_SCOPES) as RemoteRpcMethod[];
}
