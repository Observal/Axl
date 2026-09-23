// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 Srihari
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import { access, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CredentialStore, ModelProvider } from "@axl/ai";
import { type AxlDaemon, listStoredSessions } from "@axl/daemon";
import {
  type CompactionPreferences,
  DEFAULT_MODEL_REQUEST_SETTINGS,
  type ModelRequestSettings,
  parseModelRequestSettings,
  resolveCompactionSettings,
  type SessionSummary,
  type ThinkingLevel,
  WIRE_CAPABILITIES,
} from "@axl/protocol";

import { extensionDiagnosticsExtension } from "./core-daemon-extension.ts";
import {
  createProviderManagementService,
  type TrustedProviderLoginAdapter,
  validateProviderSelection,
} from "./provider-management.ts";

export interface LocalRuntimeDefaults {
  readonly providerId?: string;
  readonly requestSettings?: ModelRequestSettings;
  readonly compaction?: CompactionPreferences;
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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
  const extensionProviders = new Map<
    string,
    { readonly extensionId: string; references: number; readonly unregister: () => Promise<void> }
  >();
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
  const { AxlDaemon, commandCatalog, installDaemonCommandCapabilities, McpProbeFailedError } =
    await import("@axl/daemon");
  const reservedCommandNames = new Set(
    commandCatalog(new Set(WIRE_CAPABILITIES)).commands.map((command) => command.name),
  );
  const { DaemonExtensionRegistry } = await import("@axl/extension-host");
  const extensionRegistry = new DaemonExtensionRegistry(axlHome);
  const {
    McpConfigStore,
    mcpCapabilityCachePath,
    mcpDiscoveryStateReader,
    McpProbeError,
    mcpSecretValues: mcpSecretValuesOf,
    probeMcpServer,
    resolveMcpServerConfig,
  } = await import("@axl/extension-mcp");
  const mcpCachePath = mcpCapabilityCachePath(axlHome);
  const mcpConfigurationStore = new McpConfigStore(
    axlHome,
    process.cwd(),
    mcpDiscoveryStateReader(mcpCachePath),
  );
  const probeMcpConfiguration = async (
    params: import("@axl/protocol").McpConfigProbeParams,
    signal?: AbortSignal,
  ): Promise<import("@axl/protocol").McpConfigProbeResult> => {
    const { sandbox } = await loadAssembly();
    const cwd = process.cwd();
    let server: import("@axl/extension-mcp").NamedMcpServerConfig;
    try {
      server = resolveMcpServerConfig(params.name, params.definition, cwd);
    } catch (error) {
      throw new McpProbeFailedError(
        params.name,
        error instanceof Error ? error.message : "Invalid MCP server definition",
        { cause: error },
      );
    }
    const policy = { workspace: cwd, readableRoots: [cwd], protectedPaths: [axlHome] };
    try {
      return await probeMcpServer({
        server,
        cwd,
        stateDirectory: join(stateDirectory, "mcp-probe"),
        blobDirectory: join(stateDirectory, "blobs"),
        secretValues: mcpSecretValuesOf([server]),
        wrapStdio: (input) => sandbox.wrapProcess({ ...input, policy }),
        cachePath: mcpCachePath,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof McpProbeError) {
        throw new McpProbeFailedError(params.name, error.message, { cause: error });
      }
      throw error;
    }
  };
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
  let daemon: AxlDaemon;
  daemon = new AxlDaemon({
    ...(options.buildVersion === undefined ? {} : { buildVersion: options.buildVersion }),
    ...(options.onStopped === undefined ? {} : { onStopped: options.onStopped }),
    ...(options.forceTerminate === undefined ? {} : { forceTerminate: options.forceTerminate }),
    socketPath,
    dataDirectory: stateDirectory,
    securityMode: unsafe ? "unsafe" : "sandboxed",
    sandboxProvider: unsafe ? "none" : (initialAssembly?.sandbox.provider ?? "unknown"),
    ...(sandboxSelection.type === "oci" ? { sandboxImage: sandboxSelection.image } : {}),
    providerManagement,
    mcpConfiguration: {
      list: () => mcpConfigurationStore.list(),
      upsert: ({ name, definition }) => mcpConfigurationStore.upsert(name, definition),
      batch: ({ servers }) => mcpConfigurationStore.upsertMany(servers),
      remove: ({ name }) => mcpConfigurationStore.remove(name),
      probe: probeMcpConfiguration,
    },
    extensionManagement: {
      list: (cwd) => extensionRegistry.list(cwd),
      setEnabled: (extensionId, enabled) => extensionRegistry.setEnabled(extensionId, enabled),
      install: (source, signal) => extensionRegistry.install(source, signal),
      update: (extensionId, signal) => extensionRegistry.update(extensionId, signal),
      remove: (extensionId, signal) => extensionRegistry.remove(extensionId, signal),
      trustProject: (path, trusted) => extensionRegistry.trustProject(path, trusted),
    },
    runtime: async ({
      sessionId,
      cwd,
      boundary,
      selection,
      signal,
      contextResources,
      interact,
      compact,
      reload,
      extensionSession,
      readBlob,
    }) => {
      const { ai, kernel, sandbox, providers } = await loadAssembly();
      const profile = selection.profile ?? "standard";
      let resources =
        contextResources ??
        (await kernel.loadAgentsResources({
          cwd,
          globalPath: join(axlHome, "AGENTS.md"),
        }));
      let instructions = kernel.agentsInstructionsFromResources(resources);
      const active = {
        providerId: selection.providerId ?? defaults.providerId ?? "azure-openai-responses",
        modelId: selection.modelId ?? defaults.modelId,
        thinkingLevel: selection.thinkingLevel ?? defaults.thinkingLevel,
        webFetch: profile === "standard" && (selection.webFetch ?? defaults.webFetch ?? true),
        webSearch: profile === "standard" && (selection.webSearch ?? defaults.webSearch ?? true),
        userQuestions: profile === "standard" && (selection.userQuestions ?? false),
      };
      const compaction = resolveCompactionSettings(
        defaults.compaction,
        active.providerId,
        active.modelId,
      );
      const policy = {
        workspace: cwd,
        readableRoots: [cwd],
        protectedPaths: [axlHome],
      };
      const requestSettings = parseModelRequestSettings(
        selection.requestSettings ?? defaults.requestSettings ?? DEFAULT_MODEL_REQUEST_SETTINGS,
      );
      const providerSecrets = new Set<string>();
      let extensionHost: import("@axl/kernel").ExtensionHost | undefined;
      let capabilityService: import("@axl/kernel").CapabilityService | undefined;
      const resolveModel = async () => {
        const modelInfo = await validateProviderSelection(
          providers,
          active.providerId,
          active.modelId,
        );
        const thinking = ai.clampThinkingLevel(modelInfo, active.thinkingLevel);
        const model = ai.modelPortForRegistry(providers, {
          providerId: active.providerId,
          requestSettings,
          modelId: active.modelId,
          thinkingLevel: thinking.effective,
          readBlob,
          onResolvedSecrets: (values) => {
            for (const value of values) providerSecrets.add(value);
          },
          providerHooks: {
            beforeHeaders: (input, requestSignal) =>
              extensionHost?.beforeProviderHeaders?.(input, requestSignal) ?? input.headers,
            beforeRequest: (input, requestSignal) =>
              extensionHost?.beforeProviderRequest?.(input, requestSignal) ?? input.payload,
            afterResponse: (input, requestSignal) =>
              extensionHost?.afterProviderResponse?.(input, requestSignal),
          },
        });
        return { model, modelInfo, thinking };
      };
      let selectedModel: Awaited<ReturnType<typeof resolveModel>> | undefined;
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
      if (active.userQuestions) tools.register(kernel.makeAskUserQuestionTool(interact));
      const mcpSecrets = new Set<string>();
      if (profile === "standard") {
        const { discoverSkills, SkillCapabilityService } = await import("@axl/extension-skills");
        const skills = await discoverSkills({
          cwd,
          globalDirectories: [join(axlHome, "skills"), join(dirname(axlHome), ".agents", "skills")],
        });
        const daemonCapabilities = installDaemonCommandCapabilities({
          tools,
          compact,
          reload,
          mcp: {
            list: () => mcpConfigurationStore.list(),
            upsert: (name, definition) => mcpConfigurationStore.upsert(name, definition),
            remove: (name) => mcpConfigurationStore.remove(name),
          },
        });
        const { DAEMON_EXTENSION_AUTHORITY, loadDaemonExtensions } = await import(
          "@axl/extension-host"
        );
        const grantedAuthorities = new Set([
          "skills.activate",
          DAEMON_EXTENSION_AUTHORITY,
          ...daemonCapabilities.grantedAuthorities,
        ]);
        const skillService = new SkillCapabilityService(skills, { grantedAuthorities });
        const extensionEntries = await extensionRegistry.entries(cwd);
        let daemonExtensions: Awaited<ReturnType<typeof loadDaemonExtensions>>;
        try {
          daemonExtensions = await loadDaemonExtensions({
            directory: join(axlHome, "extensions"),
            extensions: extensionEntries,
            builtinExtensions: [
              {
                id: "axl-core",
                path: "builtin:extension-diagnostics",
                source: "builtin",
                factory: extensionDiagnosticsExtension,
              },
            ],
            cwd,
            reason: boundary,
            tools,
            grantedAuthorities,
            signal,
            session: {
              ...extensionSession,
              extensions: async () => {
                const extensions = await extensionRegistry.list(cwd);
                return { extensions: extensions.extensions };
              },
              info: async () => {
                const [info, catalog, extensions] = await Promise.all([
                  extensionSession.info(),
                  providers.listModels(),
                  extensionRegistry.list(cwd),
                ]);
                return {
                  ...info,
                  models: catalog.models.map(({ providerId, modelId }) => ({
                    providerId,
                    modelId,
                  })),
                  projectTrusted: extensions.project.trusted,
                };
              },
            },
            shutdown: async () => {
              setTimeout(() => void daemon.stop(), 0);
            },
            registerProvider: (extensionId, value) => {
              const provider = value as Partial<ModelProvider>;
              if (
                typeof provider.id !== "string" ||
                typeof provider.displayName !== "string" ||
                !Array.isArray(provider.authMethods) ||
                typeof provider.listModels !== "function" ||
                typeof provider.stream !== "function"
              ) {
                throw new TypeError("Extension provider does not implement ModelProvider");
              }
              const existing = extensionProviders.get(provider.id);
              if (existing !== undefined) {
                if (existing.extensionId !== extensionId) {
                  throw new Error(
                    `Provider ${provider.id} is already owned by extension ${existing.extensionId}`,
                  );
                }
                existing.references += 1;
              } else {
                extensionProviders.set(provider.id, {
                  extensionId,
                  references: 1,
                  unregister: providers.register(provider as ModelProvider),
                });
              }
              return async () => {
                const registered = extensionProviders.get(provider.id as string);
                if (registered === undefined || registered.extensionId !== extensionId) return;
                registered.references -= 1;
                if (registered.references > 0) return;
                extensionProviders.delete(provider.id as string);
                await registered.unregister();
              };
            },
            reservedCommandNames,
            onFailure: (failure) => {
              extensionRegistry.recordFailure(failure.extensionId, failure.error);
              console.error(
                `Axl extension ${failure.extensionId} ${failure.event} handler failed: ${failure.error.message}`,
              );
            },
          });
        } catch (error) {
          if (error instanceof kernel.ExtensionHostError) {
            const extensionId = error.details.extensionId;
            if (typeof extensionId === "string")
              extensionRegistry.recordFailure(extensionId, error);
          }
          throw error;
        }
        for (const extension of daemonExtensions.extensions) {
          extensionRegistry.clearFailure(extension.id);
        }
        const hosts: import("@axl/kernel").ExtensionHost[] = [daemonExtensions.host];
        try {
          const extensionResources =
            contextResources === undefined
              ? ((await daemonExtensions.host.discoverResources?.(signal)) ?? [])
              : [];
          if (extensionResources.length > 0) {
            resources = [...resources, ...extensionResources];
            instructions = kernel.agentsInstructionsFromResources(resources);
          }
          selectedModel = await resolveModel();
          const capabilitySources: import("@axl/kernel").CapabilitySource[] = [
            { records: skillService.records, service: skillService },
            daemonCapabilities.source,
            daemonExtensions.source,
          ];
          if (await exists(join(axlHome, "mcp.json"))) {
            const { loadMcpCapabilities, loadMcpConfig, McpManager, updateMcpCapabilityCache } =
              await import("@axl/extension-mcp");
            const servers = await loadMcpConfig({ cwd, globalDirectory: axlHome });
            for (const value of mcpSecretValuesOf(servers)) mcpSecrets.add(value);
            if (servers.length > 0) {
              const cachePath = mcpCachePath;
              const manager = new McpManager({
                servers,
                cwd,
                sessionId,
                stateDirectory: join(stateDirectory, "mcp"),
                blobDirectory: join(stateDirectory, "blobs"),
                model: selectedModel.model,
                modelId: active.modelId,
                secretValues: [...mcpSecrets],
                onSecrets: (values) => {
                  for (const value of values) mcpSecrets.add(value);
                },
                onToolListChanged: (server, discovery) =>
                  updateMcpCapabilityCache({ cachePath, server, discovery }),
                interact: async (request, signal) => {
                  const response = await interact(request, signal);
                  if (
                    response.action !== "accept" &&
                    response.action !== "decline" &&
                    response.action !== "cancel"
                  ) {
                    throw new Error(`Unsupported MCP interaction response ${response.action}`);
                  }
                  return {
                    action: response.action,
                    ...(response.content ? { content: response.content } : {}),
                  };
                },
                wrapStdio: (input) => sandbox.wrapProcess({ ...input, policy }),
              });
              hosts.push(manager);
              const mcp = await loadMcpCapabilities({
                servers,
                manager,
                tools,
                cachePath,
              });
              grantedAuthorities.add(mcp.authority);
              capabilitySources.push({ records: mcp.service.records, service: mcp.service });
            }
          }
          extensionHost = kernel.composeExtensionHosts(hosts);
          capabilityService = new kernel.CompositeCapabilityService(
            capabilitySources,
            grantedAuthorities,
          );
          tools.register(kernel.makeCapabilitySearchTool(capabilityService));
        } catch (error) {
          await Promise.allSettled([...hosts].reverse().map((host) => host.dispose()));
          throw error;
        }
      }

      selectedModel ??= await resolveModel();
      const { model, modelInfo, thinking } = selectedModel;
      const prompt = kernel.buildStablePrompt({
        cwd,
        tools: tools.declarations().map(({ name, description }) => ({ name, description })),
        constraints: [
          ...kernel.ESSENTIAL_CONSTRAINTS,
          ...(unsafe
            ? [
                "No operating-system sandbox is active. Commands and file tools have the user's full host access.",
              ]
            : [
                "Commands run inside an isolated sandbox that masks the host home directory and blocks network access. A missing executable or inaccessible host path means unavailable inside the sandbox, not absent from the host.",
              ]),
        ],
        instructions,
      });
      return {
        model,
        tools,
        prompt,
        contextResources: resources,
        compaction,
        modelContextWindow: modelInfo.contextWindow,
        log: {
          secretValues: () => [
            ...(braveSearchKey === undefined ? [] : [braveSearchKey]),
            ...providerSecrets,
            ...mcpSecrets,
          ],
        },
        ...(extensionHost === undefined ? {} : { extensionHost }),
        ...(capabilityService === undefined ? {} : { capabilityService }),
        sandbox: sandbox.configuredPayload(),
        configProvider: { providerId: active.providerId },
        configModel: { modelId: active.modelId },
        configRequest: requestSettings,
        configCompaction: compaction,
        configThinking: thinking,
        configProfile: { profile },
        configTools: {
          webFetch: active.webFetch,
          webSearch: active.webSearch,
          userQuestions: active.userQuestions,
        },
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
