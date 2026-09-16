// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type {
  CapabilityActivationResult,
  CapabilityRecord,
  CapabilitySearchResult,
  CapabilitySummary,
} from "@axl/protocol";

const K1 = 1.2;
const B = 0.75;

function terms(value: string): readonly string[] {
  return value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function normalized(value: string): string {
  return terms(value).join(" ");
}

function summary(record: CapabilityRecord): CapabilitySummary {
  const { identity, kind, name, description, path, scope, provenance } = record;
  return { identity, kind, name, description, path, scope, provenance };
}

function searchableTerms(record: CapabilityRecord): readonly string[] {
  return [
    ...terms(record.name),
    ...terms(record.name),
    ...terms(record.name),
    ...record.aliases.flatMap((alias) => [...terms(alias), ...terms(alias)]),
    ...terms(record.description),
  ];
}

export interface CapabilityService {
  search(query: string, limit: number): Promise<CapabilitySearchResult>;
  activate(identities: readonly string[]): Promise<CapabilityActivationResult>;
  read(identity: string, path: string): Promise<string>;
}

export interface CapabilitySource {
  readonly records: readonly CapabilityRecord[];
  readonly service: CapabilityService;
}

/** One ranked catalog over independently owned capability implementations. */
export class CompositeCapabilityService implements CapabilityService {
  private readonly index: CapabilityIndex;
  private readonly services = new Map<string, CapabilityService>();

  constructor(sources: readonly CapabilitySource[], grantedAuthorities: ReadonlySet<string>) {
    const records: CapabilityRecord[] = [];
    for (const source of sources) {
      for (const record of source.records) {
        if (this.services.has(record.identity)) {
          throw new Error(`Duplicate capability identity ${record.identity}`);
        }
        this.services.set(record.identity, source.service);
        records.push(record);
      }
    }
    this.index = new CapabilityIndex(records, grantedAuthorities);
  }

  async search(query: string, limit: number): Promise<CapabilitySearchResult> {
    return { results: this.index.search(query, limit) };
  }

  async activate(identities: readonly string[]): Promise<CapabilityActivationResult> {
    const activated: CapabilityActivationResult["activated"][number][] = [];
    const denied: CapabilityActivationResult["denied"][number][] = [];
    for (const identity of identities) {
      const service = this.services.get(identity);
      if (service === undefined) {
        denied.push({ identity, reason: "capability is not indexed" });
        continue;
      }
      const result = await service.activate([identity]);
      activated.push(...result.activated);
      denied.push(...result.denied);
    }
    return { activated, denied };
  }

  async read(identity: string, path: string): Promise<string> {
    const service = this.services.get(identity);
    if (service === undefined) throw new Error(`Capability ${identity} is not indexed`);
    return service.read(identity, path);
  }
}

/** Fixed built-in capabilities whose activation exposes registered native tools. */
export class ToolCapabilityService implements CapabilityService {
  readonly records: readonly CapabilityRecord[];
  private readonly recordsByIdentity: ReadonlyMap<string, CapabilityRecord>;
  private readonly index: CapabilityIndex;
  private readonly grantedAuthorities: ReadonlySet<string>;

  constructor(records: readonly CapabilityRecord[], grantedAuthorities: ReadonlySet<string>) {
    this.records = records;
    this.recordsByIdentity = new Map(records.map((record) => [record.identity, record]));
    this.grantedAuthorities = grantedAuthorities;
    this.index = new CapabilityIndex(records, grantedAuthorities);
  }

  async search(query: string, limit: number): Promise<CapabilitySearchResult> {
    return { results: this.index.search(query, limit) };
  }

  async activate(identities: readonly string[]): Promise<CapabilityActivationResult> {
    const activated: CapabilityActivationResult["activated"][number][] = [];
    const denied: CapabilityActivationResult["denied"][number][] = [];
    for (const identity of identities) {
      const record = this.recordsByIdentity.get(identity);
      if (record === undefined) {
        denied.push({ identity, reason: "capability is not indexed" });
      } else if (!record.enabled || !record.available || record.trust !== "trusted") {
        denied.push({ identity, reason: "capability is unavailable" });
      } else if (
        record.requiredAuthority.some((authority) => !this.grantedAuthorities.has(authority))
      ) {
        denied.push({ identity, reason: "capability authority is unavailable" });
      } else {
        activated.push({
          capability: summary(record),
          content: `<capability identity="${record.identity}">The ${record.name} tool is active for this session.</capability>`,
        });
      }
    }
    return { activated, denied };
  }

  async read(identity: string): Promise<string> {
    throw new Error(`Capability ${identity} has no readable resources`);
  }
}

/** Disposable deterministic BM25 index over already validated capability metadata. */
export class CapabilityIndex {
  private readonly documents: readonly {
    readonly record: CapabilityRecord;
    readonly terms: readonly string[];
    readonly frequencies: ReadonlyMap<string, number>;
  }[];
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(records: readonly CapabilityRecord[], grantedAuthorities: ReadonlySet<string>) {
    this.documents = records
      .filter(
        (record) =>
          record.enabled &&
          record.available &&
          record.trust === "trusted" &&
          record.requiredAuthority.every((authority) => grantedAuthorities.has(authority)),
      )
      .map((record) => {
        const tokens = searchableTerms(record);
        const frequencies = new Map<string, number>();
        for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
        for (const token of frequencies.keys()) {
          this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
        }
        return { record, terms: tokens, frequencies };
      });
    this.averageLength =
      this.documents.length === 0
        ? 1
        : this.documents.reduce((total, document) => total + document.terms.length, 0) /
          this.documents.length;
  }

  search(query: string, limit: number): readonly CapabilitySummary[] {
    const queryTerms = [...new Set(terms(query))];
    if (queryTerms.length === 0) return [];
    const exactQuery = normalized(query);
    return this.documents
      .map((document) => {
        const exact =
          normalized(document.record.name) === exactQuery
            ? 2
            : document.record.aliases.some((alias) => normalized(alias) === exactQuery)
              ? 1
              : 0;
        let score = 0;
        for (const term of queryTerms) {
          const frequency = document.frequencies.get(term) ?? 0;
          if (frequency === 0) continue;
          const documentFrequency = this.documentFrequency.get(term) ?? 0;
          const inverseDocumentFrequency = Math.log(
            1 + (this.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5),
          );
          const lengthNormalization =
            frequency + K1 * (1 - B + B * (document.terms.length / this.averageLength));
          score += inverseDocumentFrequency * ((frequency * (K1 + 1)) / lengthNormalization);
        }
        return { document, exact, score };
      })
      .filter((match) => match.exact > 0 || match.score > 0)
      .sort(
        (left, right) =>
          right.exact - left.exact ||
          right.score - left.score ||
          (left.document.record.scope === right.document.record.scope
            ? 0
            : left.document.record.scope === "project"
              ? -1
              : 1) ||
          left.document.record.identity.localeCompare(right.document.record.identity),
      )
      .slice(0, limit)
      .map((match) => summary(match.document.record));
  }
}
