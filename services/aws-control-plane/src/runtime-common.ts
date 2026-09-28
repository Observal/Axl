// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/** Process wiring shared by the control plane's runtimes: settings, the witness, and serving. */

import { timingSafeEqual } from "node:crypto";
import { createServer, type RequestListener, type ServerResponse } from "node:http";
import type { WitnessGateway } from "@axl/control-plane";

import {
  createDeploymentTestWitness,
  parseDeploymentTestWitnessKeys,
} from "./witness-deployment-test.ts";
import { DynamoWitnessHighWaterJournal, DynamoWitnessReplicaStorage } from "./witness-dynamo.ts";

export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

export function secretEqual(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

/**
 * The in-process witness from the environment: signing keys in `AXL_TEST_WITNESS_KEYS` (optional:
 * without them the witness path stays unrouted and E2EE endpoints fail closed), replica records in
 * `AXL_WITNESS_TABLE` and their high-water journals in `AXL_WITNESS_JOURNAL_TABLE`.
 */
export async function witnessFromEnvironment(options: {
  /** Whether the control plane keeps DynamoDB state; the witness must too, so a restart never
   * silently empties it. */
  readonly durable: boolean;
  /** Admit only this account; without it, each account is admitted to its own lineages. */
  readonly accountId?: string;
}): Promise<WitnessGateway | undefined> {
  const witnessKeys = process.env.AXL_TEST_WITNESS_KEYS;
  const witnessTable = process.env.AXL_WITNESS_TABLE;
  const journalTable = process.env.AXL_WITNESS_JOURNAL_TABLE;
  if ((witnessTable === undefined) !== (journalTable === undefined)) {
    throw new Error("AXL_WITNESS_TABLE and AXL_WITNESS_JOURNAL_TABLE go together");
  }
  if (options.durable && witnessTable === undefined) {
    throw new Error("AXL_WITNESS_TABLE is required with DynamoDB state");
  }
  const stores =
    witnessTable === undefined || journalTable === undefined
      ? undefined
      : (key: { readonly replicaId: Uint8Array }) => ({
          storage: new DynamoWitnessReplicaStorage({
            tableName: witnessTable,
            replicaId: key.replicaId,
          }),
          journal: new DynamoWitnessHighWaterJournal({
            tableName: journalTable,
            replicaId: key.replicaId,
          }),
        });
  if (witnessKeys === undefined || witnessKeys.length === 0) return undefined;
  return createDeploymentTestWitness({
    keys: parseDeploymentTestWitnessKeys(witnessKeys),
    ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
    ...(stores === undefined ? {} : { stores }),
    onFailure({ stage, kind, lineageHash, cause }) {
      const error = cause as { readonly code?: unknown; readonly message?: unknown };
      process.stdout.write(
        `${JSON.stringify({
          witnessFailure: {
            stage,
            kind,
            ...(lineageHash === undefined ? {} : { lineageHash: lineageHash.slice(0, 16) }),
            code: typeof error.code === "string" ? error.code : "internal",
            message: typeof error.message === "string" ? error.message : String(cause),
          },
        })}\n`,
      );
    },
    audit(event) {
      process.stdout.write(`${JSON.stringify({ witnessAudit: event })}\n`);
    },
  });
}

/**
 * Serve `handler` on `PORT` (8080 by default) with a `/healthz` that reports the mode.
 *
 * On SIGTERM or SIGINT it drains: requests already received finish, each connection closes after
 * its response instead of being kept alive for more, and the process exits once none is left. A
 * witness step is written to three replicas, so a process killed while still taking requests could
 * leave one replica a step behind the others, which recovery then refuses for good.
 */
export function serve(
  handler: RequestListener,
  mode: "deployment-test" | "production",
  witness: boolean,
): void {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT is invalid");
  let draining = false;
  const open = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    open.add(response);
    response.on("close", () => open.delete(response));
    if (draining) response.setHeader("connection", "close");
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ status: "ok", mode, witness }));
      return;
    }
    handler(request, response);
  });
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`Axl ${mode} control plane listening on ${port}\n`);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (draining) return;
      draining = true;
      for (const response of open) {
        if (!response.headersSent) response.setHeader("connection", "close");
      }
      server.close(() => process.exit(0));
      server.closeIdleConnections();
    });
  }
}
