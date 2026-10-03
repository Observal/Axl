// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * An in-memory DynamoDB endpoint for tests: the JSON protocol subset the control-plane stores use
 * (GetItem, PutItem, unconditional DeleteItem, UpdateItem with SET, Query by partition, Scan,
 * TransactWriteItems of at most 100 Puts and Deletes) and
 * conditions that are conjunctions of `attribute_exists`, `attribute_not_exists`, and `=`, `<`, or
 * `>` comparisons. Anything else is a ValidationException, so a store that starts relying on more
 * DynamoDB behavior fails its tests instead of passing against a fake that guessed.
 */

import { once } from "node:events";
import { createServer, type Server } from "node:http";

type AttributeValue = Readonly<Record<string, unknown>>;
type Item = Readonly<Record<string, AttributeValue>>;

class DynamoError extends Error {
  readonly type: string;
  readonly extra: Record<string, unknown>;

  constructor(type: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.type = type;
    this.extra = extra;
  }
}

function text(value: AttributeValue | undefined, name: string): string {
  const result = value?.S;
  if (typeof result !== "string") throw new DynamoError("ValidationException", `${name} must be S`);
  return result;
}

export interface FakeDynamoDb {
  readonly endpoint: string;
  /** Items per page when a Query sets no Limit; small, so tests cross page boundaries. */
  pageSize: number;
  /** The number of requests served per operation. */
  readonly calls: Map<string, number>;
  items(table: string): Item[];
  close(): Promise<void>;
}

export async function startFakeDynamoDb(port = 0): Promise<FakeDynamoDb> {
  const tables = new Map<string, Map<string, Item>>();
  const calls = new Map<string, number>();
  const table = (name: unknown) => {
    if (typeof name !== "string" || name.length === 0) {
      throw new DynamoError("ValidationException", "TableName is required");
    }
    let found = tables.get(name);
    if (found === undefined) {
      found = new Map();
      tables.set(name, found);
    }
    return found;
  };
  const keyOf = (key: Item) =>
    `${text(key.pk, "pk")}\u0000${key.sk === undefined ? "" : text(key.sk, "sk")}`;
  const attributeName = (token: string, names: Record<string, string> | undefined) => {
    const name = token.startsWith("#") ? names?.[token] : token;
    if (name === undefined) throw new DynamoError("ValidationException", `Unknown name ${token}`);
    return name;
  };
  const conditionHolds = (
    existing: Item | undefined,
    condition: unknown,
    values: Record<string, AttributeValue> | undefined,
    names?: Record<string, string>,
  ) => {
    if (condition === undefined) return true;
    if (typeof condition !== "string") {
      throw new DynamoError("ValidationException", "ConditionExpression must be a string");
    }
    return condition.split(" AND ").every((term) => {
      const exists = /^attribute_(not_)?exists\((#?\w+)\)$/u.exec(term);
      if (exists !== null) {
        const present = existing?.[attributeName(exists[2] ?? "", names)] !== undefined;
        return exists[1] === undefined ? present : !present;
      }
      const comparison = /^(#?\w+) (=|<|>) (:\w+)$/u.exec(term);
      if (comparison === null) {
        throw new DynamoError("ValidationException", `Unsupported condition ${term}`);
      }
      const actual = existing?.[attributeName(comparison[1] ?? "", names)];
      const expected = values?.[comparison[3] ?? ""];
      if (actual === undefined || expected === undefined) return false;
      if (comparison[2] === "=") return JSON.stringify(actual) === JSON.stringify(expected);
      if (typeof actual.N !== "string" || typeof expected.N !== "string") {
        throw new DynamoError("ValidationException", "Only numbers are ordered");
      }
      return comparison[2] === "<"
        ? Number(actual.N) < Number(expected.N)
        : Number(actual.N) > Number(expected.N);
    });
  };
  const operations: Record<string, (input: Record<string, unknown>) => unknown> = {
    GetItem(input) {
      const item = table(input.TableName).get(keyOf(input.Key as Item));
      return item === undefined ? {} : { Item: item };
    },
    PutItem(input) {
      const items = table(input.TableName);
      const item = input.Item as Item;
      const key = keyOf(item);
      if (
        !conditionHolds(
          items.get(key),
          input.ConditionExpression,
          input.ExpressionAttributeValues as Record<string, AttributeValue> | undefined,
          input.ExpressionAttributeNames as Record<string, string> | undefined,
        )
      ) {
        throw new DynamoError("ConditionalCheckFailedException", "The conditional request failed");
      }
      items.set(key, structuredClone(item));
      return {};
    },
    UpdateItem(input) {
      const items = table(input.TableName);
      const key = keyOf(input.Key as Item);
      const values = input.ExpressionAttributeValues as Record<string, AttributeValue> | undefined;
      const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
      const existing = items.get(key);
      if (!conditionHolds(existing, input.ConditionExpression, values, names)) {
        throw new DynamoError("ConditionalCheckFailedException", "The conditional request failed");
      }
      const update = String(input.UpdateExpression ?? "");
      if (!update.startsWith("SET ")) {
        throw new DynamoError("ValidationException", "Only SET updates are supported");
      }
      const next: Record<string, AttributeValue> = {
        ...structuredClone(existing ?? {}),
        ...structuredClone(input.Key as Item),
      };
      for (const assignment of update.slice(4).split(",")) {
        const match = /^\s*(#?\w+) = (:\w+)\s*$/u.exec(assignment);
        const value = values?.[match?.[2] ?? ""];
        if (match === null || value === undefined) {
          throw new DynamoError("ValidationException", `Unsupported update ${assignment}`);
        }
        next[attributeName(match[1] ?? "", names)] = structuredClone(value);
      }
      items.set(key, next);
      return {};
    },
    Query(input) {
      if (input.KeyConditionExpression !== "pk = :pk") {
        throw new DynamoError("ValidationException", "Only pk = :pk queries are supported");
      }
      const partition = text(
        (input.ExpressionAttributeValues as Record<string, AttributeValue>)[":pk"],
        ":pk",
      );
      const forward = input.ScanIndexForward !== false;
      const matching = [...table(input.TableName).values()]
        .filter((item) => item.pk?.S === partition)
        .sort((left, right) => {
          const order = String(left.sk?.S ?? "").localeCompare(String(right.sk?.S ?? ""));
          return forward ? order : -order;
        });
      const start = input.ExclusiveStartKey as Item | undefined;
      const from =
        start === undefined ? 0 : matching.findIndex((item) => keyOf(item) === keyOf(start)) + 1;
      const limit = typeof input.Limit === "number" ? input.Limit : fake.pageSize;
      const page = matching.slice(from, from + limit);
      const last = page.at(-1);
      return {
        Items: page,
        Count: page.length,
        ...(from + limit < matching.length && last !== undefined
          ? {
              LastEvaluatedKey: {
                pk: last.pk,
                ...(last.sk === undefined ? {} : { sk: last.sk }),
              },
            }
          : {}),
      };
    },
    DeleteItem(input) {
      if (input.ConditionExpression !== undefined) {
        throw new DynamoError("ValidationException", "Conditional deletes are not supported");
      }
      table(input.TableName).delete(keyOf(input.Key as Item));
      return {};
    },
    Scan(input) {
      const projection =
        input.ProjectionExpression === undefined
          ? undefined
          : String(input.ProjectionExpression).split(/,\s*/u);
      const matching = [...table(input.TableName).values()].sort((left, right) =>
        keyOf(left).localeCompare(keyOf(right)),
      );
      const start = input.ExclusiveStartKey as Item | undefined;
      const from =
        start === undefined ? 0 : matching.findIndex((item) => keyOf(item) === keyOf(start)) + 1;
      const page = matching.slice(from, from + fake.pageSize);
      const last = page.at(-1);
      return {
        Items: page.map((item) =>
          projection === undefined
            ? item
            : Object.fromEntries(projection.map((name) => [name, item[name]])),
        ),
        Count: page.length,
        ...(from + fake.pageSize < matching.length && last !== undefined
          ? { LastEvaluatedKey: { pk: last.pk, ...(last.sk === undefined ? {} : { sk: last.sk }) } }
          : {}),
      };
    },
    TransactWriteItems(input) {
      const entries = input.TransactItems as {
        readonly Put?: Record<string, unknown>;
        readonly Delete?: Record<string, unknown>;
      }[];
      if (entries.length > 100) {
        throw new DynamoError("ValidationException", "A transaction holds at most 100 items");
      }
      const writes = entries.map((entry) => {
        const write = (
          request: Record<string, unknown>,
          key: Item,
          put: Item | undefined,
        ): {
          readonly TableName: unknown;
          readonly ConditionExpression: unknown;
          readonly ExpressionAttributeValues: unknown;
          readonly key: Item;
          readonly put: Item | undefined;
        } => ({
          TableName: request.TableName,
          ConditionExpression: request.ConditionExpression,
          ExpressionAttributeValues: request.ExpressionAttributeValues,
          key,
          put,
        });
        if (entry.Put !== undefined && entry.Delete === undefined) {
          return write(entry.Put, entry.Put.Item as Item, entry.Put.Item as Item);
        }
        if (entry.Delete !== undefined && entry.Put === undefined) {
          return write(entry.Delete, entry.Delete.Key as Item, undefined);
        }
        throw new DynamoError(
          "ValidationException",
          "Only Put and Delete transaction items are supported",
        );
      });
      const keys = writes.map((write) => `${String(write.TableName)}\u0001${keyOf(write.key)}`);
      if (new Set(keys).size !== keys.length) {
        throw new DynamoError("ValidationException", "Transaction writes one item twice");
      }
      const reasons = writes.map((write) => {
        const existing = table(write.TableName).get(keyOf(write.key));
        return conditionHolds(
          existing,
          write.ConditionExpression,
          write.ExpressionAttributeValues as Record<string, AttributeValue> | undefined,
        )
          ? { Code: "None" }
          : { Code: "ConditionalCheckFailed", Message: "The conditional request failed" };
      });
      if (reasons.some((reason) => reason.Code !== "None")) {
        throw new DynamoError("TransactionCanceledException", "Transaction cancelled", {
          CancellationReasons: reasons,
        });
      }
      for (const write of writes) {
        if (write.put === undefined) table(write.TableName).delete(keyOf(write.key));
        else table(write.TableName).set(keyOf(write.key), structuredClone(write.put));
      }
      return {};
    },
  };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const target = String(request.headers["x-amz-target"] ?? "");
      const operation = target.split(".")[1] ?? "";
      calls.set(operation, (calls.get(operation) ?? 0) + 1);
      let status = 200;
      let body: unknown;
      try {
        const handler = operations[operation];
        if (handler === undefined) {
          throw new DynamoError("UnknownOperationException", `Unsupported ${operation}`);
        }
        body = handler(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (cause) {
        status = 400;
        body =
          cause instanceof DynamoError
            ? {
                __type: `com.amazonaws.dynamodb.v20120810#${cause.type}`,
                message: cause.message,
                ...cause.extra,
              }
            : {
                __type: "com.amazonaws.dynamodb.v20120810#InternalServerError",
                message: String(cause),
              };
        if (!(cause instanceof DynamoError)) status = 500;
      }
      response.writeHead(status, { "content-type": "application/x-amz-json-1.0" });
      response.end(JSON.stringify(body));
    });
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("No listening address");
  const fake: FakeDynamoDb = {
    endpoint: `http://127.0.0.1:${address.port}`,
    pageSize: 1_000,
    calls,
    items: (name) => [...(tables.get(name)?.values() ?? [])].map((item) => structuredClone(item)),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return fake;
}

// Run as a process for the phone E2E stack: `node fake-dynamodb.ts <port>`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeDynamoDb(Number(process.argv[2] ?? 0));
  process.stdout.write(`fake DynamoDB listening on ${fake.endpoint}\n`);
}
