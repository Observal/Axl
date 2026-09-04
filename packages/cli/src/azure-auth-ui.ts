// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import {
  type ApiKeyCredential,
  type AuthContext,
  AZURE_OPENAI_PROVIDER_ID,
  azureOpenAiAuthMethod,
  type CredentialStore,
  login,
  normalizeAzureBaseUrl,
  parseDeploymentMap,
  resolveProviderAuth,
  verifyAzureOpenAiAuth,
} from "@axl/ai";
import {
  type LoginDialogDefinition,
  promptLine,
  type SetupInput,
  type SetupOutput,
} from "@axl/tui";

const VERIFY_ATTEMPTS = 3;

export async function azureLoginDialog(
  store: CredentialStore,
  context: AuthContext,
  fetchImpl: typeof fetch = fetch,
): Promise<LoginDialogDefinition> {
  const stored = await store.read(AZURE_OPENAI_PROVIDER_ID);
  const current: ApiKeyCredential | undefined = stored?.type === "api_key" ? stored : undefined;
  return {
    title: "Login to Azure OpenAI",
    verifyingMessage: "Checking the credentials against Azure…",
    fields: [
      {
        id: "key",
        label: "API key",
        prompt: current?.key
          ? "Enter a new Azure OpenAI API key, or leave blank to keep the stored key"
          : "Enter Azure OpenAI API key",
        example: "Stored globally in ~/.axl/credentials.json and used in every workspace.",
        mask: true,
        optional: current?.key !== undefined,
      },
      {
        id: "endpoint",
        label: "Endpoint",
        prompt: "Enter Azure OpenAI endpoint",
        example: "Example: https://your-resource.openai.azure.com/",
        initialValue: current?.env?.AZURE_OPENAI_BASE_URL ?? "",
        validate: (value) => {
          try {
            normalizeAzureBaseUrl(value);
            return undefined;
          } catch {
            return "That is not a valid URL";
          }
        },
      },
      {
        id: "deploymentMap",
        label: "Deployment map",
        prompt: "Map model IDs to Azure deployment names (optional)",
        example: "Format: gpt-5.6-sol=my-deployment[,model=deployment]",
        optional: true,
        initialValue: current?.env?.AZURE_OPENAI_DEPLOYMENT_NAME_MAP ?? "",
      },
    ],
    submit: async (values) => {
      const key = (values.key ?? "").replace(/\s+/g, "") || current?.key;
      if (!key) return { ok: false, message: "API key is required", fieldId: "key" };
      const baseUrl = normalizeAzureBaseUrl(values.endpoint ?? "");
      const map = (values.deploymentMap ?? "").trim();
      const mapValid = map.length > 0 && Object.keys(parseDeploymentMap(map)).length > 0;
      await login(store, AZURE_OPENAI_PROVIDER_ID, {
        type: "api_key",
        key,
        env: {
          AZURE_OPENAI_BASE_URL: baseUrl,
          ...(mapValid ? { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: map } : {}),
        },
      });
      const resolved = await resolveProviderAuth(
        AZURE_OPENAI_PROVIDER_ID,
        { apiKey: azureOpenAiAuthMethod },
        store,
        context,
      );
      const verification = await verifyAzureOpenAiAuth(resolved, fetchImpl);
      if (verification.ok) return { ok: true, summary: "✓ credentials verified with Azure" };
      const status = verification.status === undefined ? "" : ` (HTTP ${verification.status})`;
      return {
        ok: false,
        message: `Azure rejected the credentials${status}. Check the key`,
        fieldId: "key",
        clearField: true,
      };
    },
  };
}

/** Interactive first-run Azure credential setup owned by the CLI process host. */
export async function runAzureSetup(
  input: SetupInput,
  output: SetupOutput,
  store: CredentialStore,
  context: AuthContext,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  output.write(
    "\nAzure OpenAI setup: saved to ~/.axl/credentials.json (0600), redacted from logs.\n\n",
  );

  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    const key = (await promptLine(input, output, "  API key: ", { mask: true })).replace(
      /\s+/g,
      "",
    );

    let baseUrl: string | undefined;
    while (baseUrl === undefined) {
      const raw = await promptLine(
        input,
        output,
        "  Endpoint (e.g. https://your-resource.openai.azure.com/ or your Foundry URL): ",
      );
      try {
        baseUrl = normalizeAzureBaseUrl(raw);
      } catch {
        output.write("  That is not a valid URL; try again.\n");
      }
    }

    const map = await promptLine(
      input,
      output,
      "  Model to deployment map, optional (e.g. gpt-5=my-deployment, Enter to skip): ",
      { allowEmpty: true },
    );
    const mapValid = map.length > 0 && Object.keys(parseDeploymentMap(map)).length > 0;
    if (map.length > 0 && !mapValid) {
      output.write("  Ignoring unparseable map; use model=deployment[,model=deployment].\n");
    }

    await login(store, AZURE_OPENAI_PROVIDER_ID, {
      type: "api_key",
      key,
      env: {
        AZURE_OPENAI_BASE_URL: baseUrl,
        ...(mapValid ? { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: map } : {}),
      },
    });

    const resolved = await resolveProviderAuth(
      AZURE_OPENAI_PROVIDER_ID,
      { apiKey: azureOpenAiAuthMethod },
      store,
      context,
    );
    output.write("  Checking the key against Azure…\n");
    const verification = await verifyAzureOpenAiAuth(resolved, fetchImpl);
    if (verification.ok) {
      output.write("\n  ✓ Credentials verified with Azure.\n\n");
      return;
    }
    const status = verification.status === undefined ? "" : ` (HTTP ${verification.status})`;
    output.write(
      `\n  ✖ Azure rejected the credentials${status}: ${verification.detail ?? "no detail"}\n`,
    );
    if (attempt < VERIFY_ATTEMPTS) output.write("  Let's try again.\n\n");
  }
  output.write("\n  Credentials saved but NOT verified. Fix them with /login or `axl login`.\n\n");
}
