// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { ModelRequestSettings, SessionOpenResult, ThinkingLevel } from "@axl/protocol";
import { type AxlClient, AxlClientError } from "./client.ts";

export interface NewSessionDraft {
  readonly mode: "chat" | "code";
  readonly workspace?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly requestSettings?: ModelRequestSettings;
  readonly webFetch?: boolean;
  readonly webSearch?: boolean;
}

export interface NewSessionDraftUpdate {
  readonly mode?: NewSessionDraft["mode"];
  readonly workspace?: string | undefined;
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly thinkingLevel?: ThinkingLevel | undefined;
  readonly requestSettings?: ModelRequestSettings | undefined;
  readonly webFetch?: boolean | undefined;
  readonly webSearch?: boolean | undefined;
}

export class NewSessionController {
  private current: NewSessionDraft = { mode: "chat" };

  get draft(): NewSessionDraft {
    return this.current;
  }

  update(update: NewSessionDraftUpdate): NewSessionDraft {
    const next = { ...this.current, ...update, mode: update.mode ?? this.current.mode };
    this.current = {
      mode: next.mode,
      ...(next.mode === "chat" || next.workspace === undefined
        ? {}
        : { workspace: next.workspace }),
      ...(next.providerId === undefined ? {} : { providerId: next.providerId }),
      ...(next.modelId === undefined ? {} : { modelId: next.modelId }),
      ...(next.thinkingLevel === undefined ? {} : { thinkingLevel: next.thinkingLevel }),
      ...(next.requestSettings === undefined ? {} : { requestSettings: next.requestSettings }),
      ...(next.mode === "chat" || next.webFetch === undefined ? {} : { webFetch: next.webFetch }),
      ...(next.mode === "chat" || next.webSearch === undefined
        ? {}
        : { webSearch: next.webSearch }),
    };
    return this.current;
  }

  reset(mode: NewSessionDraft["mode"] = "chat"): NewSessionDraft {
    this.current = { mode };
    return this.current;
  }

  async create(client: AxlClient, defaultCwd: string): Promise<SessionOpenResult> {
    const workspace = this.current.mode === "chat" ? defaultCwd : this.current.workspace?.trim();
    if (!workspace) {
      throw new AxlClientError("invalid_command_argument", "Choose a workspace for Code mode");
    }
    const draft = this.current;
    return client.request("session.create", {
      cwd: workspace,
      profile: draft.mode === "chat" ? "chat" : "standard",
      ...(draft.providerId === undefined ? {} : { providerId: draft.providerId }),
      ...(draft.modelId === undefined ? {} : { modelId: draft.modelId }),
      ...(draft.thinkingLevel === undefined ? {} : { thinkingLevel: draft.thinkingLevel }),
      ...(draft.requestSettings === undefined ? {} : { requestSettings: draft.requestSettings }),
      ...(draft.mode === "chat" || draft.webFetch === undefined
        ? {}
        : { webFetch: draft.webFetch }),
      ...(draft.mode === "chat" || draft.webSearch === undefined
        ? {}
        : { webSearch: draft.webSearch }),
    });
  }
}
