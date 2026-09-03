// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { CredentialStore } from "@axl/ai";
import { type AxlDaemon, listStoredSessions } from "@axl/daemon";
import type { SessionSummary, ThinkingLevel } from "@axl/protocol";

export interface LocalRuntimeDefaults {
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
  for (const engine of ["podman", "docker"] as const) {
    const engineDirectory = join(axlHome, "oci", engine);
    for (const digest of await directories(engineDirectory)) {
      if (digest.length !== 64) continue;
      const directory = join(engineDirectory, digest);
      const summaries = await listStoredSessions(directory);
      const image = summaries.find((summary) => summary.sandboxImage !== undefined)?.sandboxImage;
      if (image === undefined) continue;
      const selection = { type: "oci" as const, engine, image };
      if (localSandboxStateKey(selection) !== join("oci", engine, digest)) {
        throw new Error(`OCI session image does not match state directory ${directory}`);
      }
      sources.push({ directory, placement: selection, label: `SANDBOXED · ${engine}` });
    }
  }

  const listed = await Promise.all(
    sources.map(async (source) =>
      (await listStoredSessions(source.directory)).map((summary) => ({
        ...summary,
        placement: source.placement,
        placementLabel: source.label,
      })),
    ),
  );
  return listed.flat().sort((left, right) => right.updatedAt - left.updatedAt);
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface LocalDaemonOptions {
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
        provider: ReturnType<typeof import("@axl/ai")["createAzureOpenAiProvider"]>;
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
      return {
        ai,
        kernel,
        sandbox,
        provider: ai.createAzureOpenAiProvider({ store, context: ai.nodeAuthContext }),
      };
    });
    return assemblyPromise;
  };

  // Sandboxed startup fails closed before listening. Unsafe startup may listen
  // first because its lack of isolation is already explicit and logged.
  const initialAssembly = unsafe ? undefined : await loadAssembly();
  const { AxlDaemon } = await import("@axl/daemon");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: stateDirectory,
    securityMode: unsafe ? "unsafe" : "sandboxed",
    sandboxProvider: unsafe ? "none" : (initialAssembly?.sandbox.provider ?? "unknown"),
    ...(sandboxSelection.type === "oci" ? { sandboxImage: sandboxSelection.image } : {}),
    runtime: async ({ sessionId, cwd, boundary, selection, interact, readBlob }) => {
      const { ai, kernel, sandbox, provider } = await loadAssembly();
      const [hasMcpConfig, hasSkills] = await Promise.all([
        Promise.all([
          exists(join(axlHome, "mcp.json")),
          exists(join(cwd, ".axl", "mcp.json")),
        ]).then((values) => values.some(Boolean)),
        Promise.all([exists(join(axlHome, "skills")), exists(join(cwd, ".axl", "skills"))]).then(
          (values) => values.some(Boolean),
        ),
      ]);
      const [mcpPackage, skillsPackage] = await Promise.all([
        hasMcpConfig ? import("@axl/extension-mcp") : Promise.resolve(undefined),
        hasSkills ? import("@axl/extension-skills") : Promise.resolve(undefined),
      ]);
      const [resolved, instructions, skills, mcpServers] = await Promise.all([
        ai.resolveProviderAuth(
          ai.AZURE_OPENAI_PROVIDER_ID,
          { apiKey: ai.azureOpenAiAuthMethod },
          store,
          ai.nodeAuthContext,
        ),
        kernel.loadAgentsInstructions({ cwd, globalPath: join(axlHome, "AGENTS.md") }),
        skillsPackage === undefined
          ? Promise.resolve([])
          : skillsPackage.discoverSkills({ cwd, globalDirectory: join(axlHome, "skills") }),
        mcpPackage === undefined
          ? Promise.resolve([])
          : mcpPackage.loadMcpConfig({ cwd, globalDirectory: axlHome }),
      ]);
      const active = {
        modelId: selection.modelId ?? defaults.modelId,
        thinkingLevel: selection.thinkingLevel ?? defaults.thinkingLevel,
        webFetch: selection.webFetch ?? defaults.webFetch ?? true,
        webSearch: selection.webSearch ?? defaults.webSearch ?? true,
      };
      const modelInfo = ai.AZURE_OPENAI_MODELS.find(
        (candidate) => candidate.modelId === active.modelId,
      );
      if (modelInfo === undefined) throw new Error(`Unknown Azure OpenAI model ${active.modelId}`);
      const thinking = ai.clampThinkingLevel(modelInfo, active.thinkingLevel);
      const policy = {
        workspace: cwd,
        readableRoots: [cwd],
        protectedPaths: [axlHome],
      };
      const model = ai.modelPortForSession(provider, {
        modelId: active.modelId,
        thinkingLevel: thinking.effective,
        readBlob,
      });
      const tools = new kernel.ToolRegistry();
      const overflowDirectory = join(stateDirectory, "tool-output");
      tools.register(sandbox.makeShellTool({ cwd, overflowDirectory, policy }));
      tools.register(kernel.makeReadTool({ cwd, ...(unsafe ? {} : { policy }) }));
      tools.register(kernel.makeWriteTool({ cwd, ...(unsafe ? {} : { policy }) }));
      tools.register(kernel.makeEditTool({ cwd, ...(unsafe ? {} : { policy }) }));
      if (active.webFetch) tools.register(kernel.makeWebFetchTool());
      const braveSearchKey = ai.nodeAuthContext.env("BRAVE_SEARCH_API_KEY");
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
          secretValues: [
            ...resolved.secretValues,
            ...mcpSecrets,
            ...(braveSearchKey === undefined ? [] : [braveSearchKey]),
          ],
        },
        sandbox: sandbox.configuredPayload(),
        configModel: { modelId: active.modelId },
        configThinking: thinking,
        configTools: { webFetch: active.webFetch, webSearch: active.webSearch },
        ...(boundary === "config_change"
          ? {}
          : {
              configDialect: ai.dialectBoundaryPayload(
                new ai.FrozenToolRoster(ai.OPENAI_CHAT_TOOL_DIALECT, tools.declarations()),
                boundary,
              ),
            }),
      };
    },
  });
  await daemon.start();
  return daemon;
}
