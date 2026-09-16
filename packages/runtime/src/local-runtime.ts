// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 Srihari
// SPDX-License-Identifier: Apache-2.0

import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { CredentialStore } from "@axl/ai";
import { type AxlDaemon, listStoredSessions } from "@axl/daemon";
import {
  DEFAULT_MODEL_REQUEST_SETTINGS,
  type ModelRequestSettings,
  parseModelRequestSettings,
  type SessionSummary,
  type ThinkingLevel,
} from "@axl/protocol";

import { AdoptionAcquisitionCoordinator } from "./adoption-acquisition.ts";
import { LocalAdoptionService } from "./adoption-service.ts";
import {
  createProviderManagementService,
  type TrustedProviderLoginAdapter,
  validateProviderSelection,
} from "./provider-management.ts";

export interface LocalRuntimeDefaults {
  readonly providerId?: string;
  readonly requestSettings?: ModelRequestSettings;
  readonly modelId: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly webFetch?: boolean;
  readonly webSearch?: boolean;
}

export type LocalSandboxSelection =
  | { readonly type: "native" }
  | { readonly type: "oci"; readonly engine: "podman" | "docker"; readonly image: string };

export function localSandboxStateKey(selection: LocalSandboxSelection): string | undefined {
  if (selection.type === "native") return undefined;
  const separatorText = "@sha256:";
  const separator = selection.image.lastIndexOf(separatorText);
  const name = separator < 1 ? "" : selection.image.slice(0, separator);
  const digest = separator < 0 ? "" : selection.image.slice(separator + separatorText.length);
  let digestValid = digest.length === 64;
  for (const character of digest) {
    const code = character.charCodeAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) digestValid = false;
  }
  const nameValid =
    name.length > 0 &&
    !name.includes("@") &&
    ![...name].some((character) => character.trim() === "");
  if (!nameValid || !digestValid) {
    throw new Error(
      `OCI image must be pinned to a sha256 digest, received ${JSON.stringify(selection.image)}`,
    );
  }
  return join("oci", selection.engine, digest);
}

export type LocalSessionPlacement =
  | { readonly type: "native" }
  | { readonly type: "unsafe" }
  | { readonly type: "oci"; readonly engine: "podman" | "docker"; readonly image: string };

export interface LocalSessionDescriptor extends SessionSummary {
  readonly placement: LocalSessionPlacement;
  readonly placementLabel: string;
}

async function directories(path: string): Promise<readonly string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Reads the authoritative local logs without starting or weakening any sandbox daemon. */
export async function listLocalSessions(
  axlHome: string,
): Promise<readonly LocalSessionDescriptor[]> {
  const sources: Array<{
    directory: string;
    placement: LocalSessionPlacement;
    label: string;
  }> = [
    { directory: axlHome, placement: { type: "native" }, label: "SANDBOXED · native" },
    { directory: join(axlHome, "unsafe"), placement: { type: "unsafe" }, label: "UNSAFE" },
  ];
  const listed = (
    await Promise.all(
      sources.map(async (source) =>
        (
          await listStoredSessions(source.directory)
        ).map((summary) => ({
          ...summary,
          placement: source.placement,
          placementLabel: source.label,
        })),
      ),
    )
  ).flat();
  for (const engine of ["podman", "docker"] as const) {
    const engineDirectory = join(axlHome, "oci", engine);
    for (const digest of await directories(engineDirectory)) {
      if (digest.length !== 64) continue;
      const directory = join(engineDirectory, digest);
      for (const summary of await listStoredSessions(directory)) {
        const image = summary.sandboxImage;
        if (image === undefined) continue;
        const placement = { type: "oci" as const, engine, image };
        if (localSandboxStateKey(placement) !== join("oci", engine, digest)) {
          throw new Error(`OCI session image does not match state directory ${directory}`);
        }
        listed.push({ ...summary, placement, placementLabel: `SANDBOXED · ${engine}` });
      }
    }
  }
  return listed.sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function diagnoseLocalSandboxes(): Promise<{
  readonly native: {
    readonly provider: string;
    readonly available: boolean;
    readonly reason?: string;
    readonly controls: readonly string[];
    readonly details?: Readonly<Record<string, unknown>>;
  };
  readonly podman: Awaited<ReturnType<typeof import("@axl/sandbox")["detectOciEngine"]>>;
  readonly docker: Awaited<ReturnType<typeof import("@axl/sandbox")["detectOciEngine"]>>;
}> {
  const sandboxPackage = await import("@axl/sandbox");
  const [native, podman, docker] = await Promise.all([
    sandboxPackage.detectPlatformSandbox(),
    sandboxPackage.detectOciEngine("podman"),
    sandboxPackage.detectOciEngine("docker"),
  ]);
  const nativePayload = native.configuredPayload();
  return {
    native: {
      provider: native.provider,
      available: native.available,
      ...(native.reason === undefined ? {} : { reason: native.reason }),
      controls: nativePayload.controls,
      ...(nativePayload.details === undefined ? {} : { details: nativePayload.details }),
    },
    podman,
    docker,
  };
}

async function migrateLegacyAzureCredential(store: CredentialStore): Promise<void> {
  const legacyProviderId = "azure-openai";
  const providerId = "azure-openai-responses";
  const [legacy, current] = await Promise.all([
    store.read(legacyProviderId),
    store.read(providerId),
  ]);
  if (legacy === undefined || current !== undefined) return;
  await store.modify(providerId, (stored) => Promise.resolve(stored ?? legacy));
  await store.delete(legacyProviderId);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function loginProviderFromTrustedHost(input: {
  readonly store: CredentialStore;
  readonly adapter: TrustedProviderLoginAdapter;
  readonly providerId: string;
  readonly axlHome: string;
  readonly method: "api_key" | "oauth";
  readonly signal?: AbortSignal;
}): Promise<import("@axl/protocol").ProviderAuthenticationStatus> {
  const ai = await import("@axl/ai");
  const options = { store: input.store, context: ai.nodeAuthContext };
  const configured = await ai.loadConfiguredProviders(input.axlHome, options);
  const providers = [
    ...ai
      .createBuiltinProviders(options)
      .filter((provider) => !configured.some((entry) => entry.id === provider.id)),
    ...configured,
  ];
  try {
    const provider = providers.find((candidate) => candidate.id === input.providerId);
    if (provider?.authentication === undefined) {
      throw new Error(`Provider ${input.providerId} has no interactive authentication`);
    }
    if (!provider.authentication.loginMethods.includes(input.method)) {
      throw new Error(`Provider ${input.providerId} does not support ${input.method} login`);
    }
    const signal = input.signal ?? new AbortController().signal;
    const interaction = input.adapter.createInteraction({
      providerId: input.providerId,
      method: input.method,
      signal,
    });
    const state = await provider.authentication.login(input.method, { ...interaction, signal });
    return {
      providerId: input.providerId,
      phase: state.phase,
      ...(state.method === undefined ? {} : { method: state.method }),
      ...(state.source === undefined ? {} : { source: state.source }),
    };
  } finally {
    await Promise.all(providers.map((provider) => provider.dispose?.()));
  }
}

export interface LocalDaemonOptions {
  readonly buildVersion?: string;
  readonly onStopped?: () => void;
  readonly forceTerminate?: () => void;
  readonly axlHome: string;
  readonly stateDirectory: string;
  readonly socketPath: string;
  readonly defaults: LocalRuntimeDefaults;
  readonly store: CredentialStore;
  readonly unsafe: boolean;
  readonly sandbox?: LocalSandboxSelection;
}

/**
 * Starts the authoritative local daemon and assembles its model, tools,
 * extensions, policy, and sandbox without depending on a presentation client.
 */
export async function startLocalDaemon(options: LocalDaemonOptions): Promise<AxlDaemon> {
  const { axlHome, stateDirectory, socketPath, defaults, store, unsafe } = options;
  const sandboxSelection = options.sandbox ?? { type: "native" as const };
  let assemblyPromise:
    | Promise<{
        ai: typeof import("@axl/ai");
        kernel: typeof import("@axl/kernel");
        sandbox: import("@axl/sandbox").PlatformSandbox;
        providers: import("@axl/ai").ProviderRegistry;
      }>
    | undefined;
  const loadAssembly = () => {
    assemblyPromise ??= Promise.all([
      import("@axl/ai"),
      import("@axl/kernel"),
      import("@axl/sandbox"),
    ]).then(async ([ai, kernel, sandboxPackage]) => {
      const sandbox = unsafe
        ? sandboxPackage.createUnsafePlatformExecution()
        : sandboxSelection.type === "native"
          ? await sandboxPackage.detectPlatformSandbox()
          : await sandboxPackage.prepareOciPlatformExecution({
              engine: sandboxSelection.engine,
              image: sandboxSelection.image,
            });
      if (!sandbox.available) {
        throw new sandboxPackage.SandboxUnavailableError(sandbox.reason ?? "unknown");
      }
      await migrateLegacyAzureCredential(store);
      const providers = new ai.ProviderRegistry({
        catalogStore: new ai.FileCatalogStore(join(axlHome, "catalogs")),
      });
      const configured = await ai.loadConfiguredProviders(axlHome, {
        store,
        context: ai.nodeAuthContext,
      });
      for (const provider of ai.createBuiltinProviders({ store, context: ai.nodeAuthContext })) {
        if (!configured.some((entry) => entry.id === provider.id)) providers.register(provider);
      }
      for (const provider of configured) providers.register(provider);
      const restored = await providers.restoreCatalogs();
      return { ai, kernel, sandbox, providers, catalogErrors: restored.errors };
    });
    return assemblyPromise;
  };

  // Sandboxed startup fails closed before listening. Unsafe startup may listen
  // first because its lack of isolation is already explicit and logged.
  const initialAssembly = unsafe ? undefined : await loadAssembly();
  const { AdoptionStore, AxlDaemon } = await import("@axl/daemon");
  const providerManagement = {
    list: async (...args: Parameters<import("@axl/daemon").ProviderManagementService["list"]>) =>
      createProviderManagementService((await loadAssembly()).providers).list(...args),
    refresh: async (
      ...args: Parameters<import("@axl/daemon").ProviderManagementService["refresh"]>
    ) => createProviderManagementService((await loadAssembly()).providers).refresh(...args),
    authenticationStatus: async (
      ...args: Parameters<import("@axl/daemon").ProviderManagementService["authenticationStatus"]>
    ) =>
      createProviderManagementService((await loadAssembly()).providers).authenticationStatus(
        ...args,
      ),
    login: async (...args: Parameters<import("@axl/daemon").ProviderManagementService["login"]>) =>
      createProviderManagementService((await loadAssembly()).providers).login(...args),
    logout: async (
      ...args: Parameters<import("@axl/daemon").ProviderManagementService["logout"]>
    ) => createProviderManagementService((await loadAssembly()).providers).logout(...args),
    dispose: async () => {
      if (assemblyPromise !== undefined) await (await assemblyPromise).providers.dispose();
    },
  } satisfies import("@axl/daemon").ProviderManagementService;
  const adoptionStore = new AdoptionStore(join(stateDirectory, "adopted"));
  await adoptionStore.initialize();
  const adoptionService = new LocalAdoptionService({
    acquisition: new AdoptionAcquisitionCoordinator(adoptionStore),
  });
  const daemon = new AxlDaemon({
    ...(options.buildVersion === undefined ? {} : { buildVersion: options.buildVersion }),
    ...(options.onStopped === undefined ? {} : { onStopped: options.onStopped }),
    ...(options.forceTerminate === undefined ? {} : { forceTerminate: options.forceTerminate }),
    socketPath,
    dataDirectory: stateDirectory,
    securityMode: unsafe ? "unsafe" : "sandboxed",
    sandboxProvider: unsafe ? "none" : (initialAssembly?.sandbox.provider ?? "unknown"),
    ...(sandboxSelection.type === "oci" ? { sandboxImage: sandboxSelection.image } : {}),
    providerManagement,
    adoptionService,
    runtime: async ({ sessionId, cwd, boundary, selection, interact, readBlob }) => {
      const { ai, kernel, sandbox, providers } = await loadAssembly();
      const profile = selection.profile ?? "standard";
      const [hasMcpConfig, hasSkills] =
        profile !== "standard"
          ? [false, false]
          : await Promise.all([
              Promise.all([
                exists(join(axlHome, "mcp.json")),
                exists(join(cwd, ".axl", "mcp.json")),
              ]).then((values) => values.some(Boolean)),
              Promise.all([
                exists(join(axlHome, "skills")),
                exists(join(cwd, ".axl", "skills")),
              ]).then((values) => values.some(Boolean)),
            ]);
      const [mcpPackage, skillsPackage] = await Promise.all([
        hasMcpConfig ? import("@axl/extension-mcp") : Promise.resolve(undefined),
        hasSkills ? import("@axl/extension-skills") : Promise.resolve(undefined),
      ]);
      const [instructions, skills, mcpServers] = await Promise.all([
        kernel.loadAgentsInstructions({ cwd, globalPath: join(axlHome, "AGENTS.md") }),
        skillsPackage === undefined
          ? Promise.resolve([])
          : skillsPackage.discoverSkills({ cwd, globalDirectory: join(axlHome, "skills") }),
        mcpPackage === undefined
          ? Promise.resolve([])
          : mcpPackage.loadMcpConfig({ cwd, globalDirectory: axlHome }),
      ]);
      const active = {
        providerId: selection.providerId ?? defaults.providerId ?? "azure-openai-responses",
        modelId: selection.modelId ?? defaults.modelId,
        thinkingLevel: selection.thinkingLevel ?? defaults.thinkingLevel,
        webFetch: profile === "standard" && (selection.webFetch ?? defaults.webFetch ?? true),
        webSearch: profile === "standard" && (selection.webSearch ?? defaults.webSearch ?? true),
      };
      const modelInfo = await validateProviderSelection(
        providers,
        active.providerId,
        active.modelId,
      );
      const thinking = ai.clampThinkingLevel(modelInfo, active.thinkingLevel);
      const policy = {
        workspace: cwd,
        readableRoots: [cwd],
        protectedPaths: [axlHome],
      };
      const requestSettings = parseModelRequestSettings(
        selection.requestSettings ?? defaults.requestSettings ?? DEFAULT_MODEL_REQUEST_SETTINGS,
      );
      const providerSecrets = new Set<string>();
      const model = ai.modelPortForRegistry(providers, {
        providerId: active.providerId,
        requestSettings,
        modelId: active.modelId,
        thinkingLevel: thinking.effective,
        readBlob,
        onResolvedSecrets: (values) => {
          for (const value of values) providerSecrets.add(value);
        },
      });
      const tools = new kernel.ToolRegistry();
      const overflowDirectory = join(stateDirectory, "tool-output", sessionId);
      if (profile !== "chat") {
        tools.register(sandbox.makeShellTool({ cwd, overflowDirectory, policy }));
      }
      if (profile === "standard") {
        tools.register(kernel.makeReadTool({ cwd, ...(unsafe ? {} : { policy }) }));
        tools.register(kernel.makeWriteTool({ cwd, ...(unsafe ? {} : { policy }) }));
        tools.register(kernel.makeEditTool({ cwd, ...(unsafe ? {} : { policy }) }));
      } else if (profile === "minimal") {
        tools.register(kernel.makeEditTool({ cwd, ...(unsafe ? {} : { policy }) }));
      }
      if (active.webFetch) tools.register(kernel.makeWebFetchTool());
      const braveSearchKey = active.webSearch
        ? ai.nodeAuthContext.env("BRAVE_SEARCH_API_KEY") || undefined
        : undefined;
      if (active.webSearch) {
        tools.register(
          kernel.makeWebSearchTool({
            ...(braveSearchKey === undefined ? {} : { apiKey: braveSearchKey }),
          }),
        );
      }

      if (skillsPackage !== undefined && skills.length > 0) {
        tools.register(skillsPackage.makeSkillTool(skills));
      }
      const mcpSecrets = mcpPackage?.mcpSecretValues(mcpServers) ?? [];
      const mcp =
        mcpPackage === undefined || mcpServers.length === 0
          ? undefined
          : new mcpPackage.McpManager({
              servers: mcpServers,
              cwd,
              sessionId,
              stateDirectory: join(stateDirectory, "mcp"),
              blobDirectory: join(stateDirectory, "blobs"),
              model,
              modelId: active.modelId,
              secretValues: mcpSecrets,
              interact,
              wrapStdio: (input) => sandbox.wrapProcess({ policy, ...input }),
            });
      if (mcp) tools.register(mcp.makeTool());

      const skillSection = skillsPackage?.skillCatalogSection(skills);
      const prompt = kernel.buildStablePrompt({
        cwd,
        tools: tools.declarations().map(({ name, description }) => ({ name, description })),
        ...(unsafe
          ? {
              constraints: [
                ...kernel.ESSENTIAL_CONSTRAINTS,
                "No operating-system sandbox is active. Commands and file tools have the user's full host access.",
              ],
            }
          : {}),
        instructions: [...instructions, ...(skillSection === undefined ? [] : [skillSection])],
      });
      return {
        model,
        tools,
        ...(mcp === undefined ? {} : { extensionHost: mcp }),
        prompt,
        log: {
          secretValues: () => [
            ...mcpSecrets,
            ...(braveSearchKey === undefined ? [] : [braveSearchKey]),
            ...providerSecrets,
          ],
        },
        sandbox: sandbox.configuredPayload(),
        configProvider: { providerId: active.providerId },
        configModel: { modelId: active.modelId },
        configRequest: requestSettings,
        configThinking: thinking,
        configProfile: { profile },
        configTools: { webFetch: active.webFetch, webSearch: active.webSearch },
        ...(boundary === "config_change"
          ? {}
          : {
              configDialect: ai.dialectBoundaryPayload(
                new ai.FrozenToolRoster({ id: modelInfo.apiDialect }, tools.declarations()),
                boundary,
              ),
            }),
      };
    },
  });
  await daemon.start();
  return daemon;
}
