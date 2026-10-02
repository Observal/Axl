// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import {
  parseRelayRevocationNotification,
  parseRelayRevocationResult,
  type RelayRevocationNotification,
  type RelayRevocationResult,
} from "@axl/protocol";

export interface AuthenticatedRelayInternalTransport {
  post(path: string, body: unknown): Promise<unknown>;
}

export class RelayRevocationNotifier {
  private readonly transport: AuthenticatedRelayInternalTransport;

  constructor(transport: AuthenticatedRelayInternalTransport) {
    this.transport = transport;
  }

  async notify(value: RelayRevocationNotification): Promise<RelayRevocationResult> {
    const notification = parseRelayRevocationNotification(value);
    const response = await this.transport.post("/internal/v1/revocations", notification);
    return parseRelayRevocationResult(response);
  }
}
