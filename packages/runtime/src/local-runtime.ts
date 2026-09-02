// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";

import {
  AZURE_OPENAI_MODELS,
  AZURE_OPENAI_PROVIDER_ID,
  azureOpenAiAuthMethod,
  clampThinkingLevel,
  createAzureOpenAiProvider,
  type CredentialStore,
  dialectBoundaryPayload,
  FrozenToolRoster,
  modelPortForSession,
  nodeAuthContext,
  OPENAI_CHAT_TOOL_DIALECT,
  resolveProviderAuth,
} from "@axl/ai";
import { AxlDaemon } from "@axl/daemon";
import { loadMcpConfig, McpManager, mcpSecretValues } from "@axl/extension-mcp";
import { discoverSkills, makeSkillTool, skillCatalogSection } from "@axl/extension-skills";
import {
  buildStablePrompt,
  ESSENTIAL_CONSTRAINTS,
  loadAgentsInstructions,
  makeEditTool,
  makeReadTool,
  ToolRegistry,
  type WorkspacePolicy,
} from "@axl/kernel";
import type { ThinkingLevel } from "@axl/protocol";
import {
  createUnsafePlatformExecution,
  detectPlatformSandbox,
  SandboxUnavailableError,
} from "@axl/sandbox";

export interface LocalRuntimeDefaults {
  readonly modelId: string;
  readonly thinkingLevel: ThinkingLevel;
}

export interface LocalDaemonOptions {
  readonly axlHome: string;
  readonly stateDirectory: string;
  readonly socketPath: string;
  readonly defaults: LocalRuntimeDefaults;
  readonly store: CredentialStore;
  readonly unsafe: boolean;
}

function thinkingPayload(config: LocalRuntimeDefaults) {
  const model = AZURE_OPENAI_MODELS.find((candidate) => candidate.modelId === config.modelId);
  if (model === undefined) {
    return { requested: config.thinkingLevel, effective: config.thinkingLevel, clamped: false };
  }
  return clampThinkingLevel(model, config.thinkingLevel);
}

/**
 * Starts the authoritative local daemon and assembles its model, tools,
 * extensions, policy, and sandbox without depending on a presentation client.
 */
export async function startLocalDaemon(options: LocalDaemonOptions): Promise<AxlDaemon> {
  const { axlHome, stateDirectory, socketPath, defaults, store, unsafe } = options;
  const sandbox = unsafe ? createUnsafePlatformExecution() : await detectPlatformSandbox();
  if (!sandbox.available) {
    throw new SandboxUnavailableError(sandbox.reason ?? "unknown");
  }
  const provider = createAzureOpenAiProvider({ store, context: nodeAuthContext });
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: stateDirectory,
    securityMode: unsafe ? "unsafe" : "sandboxed",
    runtime: async ({ sessionId, cwd, boundary, selection, interact }) => {
      // Resolve once here so the session log can redact every secret value.
      const resolved = await resolveProviderAuth(
        AZURE_OPENAI_PROVIDER_ID,
        { apiKey: azureOpenAiAuthMethod },
        store,
        nodeAuthContext,
      );
      const active: LocalRuntimeDefaults = {
        modelId: selection.modelId ?? defaults.modelId,
        thinkingLevel: selection.thinkingLevel ?? defaults.thinkingLevel,
      };
      if (!AZURE_OPENAI_MODELS.some((model) => model.modelId === active.modelId)) {
        throw new Error(`Unknown Azure OpenAI model ${active.modelId}`);
      }
      const policy: WorkspacePolicy = {
        workspace: cwd,
        readableRoots: [cwd],
        protectedPaths: [axlHome],
      };
      const model = modelPortForSession(provider, {
        modelId: active.modelId,
        thinkingLevel: thinkingPayload(active).effective,
      });
      const tools = new ToolRegistry();
      const overflowDirectory = join(stateDirectory, "tool-output");
      tools.register(sandbox.makeShellTool({ cwd, overflowDirectory, policy }));
      tools.register(makeReadTool({ cwd, ...(unsafe ? {} : { policy }) }));
      tools.register(makeEditTool({ cwd, ...(unsafe ? {} : { policy }) }));

      const skills = await discoverSkills({
        cwd,
        globalDirectory: join(axlHome, "skills"),
      });
      if (skills.length > 0) tools.register(makeSkillTool(skills));

      const mcpServers = await loadMcpConfig({ cwd, globalDirectory: axlHome });
      const mcpSecrets = mcpSecretValues(mcpServers);
      const mcp =
        mcpServers.length === 0
          ? undefined
          : new McpManager({
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

      const skillSection = skillCatalogSection(skills);
      const prompt = buildStablePrompt({
        cwd,
        tools: tools.declarations().map(({ name, description }) => ({ name, description })),
        ...(unsafe
          ? {
              constraints: [
                ...ESSENTIAL_CONSTRAINTS,
                "No operating-system sandbox is active. Commands and file tools have the user's full host access.",
              ],
            }
          : {}),
        instructions: [
          ...(await loadAgentsInstructions({
            cwd,
            globalPath: join(axlHome, "AGENTS.md"),
          })),
          ...(skillSection === undefined ? [] : [skillSection]),
        ],
      });
      return {
        model,
        tools,
        ...(mcp === undefined ? {} : { extensionHost: mcp }),
        prompt,
        log: { secretValues: [...resolved.secretValues, ...mcpSecrets] },
        sandbox: sandbox.configuredPayload(),
        configModel: { modelId: active.modelId },
        configThinking: thinkingPayload(active),
        // Thinking-only changes do not alter the provider tool dialect.
        ...(boundary === "config_change"
          ? {}
          : {
              configDialect: dialectBoundaryPayload(
                new FrozenToolRoster(OPENAI_CHAT_TOOL_DIALECT, tools.declarations()),
                boundary,
              ),
            }),
      };
    },
  });
  await daemon.start();
  return daemon;
}
