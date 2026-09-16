// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireGitSource,
  acquireNpmSource,
  DiscoveryError,
  type GitCommandRunner,
  immutableTreeSha256,
  inspectSource,
  materializeNpmDependencyLock,
  type NpmAcquisitionDependencies,
  type NpmAcquisitionResult,
  type NpmLockValidationPolicy,
  publishLocalSnapshot,
  resolveNpmDependencyLock,
  type SandboxedNpmLockResolver,
  type SourceInspection,
  sha256,
  type ValidatedNpmLock,
  type ValidatedNpmLockPackage,
} from "@axl/compiler";
import type { AdoptionStore, PublishedRevision, PublishRevisionInput } from "@axl/daemon";
import type {
  AdoptionManifest,
  AdoptionManifestFile,
  AdoptionOperationId,
  AdoptionSourceLocator,
  AdoptionSourceLock,
} from "@axl/protocol";

export interface AdoptionAcquisitionRequest {
  readonly operationId: AdoptionOperationId;
  readonly locator: AdoptionSourceLocator;
  readonly selectionKind: "discovered" | "explicit";
  readonly expectedDiscoveryFingerprint?: string;
  readonly resolveDiscoveryFingerprint?: Parameters<
    typeof inspectSource
  >[0]["resolveDiscoveryFingerprint"];
  readonly npm?: Omit<Parameters<typeof acquireNpmSource>[1], "destination">;
  readonly npmDependencies?: NpmAcquisitionDependencies;
  readonly npmLockResolver?: SandboxedNpmLockResolver;
  readonly npmLockPolicy?: Omit<NpmLockValidationPolicy, "expectedRootDependencies">;
  readonly npmDependencyAcquirer?: (
    item: ValidatedNpmLockPackage,
    destination: string,
  ) => Promise<NpmAcquisitionResult>;
  readonly gitExecutable?: string;
  readonly gitRunner?: GitCommandRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface AcquiredAdoptionSource {
  readonly lock: AdoptionSourceLock;
  readonly sourceUri: string;
  readonly sourceDirectory: string;
  readonly sourceFiles: readonly AdoptionManifestFile[];
  readonly sourceContentSha256: string;
  readonly fileInventorySha256: string;
  readonly inspection?: SourceInspection;
  readonly dependencyLock?: ValidatedNpmLock;
  /** Private daemon-owned staging root removed after publication. */
  readonly cleanupDirectory?: string;
}

export interface AcquireAndPublishRequest extends AdoptionAcquisitionRequest {
  readonly createManifest: (
    source: AcquiredAdoptionSource,
  ) => AdoptionManifest | Promise<AdoptionManifest>;
  readonly additionalArtifacts?: PublishRevisionInput["artifacts"];
}

function sourceFiles(
  files: readonly {
    readonly relativePath: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly executable: boolean;
  }[],
): readonly AdoptionManifestFile[] {
  return Object.freeze(
    [...files]
      .sort((left, right) =>
        left.relativePath < right.relativePath
          ? -1
          : left.relativePath > right.relativePath
            ? 1
            : 0,
      )
      .map((file) =>
        Object.freeze({
          path: file.relativePath,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
          executable: file.executable,
        }),
      ),
  );
}

async function hasNpmRuntimeDependencies(sourceDirectory: string): Promise<boolean> {
  let parsed: unknown;
  try {
    const bytes = await readFile(join(sourceDirectory, "package.json"));
    if (bytes.byteLength > 262_144) throw new Error("package manifest exceeds the byte limit");
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("acquired npm package has no valid bounded package.json", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("acquired npm package manifest is not an object");
  let found = false;
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const dependencies = (parsed as Record<string, unknown>)[field];
    if (dependencies === undefined) continue;
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies))
      throw new Error(`acquired npm ${field} are invalid`);
    for (const [name, selector] of Object.entries(dependencies)) {
      if (
        name.length === 0 ||
        Buffer.byteLength(name, "utf8") > 214 ||
        typeof selector !== "string" ||
        selector.length === 0 ||
        Buffer.byteLength(selector, "utf8") > 512
      )
        throw new Error(`acquired npm ${field} contain an invalid dependency`);
      found = true;
    }
  }
  return found;
}

function provenance(
  lock: AdoptionSourceLock,
  sourceUri: string,
  sourceDirectory: string,
  files: readonly AdoptionManifestFile[],
  inspection?: SourceInspection,
  cleanupDirectory?: string,
  dependencyLock?: ValidatedNpmLock,
): AcquiredAdoptionSource {
  return Object.freeze({
    lock,
    sourceUri,
    sourceDirectory,
    sourceFiles: files,
    sourceContentSha256: immutableTreeSha256(
      files.map((file) => ({
        relativePath: file.path,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        executable: file.executable,
      })),
    ),
    fileInventorySha256: sha256(JSON.stringify(files)),
    ...(inspection === undefined ? {} : { inspection }),
    ...(cleanupDirectory === undefined ? {} : { cleanupDirectory }),
    ...(dependencyLock === undefined ? {} : { dependencyLock }),
  });
}

/**
 * Runtime composition for Stage 4. The daemon owns all writable paths; compiler
 * acquisition code receives only a private operation workspace.
 */
export class AdoptionAcquisitionCoordinator {
  readonly #store: AdoptionStore;

  constructor(store: AdoptionStore) {
    this.#store = store;
  }

  async #acquire(request: AdoptionAcquisitionRequest): Promise<AcquiredAdoptionSource> {
    if (request.selectionKind === "discovered") {
      if (
        request.locator.kind !== "local" ||
        request.expectedDiscoveryFingerprint === undefined ||
        request.resolveDiscoveryFingerprint === undefined
      )
        throw new TypeError("discovered acquisition requires local fingerprint revalidation");
    }

    if (request.locator.kind === "local") {
      const inspection =
        request.expectedDiscoveryFingerprint === undefined ||
        request.resolveDiscoveryFingerprint === undefined
          ? undefined
          : await inspectSource({
              sourceRoot: request.locator.canonicalPath,
              expectedDiscoveryFingerprint: request.expectedDiscoveryFingerprint,
              resolveDiscoveryFingerprint: request.resolveDiscoveryFingerprint,
            });
      const published = await publishLocalSnapshot({
        storeRoot: await this.#store.localSourceCacheRoot(),
        sourceRoot: request.locator.canonicalPath,
      });
      if (inspection !== undefined && inspection.treeSha256 !== published.lock.treeSha256)
        throw new DiscoveryError(
          "adoption_source_changed",
          "source changed between fingerprint validation and immutable publication",
        );
      return provenance(
        published.lock,
        pathToFileURL(request.locator.canonicalPath).href,
        published.sourceDirectory,
        sourceFiles(published.inventory),
        inspection,
      );
    }

    const workspace = await this.#store.createAcquisitionWorkspace(request.operationId);
    const destination = join(workspace, "source");
    try {
      if (request.locator.kind === "npm") {
        if (request.npm === undefined) throw new TypeError("npm acquisition options are required");
        const acquired = await acquireNpmSource(
          request.locator,
          {
            ...request.npm,
            destination,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          },
          {
            ...request.npmDependencies,
            cache: request.npmDependencies?.cache ?? this.#store.immutableArtifactCache(),
          },
        );
        let dependencyLock: ValidatedNpmLock | undefined;
        if (await hasNpmRuntimeDependencies(destination)) {
          if (request.npmLockResolver === undefined || request.npmDependencyAcquirer === undefined)
            throw new TypeError(
              "npm packages with dependencies require the pinned sandbox resolver and materializer",
            );
          dependencyLock = await resolveNpmDependencyLock(
            acquired.lock.packageName,
            acquired.lock.version,
            acquired.lock.registryOrigin,
            request.npmLockResolver,
            request.npmLockPolicy,
          );
          await materializeNpmDependencyLock(
            dependencyLock,
            join(destination, "dependencies"),
            request.npmDependencyAcquirer,
          );
        }
        const inspection = await inspectSource({ sourceRoot: destination });
        if (dependencyLock === undefined && inspection.treeSha256 !== acquired.snapshot.treeSha256)
          throw new DiscoveryError(
            "adoption_source_changed",
            "npm source changed before immutable publication",
          );
        return provenance(
          acquired.lock,
          acquired.sourceUri,
          destination,
          sourceFiles(inspection.inventory),
          inspection,
          workspace,
          dependencyLock,
        );
      }
      if (request.gitExecutable === undefined)
        throw new TypeError("Git acquisition requires an absolute executable path");
      const acquired = await acquireGitSource(
        request.locator,
        {
          destination,
          gitExecutable: request.gitExecutable,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        },
        request.gitRunner,
      );
      const lock: AdoptionSourceLock = {
        kind: "git",
        repositoryUri: acquired.lock.repositoryUri,
        commit: acquired.lock.commit,
        treeSha256: acquired.lock.treeSha256,
      };
      const inspection = await inspectSource({ sourceRoot: destination });
      if (inspection.treeSha256 !== acquired.snapshot.treeSha256)
        throw new DiscoveryError(
          "adoption_source_changed",
          "Git source changed before immutable publication",
        );
      return provenance(
        lock,
        acquired.sourceUri,
        destination,
        sourceFiles(inspection.inventory),
        inspection,
        workspace,
      );
    } catch (error) {
      await this.#store.discardAcquisitionWorkspace(workspace);
      throw error;
    }
  }

  async acquireAndPublish(request: AcquireAndPublishRequest): Promise<PublishedRevision> {
    let sequence = 0;
    let acquired: AcquiredAdoptionSource | undefined;
    let manifest: AdoptionManifest | undefined;
    await this.#store.beginAcquisitionOperation(request.operationId, request.locator);
    try {
      acquired = await this.#acquire(request);
      sequence += 1;
      await this.#store.appendAcquisitionOperation({
        version: 1,
        operationId: request.operationId,
        sequence,
        state: "acquired",
        updatedAt: new Date().toISOString(),
        source: request.locator,
        sourceLock: acquired.lock,
      });
      manifest = await request.createManifest(acquired);
      const acquiredSource = acquired;
      if (acquiredSource.dependencyLock !== undefined) {
        const expected = acquiredSource.dependencyLock.packages.filter(
          (item) =>
            !(
              acquiredSource.lock.kind === "npm" &&
              item.name === acquiredSource.lock.packageName &&
              item.version === acquiredSource.lock.version &&
              item.path === `node_modules/${item.name}`
            ),
        );
        if (
          manifest.dependencies.length !== expected.length ||
          expected.some(
            (item) =>
              !manifest?.dependencies.some(
                (dependency) =>
                  dependency.name === item.name &&
                  dependency.source === item.resolved &&
                  dependency.immutableIdentity === item.version &&
                  dependency.integrity === item.integrity,
              ),
          )
        )
          throw new TypeError("adoption manifest does not record the complete npm dependency lock");
      }
      sequence += 1;
      await this.#store.appendAcquisitionOperation({
        version: 1,
        operationId: request.operationId,
        sequence,
        state: "publishing",
        updatedAt: new Date().toISOString(),
        source: request.locator,
        sourceLock: acquired.lock,
        target: {
          ecosystem: manifest.ecosystem,
          packageId: manifest.packageId,
          revisionId: manifest.revisionId,
        },
      });
      const artifacts: PublishRevisionInput["artifacts"][number][] = [];
      for (const file of acquired.sourceFiles) {
        artifacts.push({
          kind: "source",
          path: file.path,
          bytes: await readFile(join(acquired.sourceDirectory, ...file.path.split("/"))),
          executable: file.executable,
        });
      }
      artifacts.push(...(request.additionalArtifacts ?? []));
      const published = await this.#store.publishRevision({ manifest, artifacts });
      sequence += 1;
      await this.#store.appendAcquisitionOperation({
        version: 1,
        operationId: request.operationId,
        sequence,
        state: "published",
        updatedAt: new Date().toISOString(),
        source: request.locator,
        sourceLock: acquired.lock,
        target: {
          ecosystem: manifest.ecosystem,
          packageId: manifest.packageId,
          revisionId: manifest.revisionId,
        },
      });
      return published;
    } catch (error) {
      let publicationExists = false;
      if (manifest !== undefined) {
        try {
          await this.#store.readRevision(
            manifest.ecosystem,
            manifest.packageId,
            manifest.revisionId,
          );
          publicationExists = true;
        } catch {
          publicationExists = false;
        }
      }
      const current = await this.#store.readAcquisitionOperation(request.operationId);
      sequence = current?.sequence ?? sequence;
      await this.#store.appendAcquisitionOperation({
        version: 1,
        operationId: request.operationId,
        sequence: sequence + 1,
        state: publicationExists ? "published" : "failed",
        updatedAt: new Date().toISOString(),
        source: request.locator,
        ...(acquired === undefined ? {} : { sourceLock: acquired.lock }),
        ...(manifest === undefined
          ? {}
          : {
              target: {
                ecosystem: manifest.ecosystem,
                packageId: manifest.packageId,
                revisionId: manifest.revisionId,
              },
            }),
        ...(!publicationExists
          ? {
              errorCode:
                typeof error === "object" && error !== null && "code" in error
                  ? String(error.code).slice(0, 128)
                  : "internal_error",
            }
          : {}),
      });
      if (!publicationExists || manifest === undefined) throw error;
      return this.#store.readRevision(manifest.ecosystem, manifest.packageId, manifest.revisionId);
    } finally {
      if (acquired?.cleanupDirectory !== undefined)
        await this.#store.discardAcquisitionWorkspace(acquired.cleanupDirectory);
    }
  }
}
