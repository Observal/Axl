// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  type AdoptionCandidate,
  AdoptionController,
  type AdoptionControllerState,
  type AttachmentPresence,
  type AxlClient,
  type BlobReference,
  CommandController,
  type EffectiveCommand,
  type ConnectionState,
  type ConversationState,
  type EventId,
  type InteractionAction,
  type JsonObject,
  MAX_UPLOAD_BLOB_BYTES,
  type ModelChoice,
  NewSessionController,
  type NewSessionDraft,
  type NewSessionDraftUpdate,
  deliverPrompt,
  parseOperationId,
  type ProjectedToolCall,
  type PromptDeliveryMode,
  type PromptDeliveryOutcome,
  type ProviderAuthenticationStatus,
  ProviderDirectoryController,
  type ProviderDirectoryState,
  type ProviderInventoryGroup,
  type ProviderLoginMethod,
  SessionConfigurationController,
  type SessionConfigurationState,
  type SessionId,
  type SessionOpenResult,
  type SessionSubscription,
  type SessionSummary,
  type ThinkingLevel,
  type UserContent,
  WorkspaceController,
  type WorkspaceOperations,
  type WorkspaceReviewSnapshot,
  type WorkspaceStatusScope,
  orderPendingTurnInputs,
  restoreQueuedPrompts,
  subscribeSession,
  uploadBlob as uploadSessionBlob,
} from "@axl/sdk";

import { AdoptionDialog } from "./adoption-dialog.tsx";
import { BrowserPane, type BrowserPaneState, EMPTY_BROWSER_STATE } from "./browser-pane.tsx";
import { CommandPalette } from "./command-palette.tsx";
import {
  filterCommands,
  type WebTheme,
  webPresentationCommands,
  workspaceReviewScope,
} from "./commands.ts";
import type { ControlCenterTab } from "./control-center.tsx";
import { Dock } from "./dock.tsx";
import { trapDialogFocus } from "./dialog-focus.ts";
import {
  browserProviderHost,
  connectWebEnvironment,
  DOCK_WIDTH_RANGE,
  exportSessionArtifact,
  importSessionArtifact,
  parseWebPreferences,
  retainBrowserSession,
  saveWebPreferences,
  SIDEBAR_WIDTH_RANGE,
  validateProjectFolder,
  type WebBootstrap,
  type WebPreferences,
} from "./environment.ts";
import { ModelPicker } from "./model-picker.tsx";
import { isModelPickerShortcut, nextThinkingLevel } from "./model-picker-state.ts";
import { NewSessionDialog } from "./new-session-dialog.tsx";
import { WebToolControls } from "./web-tool-controls.tsx";
import {
  profileSupportsWebTools,
  webToolConfiguration,
  type WebToolField,
} from "./web-tools.ts";
import { presenceDescription, sessionPeers } from "./presence.ts";
import { RequeueDialog } from "./requeue-dialog.tsx";
import { pausedQueueItems } from "./requeue.ts";
import { PanePicker } from "./pane-picker.tsx";
import {
  closePane,
  createPaneLayout,
  DEFAULT_PANES,
  openPane,
  type PaneId,
  type PaneLayout,
  terminalEntries,
  togglePane,
} from "./panes.ts";
import { SessionLifecycle } from "./session-lifecycle.tsx";
import type { SplitState } from "./split-pane.tsx";
import { TerminalPane } from "./terminal-pane.tsx";
import {
  consumePendingPromptDeliveries,
  directShellInput,
  matchesSession,
  promptDeliveryShortcut,
  restoreDraft,
  sessionTitle,
  sessionUsageStats,
  transcriptMessageMatches,
  transcriptPromptBreakpoints,
  type PendingPromptDelivery,
} from "./view-state.ts";
import {
  type WorkspaceBrowserState,
  WorkspaceChanges,
  WorkspaceExplorer,
} from "./workspace-changes.tsx";

const ControlCenter = lazy(() => import("./control-center.tsx").then((module) => ({ default: module.ControlCenter })));
const Conversation = lazy(() => import("@axl/ui/react").then((module) => ({ default: module.Conversation })));

const DEFAULT_LAYOUT: WebPreferences = {
  sidebarWidth: 264,
  dockWidth: 680,
  sidebarCollapsed: false,
  changesView: "files",
  panes: DEFAULT_PANES,
};
const PREVIEW_LAYOUT_KEY = "axl.preview.layout";
const DAEMON_CONNECTION_LABELS: Readonly<Record<ConnectionState, string>> = {
  connecting: "Connecting…",
  negotiating: "Connecting…",
  loading_snapshot: "Syncing…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Click to reconnect",
  incompatible: "Version mismatch",
};
const validatePreviewProjectFolder = (path: string): Promise<{
  readonly valid: true;
  readonly path: string;
}> => Promise.resolve({ valid: true, path });
const WEB_THEME_KEY = "axl.web.theme";

function storedWebTheme(): WebTheme {
  try {
    const value = localStorage.getItem(WEB_THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function compactNumber(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

function previewLayout(): WebPreferences {
  try {
    return parseWebPreferences(JSON.parse(localStorage.getItem(PREVIEW_LAYOUT_KEY) ?? "null"));
  } catch {
    return DEFAULT_LAYOUT;
  }
}

const EMPTY_STATE: ConversationState = {
  records: [], compactedEventIds: [], tools: [], interactions: [], operations: [], uncertainShellOperations: [], queue: [], interruptDeliveries: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0 },
  closed: false,
};

function messageBlobs(conversation: ConversationState): readonly BlobReference[] {
  const blobs = new Map<string, BlobReference>();
  for (const record of conversation.records) {
    if (record.kind !== "event" || (record.event.type !== "user.message" && record.event.type !== "assistant.message")) continue;
    for (const item of record.event.payload.content) {
      if (item.type === "blob") blobs.set(item.blob.sha256, item.blob);
    }
  }
  return [...blobs.values()];
}

function sessionStateHistory(conversation: ConversationState): readonly { readonly id: string; readonly label: string; readonly detail: string; readonly timestamp: number }[] {
  const history: Array<{ readonly id: string; readonly label: string; readonly detail: string; readonly timestamp: number }> = [];
  for (const record of conversation.records) {
    if (record.kind !== "event") continue;
    const event = record.event;
    switch (event.type) {
      case "session.created": history.push({ id: event.id, label: "Session created", detail: event.payload.profile ?? "legacy", timestamp: event.timestamp }); break;
      case "session.resumed": history.push({ id: event.id, label: "Session resumed", detail: "Runtime restored", timestamp: event.timestamp }); break;
      case "session.closed": history.push({ id: event.id, label: "Session closed", detail: event.payload.reason, timestamp: event.timestamp }); break;
      case "config.provider": history.push({ id: event.id, label: "Provider", detail: event.payload.providerId, timestamp: event.timestamp }); break;
      case "config.model": history.push({ id: event.id, label: "Model", detail: event.payload.modelId, timestamp: event.timestamp }); break;
      case "config.profile": history.push({ id: event.id, label: "Profile", detail: event.payload.profile, timestamp: event.timestamp }); break;
      case "config.thinking": history.push({ id: event.id, label: "Thinking", detail: event.payload.clamped ? `${event.payload.requested} → ${event.payload.effective}` : event.payload.effective, timestamp: event.timestamp }); break;
      case "config.dialect": history.push({ id: event.id, label: "Tool dialect", detail: `${event.payload.dialectId} · ${event.payload.reason.replaceAll("_", " ")}`, timestamp: event.timestamp }); break;
      case "config.tools": history.push({ id: event.id, label: "Web tools", detail: `search ${event.payload.webSearch ? "on" : "off"} · fetch ${event.payload.webFetch ? "on" : "off"}`, timestamp: event.timestamp }); break;
      case "sandbox.configured": history.push({ id: event.id, label: "Sandbox", detail: event.payload.enforced ? `${event.payload.provider} enforced` : "not enforced", timestamp: event.timestamp }); break;
      default: break;
    }
  }
  return history.slice(-20).reverse();
}

interface ComposerAttachment {
  readonly id: number;
  readonly file: File;
  readonly status: "uploading" | "ready" | "failed";
  readonly progress: number;
  readonly reference?: BlobReference;
  readonly error?: string;
}

interface DirectOperation {
  readonly kind: "compaction" | "shell";
  readonly sessionId: SessionId;
  readonly cancelling: boolean;
  /** Where a shell command was entered; the terminal pane renders its own progress. */
  readonly source?: "composer" | "terminal";
  readonly command?: string;
}

type DirectShellOutcome = Awaited<ReturnType<AxlClient["shell"]>>;

export interface WebPreview {
  readonly sessions: readonly SessionSummary[];
  readonly openNewSession?: boolean;
  readonly newSessionMode?: NewSessionDraft["mode"];
  readonly capabilities?: readonly string[];
  readonly opened: SessionOpenResult;
  readonly conversation: ConversationState;
  readonly modelCatalog?: readonly ModelChoice[];
  readonly providers?: readonly ProviderInventoryGroup[];
  readonly resolveBlobUrl?: (sha256: string) => string | undefined;
  readonly readBlob?: (sha256: string) => Promise<Uint8Array>;
  readonly uploadBlob?: (
    file: File,
    onProgress: (uploadedBytes: number) => void,
    signal: AbortSignal,
  ) => Promise<BlobReference>;
  readonly deliverPrompt?: (
    mode: PromptDeliveryMode,
    content: readonly UserContent[],
    onConversation: (conversation: ConversationState) => void,
  ) => Promise<{
    readonly outcome: PromptDeliveryOutcome;
    readonly conversation: ConversationState;
  }>;
  readonly compact?: (
    instructions: string | undefined,
    onConversation: (conversation: ConversationState) => void,
  ) => Promise<void>;
  readonly shell?: (
    operationId: ReturnType<typeof parseOperationId>,
    command: string,
    excluded: boolean,
    onConversation: (conversation: ConversationState) => void,
  ) => Promise<DirectShellOutcome>;
  readonly interrupt?: (
    onConversation: (conversation: ConversationState) => void,
  ) => Promise<{ readonly interrupted: boolean }>;
  readonly renameSession?: (title: string) => Promise<void>;
  readonly cloneSession?: () => Promise<SessionOpenResult>;
  readonly disposeSession?: () => Promise<void>;
  readonly deleteSession?: () => Promise<void>;
  readonly exportSession?: () => Promise<Blob>;
  readonly importSession?: (file: File) => Promise<SessionOpenResult>;
  readonly loginProvider?: (
    providerId: string,
    method: ProviderLoginMethod,
    signal: AbortSignal,
  ) => Promise<ProviderAuthenticationStatus>;
  readonly commands?: readonly EffectiveCommand[];
  readonly workspace?: WorkspaceReviewSnapshot;
  readonly workspaceClient?: WorkspaceOperations;
}

export function AxlApp({ preview }: { readonly preview?: WebPreview } = {}): React.JSX.Element {
  const initialLayout = useRef(preview === undefined ? DEFAULT_LAYOUT : previewLayout()).current;
  const [client, setClient] = useState<AxlClient>();
  const [bootstrap, setBootstrap] = useState<WebBootstrap>();
  const [sessions, setSessions] = useState<readonly SessionSummary[]>(preview?.sessions ?? []);
  const [opened, setOpened] = useState<SessionOpenResult | undefined>(preview?.opened);
  const [conversation, setConversation] = useState<ConversationState>(preview?.conversation ?? EMPTY_STATE);
  const [draft, setDraft] = useState("");
  const [pendingDeliveries, setPendingDeliveries] = useState(0);
  const [pendingTurnDeliveries, setPendingTurnDeliveries] = useState(0);
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const attachmentSequence = useRef(0);
  const uploadControllers = useRef(new Map<number, AbortController>());
  const providerLoginController = useRef<AbortController | undefined>(undefined);
  const pendingInputSequence = useRef(0);
  const [pendingInputs, setPendingInputs] = useState<readonly PendingPromptDelivery[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [directOperation, setDirectOperation] = useState<DirectOperation>();
  const directCancellationRequested = useRef(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialLayout.sidebarCollapsed);
  const [sidebarWidth, setSidebarWidth] = useState(initialLayout.sidebarWidth);
  const [dockWidth, setDockWidth] = useState(initialLayout.dockWidth);
  const [changesView, setChangesView] = useState<"files" | "all">(initialLayout.changesView);
  const [theme, setTheme] = useState<WebTheme>(storedWebTheme);
  const [paneLayout, setPaneLayout] = useState<PaneLayout>(() => createPaneLayout(initialLayout.panes));
  const [browserPane, setBrowserPane] = useState<BrowserPaneState>(EMPTY_BROWSER_STATE);
  const [mobileDock, setMobileDock] = useState(false);
  const [filesSplit, setFilesSplit] = useState<SplitState>({ size: 220, collapsed: false });
  const [changesSplit, setChangesSplit] = useState<SplitState>({ size: 200, collapsed: false });
  const [terminalError, setTerminalError] = useState<string>();
  const [workspaceScope, setWorkspaceScope] = useState<WorkspaceStatusScope>("working");
  const [transcriptSearchOpen, setTranscriptSearchOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const usagePanel = useRef<HTMLElement>(null);
  const usageToggle = useRef<HTMLButtonElement>(null);
  const [controlCenter, setControlCenter] = useState<ControlCenterTab>();
  const [sessionLifecycleOpen, setSessionLifecycleOpen] = useState(false);
  const [sessionLifecycleError, setSessionLifecycleError] = useState<string>();
  const [requeueOpen, setRequeueOpen] = useState(false);
  const [requeueBusyItemId, setRequeueBusyItemId] = useState<EventId>();
  const [requeueError, setRequeueError] = useState<string>();
  const newSessionController = useRef(new NewSessionController());
  const [newSessionDraft, setNewSessionDraft] = useState<NewSessionDraft>(() =>
    preview?.newSessionMode === undefined
      ? newSessionController.current.draft
      : newSessionController.current.update({
          mode: preview.newSessionMode,
          ...(preview.newSessionMode === "code" ? { workspace: preview.opened.cwd } : {}),
        }),
  );
  const [newSessionOpen, setNewSessionOpen] = useState(preview?.openNewSession ?? false);
  const [newSessionError, setNewSessionError] = useState<string>();
  const [presence, setPresence] = useState<readonly AttachmentPresence[]>([]);
  const [providerActionError, setProviderActionError] = useState<string>();
  const [settingsError, setSettingsError] = useState<string>();
  const [providerLogin, setProviderLogin] = useState<{
    readonly providerId: string;
    readonly method: ProviderLoginMethod;
  }>();
  const [transcriptQuery, setTranscriptQuery] = useState("");
  const [transcriptMatch, setTranscriptMatch] = useState(-1);
  const [transcriptNavigationVisible, setTranscriptNavigationVisible] = useState(false);
  const [activePromptId, setActivePromptId] = useState<string>();
  const [providerDirectory, setProviderDirectory] = useState<ProviderDirectoryState>({
    status: preview === undefined ? "idle" : "ready",
    models: preview?.modelCatalog ?? [],
    providers: preview?.providers ?? [],
  });
  const providerDirectoryController = useRef<ProviderDirectoryController | undefined>(undefined);
  const configurationController = useRef<SessionConfigurationController | undefined>(undefined);
  const adoptionController = useRef<AdoptionController | undefined>(undefined);
  const [adoptionState, setAdoptionState] = useState<AdoptionControllerState>({
    status: "idle",
    scope: {},
    candidates: [],
    warnings: [],
    hasMore: false,
    findingsDismissed: true,
  });
  const [adoptionOpen, setAdoptionOpen] = useState(false);
  const [adoptionNoticeVisible, setAdoptionNoticeVisible] = useState(false);
  const modelCatalog = providerDirectory.models;
  const providerInventory = providerDirectory.providers;
  const providerLoading = providerDirectory.status === "loading";
  const providerError = providerActionError ?? providerDirectory.error;
  const [configurationState, setConfigurationState] = useState<SessionConfigurationState>({
    pending: [],
    errors: {},
  });
  const [modelActionError, setModelActionError] = useState<string>();
  const [workspaceReview, setWorkspaceReview] = useState<WorkspaceReviewSnapshot | undefined>(preview?.workspace);
  const [workspaceBrowser, setWorkspaceBrowser] = useState<WorkspaceBrowserState>({
    path: "",
    entries: [],
    loaded: false,
  });
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState<string>();
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string>();
  const [workspaceCheckpointEnabled, setWorkspaceCheckpointEnabled] = useState<boolean>();
  const [connection, setConnection] = useState<ConnectionState>(preview ? "connected" : "connecting");
  const [error, setError] = useState<string>();
  const [actionNotice, setActionNotice] = useState<string>();
  const [commands, setCommands] = useState<readonly EffectiveCommand[]>(preview?.commands ?? []);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteError, setCommandPaletteError] = useState<string>();
  const [slashCommandIndex, setSlashCommandIndex] = useState(0);
  const [modelPickerOpenRequest, setModelPickerOpenRequest] = useState(0);
  const [newSessionModelPickerOpenRequest, setNewSessionModelPickerOpenRequest] = useState(0);
  const [modelPickerInitialFocus, setModelPickerInitialFocus] = useState<"model" | "thinking">("model");
  const [blobUrls, setBlobUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const commandController = useRef<CommandController | undefined>(undefined);
  const workspaceController = useRef<WorkspaceController | undefined>(undefined);
  const subscription = useRef<SessionSubscription | undefined>(undefined);
  const blobUrlCache = useRef(new Map<string, string>());
  const blobUrlSession = useRef<string | undefined>(undefined);
  const openedSessionId = useRef<SessionId | undefined>(preview?.opened.sessionId);
  const selectionGeneration = useRef(0);
  const workspaceRequestGeneration = useRef(0);
  const listRequest = useRef(0);
  const fileRequest = useRef(0);
  const reviewRequest = useRef(0);
  const transcript = useRef<HTMLDivElement>(null);
  const transcriptNavigationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const actionNoticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mobileMenu = useRef<HTMLButtonElement>(null);
  const sidebarPanel = useRef<HTMLElement>(null);
  const sidebarClose = useRef<HTMLButtonElement>(null);
  const mobileDockToggle = useRef<HTMLButtonElement>(null);
  const mobileDockPanel = useRef<HTMLDivElement>(null);
  const mobileDockClose = useRef<HTMLButtonElement>(null);
  const mobileDockWasOpen = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const artifactInput = useRef<HTMLInputElement>(null);
  const sidebarWasOpen = useRef(false);
  const preferencesRef = useRef<WebPreferences>(DEFAULT_LAYOUT);
  preferencesRef.current = {
    sidebarWidth,
    dockWidth,
    sidebarCollapsed,
    changesView,
    panes: paneLayout.panes,
    ...(adoptionState.dismissedScanGeneration === undefined
      ? {}
      : { adoptionDismissedScanGeneration: adoptionState.dismissedScanGeneration }),
  };

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    try {
      localStorage.setItem(WEB_THEME_KEY, theme);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : "Could not save the theme preference");
    }
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const refreshSessions = async (current: AxlClient): Promise<readonly SessionSummary[]> => {
    const result = await current.request("session.list", { scope: "all_local", order: "recent", pageSize: 100 });
    setSessions(result.sessions);
    return result.sessions;
  };

  const refreshSessionCatalog = async (current: AxlClient): Promise<void> => {
    const next = await refreshSessions(current);
    const selectedId = openedSessionId.current;
    if (selectedId === undefined) return;
    const selected = next.find((session) => session.sessionId === selectedId);
    if (selected !== undefined) {
      setOpened((value) => value === undefined ? value : {
        ...value,
        ...(selected.title === undefined ? {} : { title: selected.title }),
        runtime: selected.runtime,
      });
      return;
    }
    selectionGeneration.current += 1;
    workspaceRequestGeneration.current += 1;
    await subscription.current?.close();
    subscription.current = undefined;
    workspaceController.current = undefined;
    openedSessionId.current = undefined;
    if (preview === undefined) retainBrowserSession();
    setOpened(undefined);
    setConversation(EMPTY_STATE);
    setSessionLifecycleOpen(false);
    setRequeueOpen(false);
    setRequeueError(undefined);
    setNewSessionOpen(false);
    setError("This session was deleted by another attached client");
  };

  const refreshCommandDirectory = async (sessionId?: SessionId): Promise<void> => {
    const controller = commandController.current;
    if (controller === undefined) return;
    setCommands(await controller.refresh(sessionId));
  };

  const openSession = async (
    current: AxlClient,
    sessionId: SessionId,
    resumed?: SessionOpenResult,
  ): Promise<void> => {
    const generation = ++selectionGeneration.current;
    configurationController.current?.reset(sessionId);
    workspaceRequestGeneration.current += 1;
    workspaceController.current = undefined;
    setModelActionError(undefined);
    setSessionLifecycleError(undefined);
    setCommandPaletteError(undefined);
    setBusy(true); setDirectOperation(undefined); setError(undefined); setTerminalError(undefined); setSidebarOpen(false); setMobileDock(false); setTranscriptSearchOpen(false); setUsageOpen(false); setControlCenter(undefined); setSessionLifecycleOpen(false); setRequeueOpen(false); setRequeueBusyItemId(undefined); setRequeueError(undefined); setNewSessionOpen(false); setTranscriptQuery(""); setActivePromptId(undefined); setWorkspaceReview(undefined); setWorkspaceBrowser({ path: "", entries: [], loaded: false }); setWorkspaceScope("working"); setWorkspaceCheckpointEnabled(undefined); setBrowserError(undefined); setReviewError(undefined); setBrowserLoading(false); setReviewLoading(false); setOpened(undefined); setConversation(EMPTY_STATE);
    const previous = subscription.current;
    subscription.current = undefined;
    try {
      await previous?.close();
      if (generation !== selectionGeneration.current) return;
      const next = resumed ?? await current.request("session.resume", { sessionId });
      if (generation !== selectionGeneration.current) return;
      workspaceController.current = new WorkspaceController(current, next.sessionId);
      let live = false;
      const nextSubscription = await subscribeSession(current, next.sessionId, {
        onEvent: (event) => {
          if (live && event.type === "config.dialect" && event.payload.reason === "reload") {
            void providerDirectoryController.current?.load(true).catch(() => undefined);
          }
        },
        onChange: (projector) => {
          if (generation === selectionGeneration.current) setConversation(projector.state);
        },
        onResyncRequired: (cause) => {
          if (generation === selectionGeneration.current) setError(cause.message);
        },
      });
      live = true;
      if (generation !== selectionGeneration.current) {
        await nextSubscription.close();
        return;
      }
      subscription.current = nextSubscription;
      openedSessionId.current = next.sessionId;
      if (preview === undefined) retainBrowserSession(next.sessionId);
      setOpened(next);
      void refreshCommandDirectory(next.sessionId).catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not load commands"),
      );
      const adoption = adoptionController.current;
      if (adoption !== undefined && adoption.state.status !== "unavailable") {
        void adoption
          .loadAll({
            projectRoot: next.cwd,
            scopes: ["global", "project"],
            includeMalformed: true,
          })
          .catch(() => undefined);
      }
    } catch (cause) {
      if (generation === selectionGeneration.current) {
        workspaceController.current = undefined;
        if (preview === undefined) retainBrowserSession();
        setError(cause instanceof Error ? cause.message : "Could not open the session");
      }
    } finally {
      if (generation === selectionGeneration.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (preview !== undefined) return;
    let disposed = false;
    let activeClient: AxlClient | undefined;
    let catalogRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    let removeStateListener = (): void => undefined;
    let removeCatalogListener = (): void => undefined;
    let removePresenceListener = (): void => undefined;
    let removeAdoptionListener = (): void => undefined;
    void connectWebEnvironment().then(async (environment) => {
      if (disposed) { environment.client.close(); return; }
      activeClient = environment.client; setClient(environment.client); setBootstrap(environment.bootstrap);
      const providers = new ProviderDirectoryController(environment.client);
      const configuration = new SessionConfigurationController(environment.client);
      providerDirectoryController.current = providers;
      configurationController.current = configuration;
      providers.subscribe(setProviderDirectory);
      configuration.subscribe(setConfigurationState);
      const adoption = new AdoptionController(environment.client, {
        ...(environment.bootstrap.preferences.adoptionDismissedScanGeneration === undefined
          ? {}
          : {
              dismissedScanGeneration:
                environment.bootstrap.preferences.adoptionDismissedScanGeneration,
            }),
        onDismissedScanGeneration: (adoptionDismissedScanGeneration) =>
          saveWebPreferences({
            ...preferencesRef.current,
            adoptionDismissedScanGeneration,
          }),
      });
      adoptionController.current = adoption;
      removeAdoptionListener = adoption.subscribe((state) => {
        if (disposed) return;
        setAdoptionState(state);
        setAdoptionNoticeVisible(
          state.status === "ready" && state.candidates.length > 0 && !state.findingsDismissed,
        );
      });
      if (adoption.state.status !== "unavailable") {
        void adoption
          .loadAll({
            scopes: ["global"],
            includeMalformed: true,
          })
          .catch(() => undefined);
      }
      if (environment.client.connection.grantedCapabilities.includes("command.list")) {
        commandController.current = new CommandController(environment.client, () =>
          webPresentationCommands({
            canLogin: environment.bootstrap.hostCapabilities.includes("provider.auth.login"),
            openNewSession: (mode) => {
              const draft =
                mode === undefined
                  ? newSessionController.current.draft
                  : newSessionController.current.update({ mode });
              setNewSessionDraft(draft);
              setNewSessionError(undefined);
              setNewSessionOpen(true);
            },
            openProviders: () => {
              setUsageOpen(false);
              setTranscriptSearchOpen(false);
              setControlCenter("providers");
            },
            openTheme: () => {
              setUsageOpen(false);
              setTranscriptSearchOpen(false);
              setControlCenter("settings");
            },
            setTheme,
          }),
        );
      }
      setSidebarWidth(environment.bootstrap.preferences.sidebarWidth);
      setDockWidth(environment.bootstrap.preferences.dockWidth);
      setChangesView(environment.bootstrap.preferences.changesView);
      setSidebarCollapsed(environment.bootstrap.preferences.sidebarCollapsed);
      setPaneLayout(createPaneLayout(environment.bootstrap.preferences.panes));
      if (environment.client.connection.grantedCapabilities.includes("provider.list")) {
        void providers.load().catch(() => undefined);
      }
      if (commandController.current !== undefined) {
        void refreshCommandDirectory().catch((cause: unknown) =>
          setCommandPaletteError(cause instanceof Error ? cause.message : "Could not load commands"),
        );
      }
      removeStateListener = environment.client.onStateChange((state) => {
        if (!disposed) {
          setConnection(state);
          if (state !== "connected") setPresence([]);
        }
      });
      removePresenceListener = environment.client.onPresence((delivery) => {
        if (!disposed) setPresence(delivery.attachments);
      });
      removeCatalogListener = environment.client.onSessionsChanged(() => {
        if (disposed) return;
        if (catalogRefreshTimer !== undefined) clearTimeout(catalogRefreshTimer);
        catalogRefreshTimer = setTimeout(() => {
          catalogRefreshTimer = undefined;
          void refreshSessionCatalog(environment.client).catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : "Could not refresh sessions"),
          );
        }, 50);
      });
      await refreshSessions(environment.client);
      if (disposed) return;
      if (environment.selectedSessionId !== undefined) {
        await openSession(environment.client, environment.selectedSessionId);
      } else {
        setNewSessionDraft(newSessionController.current.reset("chat"));
        setNewSessionOpen(true);
      }
    }).catch((cause: unknown) => {
      if (!disposed) {
        setConnection("disconnected");
        setError(cause instanceof Error ? cause.message : "Could not start Axl web");
      }
    });
    return () => {
      disposed = true;
      selectionGeneration.current += 1;
      workspaceRequestGeneration.current += 1;
      removeStateListener();
      removeCatalogListener();
      removePresenceListener();
      removeAdoptionListener();
      adoptionController.current?.dispose();
      adoptionController.current = undefined;
      providerDirectoryController.current?.dispose();
      providerDirectoryController.current = undefined;
      configurationController.current?.dispose();
      configurationController.current = undefined;
      if (catalogRefreshTimer !== undefined) clearTimeout(catalogRefreshTimer);
      subscription.current?.detach();
      commandController.current = undefined;
      workspaceController.current = undefined;
      activeClient?.close();
    };
  }, [preview]);

  useEffect(() => {
    const sessionId = opened?.sessionId;
    if (blobUrlSession.current !== sessionId) {
      for (const url of blobUrlCache.current.values()) URL.revokeObjectURL(url);
      blobUrlCache.current.clear();
      blobUrlSession.current = sessionId;
      setBlobUrls(new Map());
    }
    if (preview !== undefined || client === undefined || sessionId === undefined || !client.connection.grantedCapabilities.includes("session.blob.read")) return;
    const activeSessionId = sessionId;
    let cancelled = false;
    const controller = new AbortController();
    for (const reference of messageBlobs(conversation)) {
      if (blobUrlCache.current.has(reference.sha256)) continue;
      void client.readBlob(activeSessionId, reference, { signal: controller.signal }).then((bytes) => {
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: reference.mediaType }));
        if (cancelled || blobUrlSession.current !== activeSessionId) {
          URL.revokeObjectURL(url);
          return;
        }
        blobUrlCache.current.set(reference.sha256, url);
        setBlobUrls(new Map(blobUrlCache.current));
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load an attachment");
      });
    }
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, conversation.records, opened?.sessionId, preview]);

  useEffect(() => () => {
    for (const url of blobUrlCache.current.values()) URL.revokeObjectURL(url);
    blobUrlCache.current.clear();
    for (const controller of uploadControllers.current.values()) controller.abort();
    uploadControllers.current.clear();
    providerLoginController.current?.abort();
  }, []);

  useEffect(() => { transcript.current?.scrollTo({ top: transcript.current.scrollHeight }); }, [conversation.records.length, conversation.activity?.sequence]);
  useEffect(() => {
    setPendingInputs((current) => consumePendingPromptDeliveries(current, conversation));
  }, [conversation.records]);
  useEffect(() => {
    for (const controller of uploadControllers.current.values()) controller.abort();
    uploadControllers.current.clear();
    setAttachments([]);
    setPendingInputs([]);
  }, [opened?.sessionId]);
  useEffect(() => { openedSessionId.current = opened?.sessionId; }, [opened?.sessionId]);
  const wantsFiles = paneLayout.panes.includes("files");
  const wantsChanges = paneLayout.panes.includes("changes");
  useEffect(() => {
    if (opened === undefined) return;
    if (wantsFiles && !workspaceBrowser.loaded && !browserLoading && browserError === undefined) void loadWorkspaceDirectory("");
    if (wantsChanges && workspaceReview === undefined && !reviewLoading && reviewError === undefined) void loadWorkspaceChanges(workspaceScope);
    // Only pane visibility and session identity trigger loads; loader state is read, not tracked.
  }, [opened?.sessionId, wantsFiles, wantsChanges]);
  useEffect(() => setTranscriptMatch(-1), [transcriptQuery]);
  useEffect(() => setSlashCommandIndex(0), [draft]);
  useEffect(() => {
    if (!matchMedia("(max-width: 760px)").matches) return;
    if (sidebarOpen) sidebarClose.current?.focus();
    else if (sidebarWasOpen.current) mobileMenu.current?.focus();
    sidebarWasOpen.current = sidebarOpen;
  }, [sidebarOpen]);
  useEffect(() => {
    if (!matchMedia("(max-width: 1180px)").matches) {
      mobileDockWasOpen.current = false;
      return;
    }
    if (mobileDock) mobileDockClose.current?.focus();
    else if (mobileDockWasOpen.current) {
      (mobileDockToggle.current ?? document.querySelector<HTMLElement>(".pane-picker > summary"))
        ?.focus();
    }
    mobileDockWasOpen.current = mobileDock;
  }, [mobileDock]);
  useEffect(() => {
    const media = matchMedia("(max-width: 1180px)");
    const closeDesktopOverlay = (): void => {
      if (!media.matches) setMobileDock(false);
    };
    closeDesktopOverlay();
    media.addEventListener("change", closeDesktopOverlay);
    return () => media.removeEventListener("change", closeDesktopOverlay);
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if ((sidebarOpen || mobileDock) && event.key !== "Escape") return;
      if (isModelPickerShortcut(event) && newSessionOpen) {
        event.preventDefault();
        setNewSessionModelPickerOpenRequest((current) => current + 1);
      } else if (
        isModelPickerShortcut(event) &&
        !commandPaletteOpen &&
        !transcriptSearchOpen &&
        controlCenter === undefined &&
        !sidebarOpen &&
        !requeueOpen
      ) {
        event.preventDefault();
        if (opened === undefined) {
          openNewSession();
          setNewSessionModelPickerOpenRequest((current) => current + 1);
        } else {
          setModelPickerInitialFocus("model");
          setModelPickerOpenRequest((current) => current + 1);
        }
      } else if (
        event.shiftKey &&
        event.key === "Tab" &&
        event.target instanceof HTMLTextAreaElement &&
        event.target.closest(".composer") !== null &&
        opened !== undefined &&
        (preview !== undefined ||
          client?.connection.grantedCapabilities.includes("session.configure") === true) &&
        !busy &&
        configurationState.pending.length === 0 &&
        conversation.activeOperationId === undefined &&
        (preview !== undefined || connection === "connected")
      ) {
        const next = nextThinkingLevel(
          modelCatalog,
          conversation.provider,
          conversation.model,
          conversation.thinking,
        );
        if (next !== undefined) {
          event.preventDefault();
          void configureThinking(next);
        }
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteError(undefined);
        setCommandPaletteOpen(true);
        void refreshCommandDirectory(opened?.sessionId).catch((cause: unknown) =>
          setCommandPaletteError(cause instanceof Error ? cause.message : "Could not refresh commands"),
        );
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f" && opened !== undefined) {
        event.preventDefault();
        setControlCenter(undefined);
        setUsageOpen(false);
        setTranscriptSearchOpen(true);
      } else if (event.altKey && event.key === "ArrowUp" && opened !== undefined) {
        event.preventDefault();
        void restoreQueuedInputs(false);
      } else if (event.key === "Escape") {
        if (commandPaletteOpen || transcriptSearchOpen || usageOpen || controlCenter !== undefined || sidebarOpen || mobileDock || requeueOpen || newSessionOpen) {
          setCommandPaletteOpen(false);
          setTranscriptSearchOpen(false);
          setUsageOpen(false);
          setControlCenter(undefined);
          setSidebarOpen(false);
          setMobileDock(false);
          setRequeueOpen(false);
          if (!busy) setNewSessionOpen(false);
        } else if (opened !== undefined && (conversation.activeOperationId !== undefined || pendingInputs.length > 0 || conversation.queue.some((item) => item.status === "queued" || item.status === "paused"))) {
          void restoreQueuedInputs(true);
        }
      }
    };
    addEventListener("keydown", keydown);
    return () => {
      removeEventListener("keydown", keydown);
      if (transcriptNavigationTimer.current !== undefined) clearTimeout(transcriptNavigationTimer.current);
      if (actionNoticeTimer.current !== undefined) clearTimeout(actionNoticeTimer.current);
    };
  }, [opened, commandPaletteOpen, transcriptSearchOpen, usageOpen, controlCenter, sidebarOpen, mobileDock, requeueOpen, newSessionOpen, busy, conversation.activeOperationId, conversation.queue, conversation.provider, conversation.model, conversation.thinking, configurationState.pending.length, connection, client, modelCatalog, pendingInputs.length, preview]);

  useEffect(() => {
    if (!usageOpen) return;
    const dismiss = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (usagePanel.current?.contains(event.target) || usageToggle.current?.contains(event.target)) return;
      setUsageOpen(false);
    };
    addEventListener("pointerdown", dismiss);
    return () => removeEventListener("pointerdown", dismiss);
  }, [usageOpen]);

  const openNewSession = (mode?: NewSessionDraft["mode"]): void => {
    const current = newSessionController.current.draft;
    const defaultProjectFolder = bootstrap?.cwd ?? preview?.opened.cwd;
    const draft =
      mode === undefined
        ? current
        : newSessionController.current.update({
            mode,
            ...(mode === "code" && current.workspace === undefined && defaultProjectFolder
              ? { workspace: defaultProjectFolder }
              : {}),
          });
    setNewSessionDraft(draft);
    setNewSessionError(undefined);
    setNewSessionModelPickerOpenRequest(0);
    setNewSessionOpen(true);
  };

  const updateNewSession = (update: NewSessionDraftUpdate): void => {
    const current = newSessionController.current.draft;
    const defaultProjectFolder = bootstrap?.cwd ?? preview?.opened.cwd;
    setNewSessionDraft(
      newSessionController.current.update({
        ...update,
        ...(update.mode === "code" && current.workspace === undefined && defaultProjectFolder
          ? { workspace: defaultProjectFolder }
          : {}),
      }),
    );
    setNewSessionError(undefined);
  };

  const createSession = async (): Promise<void> => {
    if (!client || !bootstrap) return;
    setBusy(true);
    setNewSessionError(undefined);
    try {
      const created = await newSessionController.current.create(client, bootstrap.cwd);
      await refreshSessions(client);
      await openSession(client, created.sessionId, created);
      setNewSessionOpen(false);
      setNewSessionDraft(newSessionController.current.reset("chat"));
    } catch (cause) {
      setNewSessionError(cause instanceof Error ? cause.message : "Could not create a session");
      setBusy(false);
    }
  };

  const renameSession = async (title: string): Promise<void> => {
    if (!opened) return;
    setBusy(true); setSessionLifecycleError(undefined);
    try {
      if (preview?.renameSession !== undefined) await preview.renameSession(title);
      else if (client !== undefined && commandController.current !== undefined) {
        await commandController.current.invoke(`/rename ${title}`, opened.sessionId);
      } else throw new Error("Session rename is unavailable");
      if (client !== undefined) await refreshSessions(client);
      else setSessions((current) => current.map((session) => session.sessionId === opened.sessionId ? { ...session, title } : session));
      setOpened((current) => current === undefined ? current : { ...current, title });
      setSessionLifecycleOpen(false);
      showActionNotice("Session renamed");
    } catch (cause) {
      setSessionLifecycleError(cause instanceof Error ? cause.message : "Could not rename the session");
    } finally {
      setBusy(false);
    }
  };

  const cloneSession = async (): Promise<void> => {
    if (!opened) return;
    setBusy(true); setSessionLifecycleError(undefined);
    try {
      const cloneOutcome =
        preview?.cloneSession === undefined && commandController.current !== undefined
          ? await commandController.current.invoke("/clone", opened.sessionId)
          : undefined;
      const cloned =
        preview?.cloneSession !== undefined
          ? await preview.cloneSession()
          : cloneOutcome?.state === "open-session"
            ? cloneOutcome.session
            : undefined;
      if (cloned === undefined) throw new Error("Session clone is unavailable");
      if (client !== undefined) await refreshSessions(client);
      setSessionLifecycleOpen(false);
      if (client !== undefined) await openSession(client, cloned.sessionId, cloned);
      else {
        workspaceRequestGeneration.current += 1;
        setOpened(cloned);
        setConversation(EMPTY_STATE);
        setWorkspaceBrowser({ path: "", entries: [], loaded: false });
        setWorkspaceReview(undefined);
        setWorkspaceCheckpointEnabled(undefined);
        setSessions((current) => [{
          sessionId: cloned.sessionId,
          cwd: cloned.cwd,
          ...(cloned.title === undefined ? {} : { title: cloned.title }),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          userMessageCount: 0,
          runtime: cloned.runtime,
          attachmentCount: 1,
        }, ...current]);
        showActionNotice("Session cloned");
      }
    } catch (cause) {
      setSessionLifecycleError(cause instanceof Error ? cause.message : "Could not clone the session");
    } finally {
      setBusy(false);
    }
  };

  const exportArtifact = async (): Promise<void> => {
    if (!opened) return;
    setBusy(true); setSessionLifecycleError(undefined);
    try {
      const artifact = preview?.exportSession !== undefined
        ? await preview.exportSession()
        : await exportSessionArtifact(opened.sessionId);
      const url = URL.createObjectURL(artifact);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `axl-session-${opened.sessionId}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      showActionNotice("Session export downloaded");
    } catch (cause) {
      setSessionLifecycleError(cause instanceof Error ? cause.message : "Could not export the session");
    } finally {
      setBusy(false);
    }
  };

  const importArtifact = async (file: File): Promise<void> => {
    setBusy(true); setError(undefined);
    try {
      const imported = preview?.importSession !== undefined
        ? await preview.importSession(file)
        : await importSessionArtifact(file);
      if (client !== undefined) await refreshSessions(client);
      if (client !== undefined) await openSession(client, imported.sessionId, imported);
      else {
        workspaceRequestGeneration.current += 1;
        setOpened(imported);
        setConversation(EMPTY_STATE);
        setWorkspaceBrowser({ path: "", entries: [], loaded: false });
        setWorkspaceReview(undefined);
        setWorkspaceCheckpointEnabled(undefined);
        setSessions((current) => [{
          sessionId: imported.sessionId,
          cwd: imported.cwd,
          ...(imported.title === undefined ? {} : { title: imported.title }),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          userMessageCount: 0,
          runtime: imported.runtime,
          attachmentCount: 1,
        }, ...current]);
        showActionNotice("Session imported");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import the session");
    } finally {
      setBusy(false);
      if (artifactInput.current !== null) artifactInput.current.value = "";
    }
  };

  const disposeSession = async (): Promise<void> => {
    if (!opened) return;
    setBusy(true); setSessionLifecycleError(undefined);
    try {
      if (preview?.disposeSession !== undefined) await preview.disposeSession();
      else if (client !== undefined) await client.request("session.dispose", { sessionId: opened.sessionId });
      else throw new Error("Session disposal is unavailable");
      await subscription.current?.close();
      subscription.current = undefined;
      setConversation((current) => {
        const { activeOperationId, ...inactive } = current;
        void activeOperationId;
        return { ...inactive, closed: true };
      });
      setOpened((current) => current === undefined ? current : { ...current, runtime: { state: "inactive" } });
      if (client !== undefined) await refreshSessions(client);
      setSessionLifecycleOpen(false);
      showActionNotice("Runtime ended. Durable history was preserved.");
    } catch (cause) {
      setSessionLifecycleError(cause instanceof Error ? cause.message : "Could not end the session runtime");
    } finally {
      setBusy(false);
    }
  };

  const deleteSession = async (): Promise<void> => {
    if (!opened) return;
    const deletedSessionId = opened.sessionId;
    setBusy(true); setSessionLifecycleError(undefined);
    openedSessionId.current = undefined;
    try {
      if (preview?.deleteSession !== undefined) await preview.deleteSession();
      else if (client !== undefined) await client.request("session.delete", { sessionId: deletedSessionId });
      else throw new Error("Session deletion is unavailable");
      selectionGeneration.current += 1;
      await subscription.current?.close();
      subscription.current = undefined;
      workspaceController.current = undefined;
      workspaceRequestGeneration.current += 1;
      openedSessionId.current = undefined;
      if (preview === undefined) retainBrowserSession();
      setOpened(undefined);
      setConversation(EMPTY_STATE);
      setSessionLifecycleOpen(false);
      const remaining = client === undefined
        ? sessions.filter((session) => session.sessionId !== deletedSessionId)
        : await refreshSessions(client);
      setSessions(remaining);
      if (client !== undefined && remaining[0] !== undefined) {
        await openSession(client, remaining[0].sessionId);
      } else {
        showActionNotice("Session history deleted permanently");
      }
    } catch (cause) {
      openedSessionId.current = deletedSessionId;
      if (preview === undefined) retainBrowserSession(deletedSessionId);
      setSessionLifecycleError(cause instanceof Error ? cause.message : "Could not delete the session");
    } finally {
      setBusy(false);
    }
  };

  const uploadAttachment = async (attachment: ComposerAttachment): Promise<void> => {
    if (!opened) return;
    const controller = new AbortController();
    uploadControllers.current.set(attachment.id, controller);
    setAttachments((current) => current.map((item) =>
      item.id === attachment.id
        ? { id: item.id, file: item.file, status: "uploading", progress: 0 }
        : item,
    ));
    try {
      if (attachment.file.size === 0 || attachment.file.size > MAX_UPLOAD_BLOB_BYTES) {
        throw new Error(`Attachments must be between 1 byte and ${MAX_UPLOAD_BLOB_BYTES / 1024 / 1024} MiB`);
      }
      const progress = (uploadedBytes: number): void => {
        setAttachments((current) => current.map((item) =>
          item.id === attachment.id
            ? { ...item, progress: uploadedBytes / attachment.file.size }
            : item,
        ));
      };
      const reference = preview?.uploadBlob !== undefined
        ? await preview.uploadBlob(attachment.file, progress, controller.signal)
        : client !== undefined
          ? await uploadSessionBlob(
              client,
              opened.sessionId,
              new Uint8Array(await attachment.file.arrayBuffer()),
              {
                mediaType: attachment.file.type || "application/octet-stream",
                name: attachment.file.name,
                signal: controller.signal,
                onProgress: progress,
              },
            )
          : undefined;
      if (reference === undefined) throw new Error("Attachment upload is unavailable");
      if (uploadControllers.current.get(attachment.id) !== controller) return;
      setAttachments((current) => current.map((item) =>
        item.id === attachment.id
          ? { id: item.id, file: item.file, status: "ready", progress: 1, reference }
          : item,
      ));
    } catch (cause) {
      if (uploadControllers.current.get(attachment.id) !== controller) return;
      setAttachments((current) => current.map((item) =>
        item.id === attachment.id
          ? {
              ...item,
              status: "failed",
              error: cause instanceof Error ? cause.message : "Upload failed",
            }
          : item,
      ));
    } finally {
      if (uploadControllers.current.get(attachment.id) === controller) {
        uploadControllers.current.delete(attachment.id);
      }
    }
  };

  const attachFiles = (files: readonly File[]): void => {
    const added = files.map((file) => ({
      id: ++attachmentSequence.current,
      file,
      status: "uploading" as const,
      progress: 0,
    }));
    setAttachments((current) => [...current, ...added]);
    for (const attachment of added) void uploadAttachment(attachment);
  };

  const removeAttachment = (id: number): void => {
    uploadControllers.current.get(id)?.abort();
    uploadControllers.current.delete(id);
    setAttachments((current) => current.filter((item) => item.id !== id));
  };

  const shellPrecondition = (): string | undefined => {
    if (conversation.activeOperationId !== undefined || pendingTurnDeliveries > 0) {
      return "Interrupt the active operation before running a shell command";
    }
    if ((!client && preview?.shell === undefined) || !opened) {
      return "Direct shell is unavailable until the session is connected";
    }
    return undefined;
  };

  const executeShell = async (
    command: string,
    excluded: boolean,
    source: "composer" | "terminal",
    restore: (input: string) => void,
  ): Promise<void> => {
    if (!opened) return;
    const input = `${excluded ? "!!" : "!"} ${command}`;
    const report = source === "terminal" ? setTerminalError : setError;
    const generation = selectionGeneration.current;
    const operationId = parseOperationId(crypto.randomUUID());
    directCancellationRequested.current = false;
    setBusy(true);
    report(undefined);
    setDirectOperation({ kind: "shell", sessionId: opened.sessionId, cancelling: false, source, command });
    try {
      const outcome = preview?.shell !== undefined
        ? await preview.shell(operationId, command, excluded, setConversation)
        : await client?.shell({
            sessionId: opened.sessionId,
            operationId,
            command,
            excluded,
          });
      if (generation !== selectionGeneration.current || outcome === undefined) return;
      if (outcome.state === "uncertain") {
        subscription.current?.projector.markShellUncertain(operationId, command);
        if (subscription.current !== undefined) setConversation(subscription.current.projector.state);
        restore(input);
        report("Shell delivery status is unknown. The command was restored and was not retried.");
      } else if (directCancellationRequested.current) {
        showActionNotice("Shell command cancelled");
      } else if (source === "composer") {
        showActionNotice(outcome.result.isError ? "Shell command failed" : "Shell command completed");
      }
    } catch (cause) {
      if (generation !== selectionGeneration.current) return;
      if (directCancellationRequested.current) showActionNotice("Shell command cancelled");
      else {
        restore(input);
        report(cause instanceof Error ? cause.message : "Shell command failed");
      }
    } finally {
      if (generation === selectionGeneration.current) {
        setBusy(false);
        setDirectOperation(undefined);
        directCancellationRequested.current = false;
        if (source === "composer") queueMicrotask(() => composer.current?.focus());
      }
    }
  };

  const runShell = async (input: string): Promise<void> => {
    const shell = directShellInput(input);
    if (shell === undefined) return;
    if (!shell.command) {
      setError("Enter a command after !");
      return;
    }
    if (attachments.length > 0) {
      setError("Remove prompt attachments before running a shell command");
      return;
    }
    const blocked = shellPrecondition();
    if (blocked !== undefined) {
      setError(blocked);
      return;
    }
    setDraft("");
    await executeShell(shell.command, shell.excluded, "composer", setDraft);
  };

  const runTerminalCommand = async (command: string, excluded: boolean): Promise<void> => {
    const blocked = shellPrecondition();
    if (blocked !== undefined) {
      setTerminalError(blocked);
      return;
    }
    await executeShell(command, excluded, "terminal", () => undefined);
  };

  const send = async (override?: PromptDeliveryMode): Promise<void> => {
    const text = draft.trim();
    const readyAttachments = attachments.filter(
      (attachment): attachment is ComposerAttachment & { readonly reference: BlobReference } =>
        attachment.status === "ready" && attachment.reference !== undefined,
    );
    if (
      (!client && preview?.deliverPrompt === undefined) ||
      !opened ||
      (!text && readyAttachments.length === 0) ||
      attachments.some((attachment) => attachment.status === "uploading") ||
      busy
    ) return;
    if (text.startsWith("!")) {
      await runShell(text);
      return;
    }
    if (/^\/[a-z]/u.test(text)) {
      if (readyAttachments.length > 0) {
        setError("Remove prompt attachments before running a command");
        return;
      }
      await runCommand(text);
      return;
    }
    const mode: PromptDeliveryMode =
      override ??
      (conversation.activeOperationId !== undefined || pendingTurnDeliveries > 0
        ? "steer"
        : "prompt");
    const requiredCapability = ({
      prompt: "session.send.prompt",
      steer: "session.steer",
      follow_up: "session.follow_up",
      interrupt: "session.interrupt_deliver",
      queue_front: "session.queue.enqueue",
      queue_back: "session.queue.enqueue",
    } as const)[mode];
    if (
      preview?.deliverPrompt === undefined &&
      client !== undefined &&
      !client.connection.grantedCapabilities.includes(requiredCapability)
    ) {
      setError(`Connection was not granted capability ${requiredCapability}`);
      return;
    }
    setDraft("");
    setAttachments((current) => current.filter((attachment) => attachment.status !== "ready"));
    setError(undefined);
    const content: readonly UserContent[] = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...readyAttachments.map((attachment) => ({
        type: "blob" as const,
        blob: attachment.reference,
      })),
    ];
    const restoreAttachments = (): void => setAttachments((current) => [
      ...readyAttachments.filter(
        (attachment) => !current.some((item) => item.id === attachment.id),
      ),
      ...current,
    ]);
    const pendingInput = mode === "steer" || mode === "follow_up" || mode === "interrupt"
      ? {
          id: ++pendingInputSequence.current,
          mode,
          text: text || readyAttachments.map((attachment) => attachment.file.name).join(", "),
          contentKey: JSON.stringify(content),
          afterRecord: conversation.records.length,
        }
      : undefined;
    if (pendingInput !== undefined) setPendingInputs((current) => [...current, pendingInput]);
    setPendingDeliveries((current) => current + 1);
    if (mode === "prompt" || mode === "interrupt") {
      setPendingTurnDeliveries((current) => current + 1);
    }
    try {
      const delivery = preview?.deliverPrompt !== undefined
        ? await preview.deliverPrompt(mode, content, setConversation)
        : client !== undefined
          ? { outcome: await deliverPrompt(client, opened.sessionId, content, mode) }
          : undefined;
      if (delivery === undefined) return;
      const { outcome } = delivery;
      if ("conversation" in delivery) setConversation(delivery.conversation);
      if (outcome.state === "uncertain") {
        if (pendingInput !== undefined) setPendingInputs((current) => current.filter((item) => item.id !== pendingInput.id));
        if (text) setDraft((current) => restoreDraft(text, current));
        restoreAttachments();
        setError("Delivery status is unknown. The prompt was restored for review.");
      } else {
        if (outcome.state === "accepted") {
          showActionNotice(outcome.mode === "steer" ? "Steer accepted" : "Follow-up accepted");
        } else if (outcome.state === "queued") {
          if (pendingInput !== undefined) setPendingInputs((current) => current.filter((item) => item.id !== pendingInput.id));
          showActionNotice(outcome.queueState === "paused" ? "Prompt queued and paused" : "Prompt queued");
        }
        if (outcome.state === "completed" && client !== undefined) await refreshSessions(client);
      }
    } catch (cause) {
      if (pendingInput !== undefined) setPendingInputs((current) => current.filter((item) => item.id !== pendingInput.id));
      if (text) setDraft((current) => restoreDraft(text, current));
      restoreAttachments();
      setError(cause instanceof Error ? cause.message : "Message was not delivered");
    } finally {
      setPendingDeliveries((current) => Math.max(0, current - 1));
      if (mode === "prompt" || mode === "interrupt") {
        setPendingTurnDeliveries((current) => Math.max(0, current - 1));
      }
    }
  };

  const configureModel = async (choice: ModelChoice): Promise<void> => {
    if (preview !== undefined) {
      setConversation((current) => ({ ...current, provider: choice.providerId, model: choice.modelId }));
      return;
    }
    const controller = configurationController.current;
    if (!opened || controller === undefined) return;
    setBusy(true); setModelActionError(undefined);
    try {
      await controller.configure(opened.sessionId, {
        providerId: choice.providerId,
        modelId: choice.modelId,
      });
      await refreshCommandDirectory(opened.sessionId);
    } catch (cause) {
      setModelActionError(cause instanceof Error ? cause.message : "Could not change model");
    } finally {
      setBusy(false);
    }
  };

  const configureThinking = async (thinkingLevel: ThinkingLevel): Promise<void> => {
    if (preview !== undefined) {
      setConversation((current) => ({ ...current, thinking: thinkingLevel }));
      return;
    }
    const controller = configurationController.current;
    if (!opened || controller === undefined) return;
    setBusy(true); setModelActionError(undefined);
    try {
      await controller.configure(opened.sessionId, { thinkingLevel });
      await refreshCommandDirectory(opened.sessionId);
    } catch (cause) {
      setModelActionError(cause instanceof Error ? cause.message : "Could not change effort");
    } finally {
      setBusy(false);
    }
  };

  const configureWebTool = async (field: WebToolField, enabled: boolean): Promise<void> => {
    if (preview !== undefined) {
      setConversation((current) => ({ ...current, [field]: enabled }));
      return;
    }
    const controller = configurationController.current;
    if (!opened || controller === undefined) return;
    try {
      await controller.configure(opened.sessionId, webToolConfiguration(field, enabled));
      await refreshCommandDirectory(opened.sessionId);
    } catch {
      // The SDK controller publishes the failure beside the originating field.
    }
  };

  const showActionNotice = (message: string): void => {
    setActionNotice(message);
    if (actionNoticeTimer.current !== undefined) clearTimeout(actionNoticeTimer.current);
    actionNoticeTimer.current = setTimeout(() => setActionNotice(undefined), 1800);
  };

  const copyMessage = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      showActionNotice("Message copied");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not copy message");
    }
  };

  const respondInteraction = async (interactionId: string, action: InteractionAction, content?: JsonObject): Promise<void> => {
    if (preview !== undefined) {
      showActionNotice(`Interaction ${action}`);
      return;
    }
    if (!client || !opened) throw new Error("The session is not connected");
    await client.request("session.interaction.respond", {
      sessionId: opened.sessionId,
      interactionId,
      action,
      ...(content === undefined ? {} : { content }),
    });
  };

  const loadFullToolOutput = async (_tool: ProjectedToolCall, blob: BlobReference): Promise<string> => {
    const bytes = preview?.readBlob === undefined
      ? client && opened ? await client.readBlob(opened.sessionId, blob) : undefined
      : await preview.readBlob(blob.sha256);
    if (bytes === undefined) throw new Error("Complete output is unavailable");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new Error("Complete output is not valid UTF-8 text", { cause });
    }
  };

  const forkMessage = async (fromEventId: EventId): Promise<void> => {
    if (conversation.activeOperationId !== undefined) {
      setError("Finish or interrupt the current response before forking");
      return;
    }
    if (preview !== undefined) {
      showActionNotice("Fork preview");
      return;
    }
    const controller = commandController.current;
    if (!client || !opened || controller === undefined) return;
    setBusy(true); setError(undefined);
    try {
      const outcome = await controller.invoke(`/fork ${fromEventId}`, opened.sessionId);
      if (outcome.state !== "open-session") throw new Error("Fork did not open a session");
      await refreshSessions(client);
      await openSession(client, outcome.session.sessionId, outcome.session);
      setDraft(outcome.session.selectedText ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not fork the session");
      setBusy(false);
    }
  };

  const reconnect = async (): Promise<void> => {
    if (!client) return;
    setError(undefined);
    try {
      await client.reconnect();
      await refreshSessions(client);
      await refreshCommandDirectory(opened?.sessionId);
      workspaceController.current?.reset();
      if (workspaceCheckpointEnabled === true) {
        await workspaceController.current?.checkpoint(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reconnect to the daemon");
    }
  };

  const interrupt = async (): Promise<void> => {
    if ((!client && preview?.interrupt === undefined) || !opened) return;
    try {
      if (preview?.interrupt !== undefined) await preview.interrupt(setConversation);
      else await client?.request("session.interrupt", { sessionId: opened.sessionId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not interrupt the session");
    }
  };

  const workspaceOperations = (): WorkspaceOperations | undefined =>
    preview?.workspaceClient ?? workspaceController.current;

  const loadWorkspaceChanges = async (scope: WorkspaceStatusScope = "working"): Promise<void> => {
    setWorkspaceScope(scope);
    if (preview?.workspace !== undefined && preview.workspaceClient === undefined) {
      setWorkspaceReview(preview.workspace);
      return;
    }
    const operations = workspaceOperations();
    if (operations === undefined) return;
    const session = workspaceRequestGeneration.current;
    const request = ++reviewRequest.current;
    const current = (): boolean =>
      session === workspaceRequestGeneration.current && request === reviewRequest.current;
    setReviewLoading(true);
    setReviewError(undefined);
    try {
      const review = await operations.review(scope);
      if (current()) setWorkspaceReview(review);
    } catch (cause) {
      if (current())
        setReviewError(cause instanceof Error ? cause.message : "Could not load workspace changes");
    } finally {
      if (current()) setReviewLoading(false);
    }
  };

  const loadWorkspaceDirectory = async (path: string, append = false): Promise<void> => {
    const operations = workspaceOperations();
    if (operations === undefined) return;
    const cursor = append && workspaceBrowser.path === path
      ? workspaceBrowser.nextPageCursor
      : undefined;
    if (append && cursor === undefined) return;
    const session = workspaceRequestGeneration.current;
    const request = ++listRequest.current;
    const current = (): boolean =>
      session === workspaceRequestGeneration.current && request === listRequest.current;
    setBrowserLoading(true);
    setBrowserError(undefined);
    if (!append) setWorkspaceBrowser((state) => ({ path, entries: [], loaded: false, ...(state.file === undefined ? {} : { file: state.file }) }));
    try {
      const result = await operations.list(path, cursor);
      if (!current()) return;
      setWorkspaceBrowser((state) => ({
        ...state,
        path,
        entries: append && state.path === path
          ? [...state.entries, ...result.entries]
          : result.entries,
        loaded: true,
        ...(result.nextPageCursor === undefined
          ? {}
          : { nextPageCursor: result.nextPageCursor }),
      }));
    } catch (cause) {
      if (current())
        setBrowserError(cause instanceof Error ? cause.message : "Could not list workspace files");
    } finally {
      if (current()) setBrowserLoading(false);
    }
  };

  const loadWorkspaceFile = async (path: string, append = false): Promise<void> => {
    const operations = workspaceOperations();
    if (operations === undefined) return;
    const previous = append && workspaceBrowser.file?.path === path
      ? workspaceBrowser.file
      : undefined;
    if (append && (previous === undefined || !previous.truncated)) return;
    const session = workspaceRequestGeneration.current;
    const request = ++fileRequest.current;
    const current = (): boolean =>
      session === workspaceRequestGeneration.current && request === fileRequest.current;
    setBrowserLoading(true);
    setBrowserError(undefined);
    try {
      const result = await operations.read(
        path,
        previous === undefined ? 1 : previous.endLine + 1,
        previous?.fileRevision,
      );
      if (!current()) return;
      setWorkspaceBrowser((state) => ({
        ...state,
        file: previous === undefined
          ? result
          : {
              ...result,
              startLine: previous.startLine,
              text: previous.text + result.text,
            },
      }));
    } catch (cause) {
      if (current())
        setBrowserError(cause instanceof Error ? cause.message : "Could not read workspace file");
    } finally {
      if (current()) setBrowserLoading(false);
    }
  };

  const refreshWorkspaceFiles = (): void => {
    workspaceOperations()?.reset();
    void loadWorkspaceDirectory(workspaceBrowser.path);
  };

  const refreshWorkspaceChanges = (): void => {
    workspaceOperations()?.reset();
    void loadWorkspaceChanges(workspaceScope);
  };

  const configureWorkspaceCheckpoint = async (enabled: boolean): Promise<void> => {
    const operations = workspaceOperations();
    if (operations === undefined) return;
    const session = workspaceRequestGeneration.current;
    const request = ++reviewRequest.current;
    const current = (): boolean =>
      session === workspaceRequestGeneration.current && request === reviewRequest.current;
    setReviewLoading(true);
    setReviewError(undefined);
    try {
      const result = await operations.checkpoint(enabled);
      if (!current()) return;
      setWorkspaceCheckpointEnabled(result.enabled);
      showActionNotice(enabled ? "Workspace checkpoints started" : "Workspace checkpoints stopped");
      if (enabled) {
        setWorkspaceScope("last-turn");
        await loadWorkspaceChanges("last-turn");
      }
    } catch (cause) {
      if (current())
        setReviewError(
          cause instanceof Error ? cause.message : "Could not configure workspace checkpoints",
        );
    } finally {
      if (current()) setReviewLoading(false);
    }
  };

  const runCommand = async (input: string): Promise<void> => {
    const controller = commandController.current;
    const previewCompact = /^\/compact(?:\s+(.*))?$/u.exec(input.trim());
    const resolvedCommand = controller?.resolve(input);
    const requiresSession = previewCompact !== null || resolvedCommand?.context === "session";
    if (
      (requiresSession && opened === undefined) ||
      (previewCompact === null && (controller === undefined || client === undefined)) ||
      (previewCompact !== null && preview?.compact === undefined && (controller === undefined || client === undefined))
    ) {
      setError("Commands are unavailable until the session is connected");
      return;
    }
    if (input.trim() === "/import" && resolvedCommand?.name === "import") {
      if (resolvedCommand.availability.state === "unavailable") {
        setError(resolvedCommand.availability.reason);
      } else {
        setDraft("");
        artifactInput.current?.click();
      }
      return;
    }
    const compacting = previewCompact !== null || resolvedCommand?.name === "compact";
    const generation = selectionGeneration.current;
    let restoreComposerFocus = true;
    directCancellationRequested.current = false;
    setDraft("");
    setBusy(true);
    setError(undefined);
    if (compacting && opened !== undefined) {
      setDirectOperation({ kind: "compaction", sessionId: opened.sessionId, cancelling: false });
    }
    try {
      const outcome = previewCompact !== null && preview?.compact !== undefined
        ? (await preview.compact(previewCompact[1]?.trim() || undefined, setConversation), {
            state: "completed" as const,
            command: "compact",
          })
        : await controller?.invoke(input, opened?.sessionId, {
            ...(conversation.requestSettings === undefined
              ? {}
              : { requestSettings: conversation.requestSettings }),
          });
      if (generation !== selectionGeneration.current || outcome === undefined) return;
      if (outcome.state === "open-session") {
        if (client === undefined) throw new Error("Session switching is unavailable in preview mode");
        await refreshSessions(client);
        await openSession(client, outcome.session.sessionId, outcome.session);
        setDraft(outcome.session.selectedText ?? "");
        return;
      }
      if (outcome.state === "session-configured") {
        await refreshCommandDirectory(opened?.sessionId);
        showActionNotice(`/${outcome.command} completed`);
        return;
      }
      if (
        outcome.state === "provider-catalog-refreshed" ||
        outcome.state === "provider-logged-out"
      ) {
        await providerDirectoryController.current?.load(true);
        showActionNotice(`/${outcome.command} completed`);
        return;
      }
      if (outcome.state === "completed") {
        if (outcome.command === "rename" && client !== undefined) await refreshSessions(client);
        showActionNotice(
          compacting && directCancellationRequested.current
            ? "Compaction cancelled"
            : `/${outcome.command} completed`,
        );
        return;
      }
      if (outcome.surface === "adopt") {
        setAdoptionOpen(true);
        const adoption = adoptionController.current;
        if (adoption !== undefined && adoption.state.status !== "unavailable") {
          const projectRoot = opened?.cwd;
          await adoption.loadAll({
            ...(projectRoot === undefined ? { scopes: ["global"] as const } : { projectRoot, scopes: ["global", "project"] as const }),
            includeMalformed: true,
          });
          adoption.dismissFindings();
          setAdoptionNoticeVisible(false);
        }
        restoreComposerFocus = false;
      } else if (outcome.surface === "model" || outcome.surface === "thinking") {
        setModelPickerInitialFocus(outcome.surface);
        setModelPickerOpenRequest((current) => current + 1);
      } else if (
        outcome.surface === "providers" ||
        outcome.surface === "login" ||
        outcome.surface === "logout"
      ) {
        setUsageOpen(false);
        setTranscriptSearchOpen(false);
        setControlCenter("providers");
      } else if (outcome.surface === "request") {
        const settings = conversation.requestSettings;
        showActionNotice(
          settings === undefined
            ? "Request settings are unavailable for this runtime"
            : `Output ${settings.maxOutputTokens ?? "model"} · idle ${settings.httpIdleTimeoutMs || "disabled"}`,
        );
      } else if (outcome.surface === "resume") {
        setSidebarCollapsed(false);
        setSidebarOpen(true);
      } else if (outcome.surface === "fork") {
        showActionNotice("Choose Fork on the message where the new session should begin");
      } else if (outcome.surface === "requeue") {
        restoreComposerFocus = false;
        setRequeueError(undefined);
        setRequeueOpen(true);
      } else if (outcome.surface === "import") {
        artifactInput.current?.click();
      } else if (outcome.surface === "attach") {
        fileInput.current?.click();
      } else if (outcome.surface === "export") {
        await exportArtifact();
      } else if (outcome.surface === "dispose" || outcome.surface === "delete") {
        setSessionLifecycleError(undefined);
        setSessionLifecycleOpen(true);
      } else if (outcome.surface === "review") {
        const scope = workspaceReviewScope(outcome.argument);
        if (scope === undefined) applyPaneLayout(closePane(paneLayout, "changes"));
        else {
          applyPaneLayout(openPane(paneLayout, "changes"));
          await loadWorkspaceChanges(scope);
        }
      }
    } catch (cause) {
      if (generation !== selectionGeneration.current) return;
      setDraft(input);
      if (compacting && directCancellationRequested.current) showActionNotice("Compaction cancelled");
      else setError(cause instanceof Error ? cause.message : "Command failed");
    } finally {
      if (generation === selectionGeneration.current) {
        setBusy(false);
        if (compacting) setDirectOperation(undefined);
        directCancellationRequested.current = false;
        if (restoreComposerFocus) queueMicrotask(() => composer.current?.focus());
      }
    }
  };

  const restoreQueuedInputs = async (interrupt: boolean): Promise<void> => {
    if (client === undefined || opened === undefined) return;
    const generation = selectionGeneration.current;
    setError(undefined);
    try {
      const result = await restoreQueuedPrompts(client, opened.sessionId, interrupt);
      if (generation !== selectionGeneration.current) return;
      const texts = result.items.map((item) =>
        item.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
      );
      setDraft((current) => [...texts, current].filter(Boolean).join("\n\n"));
      const blobs = result.items.flatMap((item) =>
        item.content.flatMap((part) => part.type === "blob" ? [part.blob] : []),
      );
      setAttachments((current) => [
        ...blobs.filter((blob) => !current.some((item) => item.reference?.sha256 === blob.sha256)).map((blob) => ({
          id: ++attachmentSequence.current,
          file: new File([], blob.name ?? "attachment", { type: blob.mediaType }),
          status: "ready" as const,
          progress: 1,
          reference: blob,
        })),
        ...current,
      ]);
      setPendingInputs([]);
      showActionNotice(
        result.items.length === 0
          ? interrupt && result.interrupted ? "Response interrupted" : "No queued prompts"
          : `${result.items.length} queued prompt${result.items.length === 1 ? "" : "s"} restored`,
      );
      queueMicrotask(() => composer.current?.focus());
    } catch (cause) {
      if (generation === selectionGeneration.current)
        setError(cause instanceof Error ? cause.message : "Could not restore queued prompts");
    }
  };

  const requeueItem = async (queueItemId: EventId): Promise<void> => {
    const controller = commandController.current;
    const sessionId = opened?.sessionId;
    if (controller === undefined || sessionId === undefined) return;
    const generation = selectionGeneration.current;
    setRequeueBusyItemId(queueItemId);
    setRequeueError(undefined);
    try {
      await controller.invoke(`/requeue ${queueItemId}`, sessionId);
      if (generation !== selectionGeneration.current) return;
      setRequeueOpen(false);
      showActionNotice("Prompt requeued");
    } catch (cause) {
      if (generation === selectionGeneration.current) {
        setRequeueError(cause instanceof Error ? cause.message : "Could not requeue the prompt");
      }
    } finally {
      if (generation === selectionGeneration.current) setRequeueBusyItemId(undefined);
    }
  };

  const cancelDirectOperation = async (): Promise<void> => {
    if (directOperation === undefined) return;
    directCancellationRequested.current = true;
    setDirectOperation({ ...directOperation, cancelling: true });
    setError(undefined);
    try {
      const result = preview?.interrupt !== undefined
        ? await preview.interrupt(setConversation)
        : client === undefined
          ? { interrupted: false }
          : await client.request("session.interrupt", { sessionId: directOperation.sessionId });
      if (!result.interrupted) {
        directCancellationRequested.current = false;
        setDirectOperation((current) => current && { ...current, cancelling: false });
      }
    } catch (cause) {
      directCancellationRequested.current = false;
      setDirectOperation((current) => current && { ...current, cancelling: false });
      setError(cause instanceof Error ? cause.message : "Could not cancel the operation");
    }
  };

  const selectCommand = (command: EffectiveCommand): void => {
    setCommandPaletteOpen(false);
    if (command.argument.required) {
      setDraft(`/${command.name} `);
      queueMicrotask(() => composer.current?.focus());
      return;
    }
    void runCommand(`/${command.name}`);
  };

  const currentPreferences = (): WebPreferences => ({
    sidebarWidth,
    dockWidth,
    sidebarCollapsed,
    changesView,
    panes: paneLayout.panes,
    ...(adoptionState.dismissedScanGeneration === undefined
      ? {}
      : { adoptionDismissedScanGeneration: adoptionState.dismissedScanGeneration }),
  });

  const applyPaneLayout = (layout: PaneLayout): void => {
    setPaneLayout(layout);
    if (layout.panes.length === 0) setMobileDock(false);
    if (layout.panes.join() !== paneLayout.panes.join()) {
      persistLayout({ ...currentPreferences(), panes: layout.panes });
    }
  };

  const mentionPath = (path: string): void => {
    setDraft((current) => {
      const trimmed = current.trimEnd();
      return trimmed === "" ? `${path} ` : `${trimmed} ${path} `;
    });
    showActionNotice("Path added to the prompt");
    queueMicrotask(() => {
      const field = composer.current;
      if (field === null) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  };

  const openInFiles = (path: string): void => {
    if (!paneLayout.panes.includes("files")) applyPaneLayout(openPane(paneLayout, "files"));
    const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (workspaceBrowser.path !== directory || !workspaceBrowser.loaded) void loadWorkspaceDirectory(directory);
    void loadWorkspaceFile(path);
  };

  const togglePaneOpen = (pane: PaneId): void => {
    const next = togglePane(paneLayout, pane);
    if (next.panes.includes(pane) && matchMedia("(max-width: 1180px)").matches) {
      setSidebarOpen(false);
      setMobileDock(true);
    }
    applyPaneLayout(next);
  };

  const persistLayout = (preferences: WebPreferences): void => {
    setSettingsError(undefined);
    if (preview !== undefined) {
      localStorage.setItem(PREVIEW_LAYOUT_KEY, JSON.stringify(preferences));
      return;
    }
    void saveWebPreferences(preferences).catch((cause: unknown) =>
      setSettingsError(cause instanceof Error ? cause.message : "Could not save layout"),
    );
  };

  const applyWebPreferences = (preferences: WebPreferences): void => {
    setSidebarWidth(preferences.sidebarWidth);
    setDockWidth(preferences.dockWidth);
    setSidebarCollapsed(preferences.sidebarCollapsed);
    setChangesView(preferences.changesView);
    if (preferences.panes.join() !== paneLayout.panes.join()) setPaneLayout(createPaneLayout(preferences.panes));
    persistLayout(preferences);
  };

  const refreshProviders = async (providerId?: string): Promise<void> => {
    setProviderActionError(undefined);
    if (preview !== undefined) {
      showActionNotice(providerId === undefined ? "Provider catalogs refreshed" : `${providerId} refreshed`);
      return;
    }
    try {
      await providerDirectoryController.current?.refresh(providerId);
    } catch {
      // The SDK controller exposes the scoped provider error.
    }
  };

  const startProviderLogin = async (
    providerId: string,
    method: ProviderLoginMethod,
  ): Promise<void> => {
    if (providerLoginController.current !== undefined) return;
    const controller = new AbortController();
    providerLoginController.current = controller;
    setProviderLogin({ providerId, method });
    setProviderActionError(undefined);
    try {
      const status = preview?.loginProvider !== undefined
        ? await preview.loginProvider(providerId, method, controller.signal)
        : await browserProviderHost.loginProvider({ providerId, method }, { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (client !== undefined) {
        await providerDirectoryController.current?.load(true);
      } else {
        setProviderDirectory((directory) => ({
          ...directory,
          providers: directory.providers.map((provider) =>
            provider.providerId === providerId
              ? { ...provider, authentication: status }
              : provider,
          ),
        }));
      }
      showActionNotice(`${providerId} connected`);
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        showActionNotice("Provider login cancelled");
      } else {
        setProviderActionError(cause instanceof Error ? cause.message : "Could not log in to provider");
      }
    } finally {
      if (providerLoginController.current === controller) {
        providerLoginController.current = undefined;
        setProviderLogin(undefined);
      }
    }
  };

  const cancelProviderLogin = (): void => providerLoginController.current?.abort();

  const logoutProvider = async (providerId: string): Promise<void> => {
    if (preview !== undefined) {
      showActionNotice(`${providerId} logout preview`);
      return;
    }
    const controller = commandController.current;
    if (!client || controller === undefined) return;
    setProviderActionError(undefined);
    try {
      await controller.invoke(`/logout ${providerId}`);
      await providerDirectoryController.current?.load(true);
    } catch (cause) {
      setProviderActionError(cause instanceof Error ? cause.message : "Could not log out provider");
    }
  };

  const copyProviderLogin = async (
    providerId: string,
    method: ProviderLoginMethod,
  ): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`axl login ${providerId} ${method}`);
      showActionNotice("Login command copied");
    } catch (cause) {
      setProviderActionError(cause instanceof Error ? cause.message : "Could not copy login command");
    }
  };

  const toggleSidebar = (): void => {
    if (matchMedia("(max-width: 760px)").matches) {
      setSidebarOpen(false);
      return;
    }
    const collapsed = !sidebarCollapsed;
    setSidebarCollapsed(collapsed);
    persistLayout({ ...currentPreferences(), sidebarCollapsed: collapsed });
  };

  const dockOpen = paneLayout.panes.length > 0;
  const effectiveDockWidth = dockOpen ? dockWidth : 0;
  const clampWidth = (side: "left" | "right", value: number): number => side === "left"
    ? Math.round(Math.max(SIDEBAR_WIDTH_RANGE.min, Math.min(SIDEBAR_WIDTH_RANGE.max, value, window.innerWidth - effectiveDockWidth - 520)))
    : Math.round(Math.max(DOCK_WIDTH_RANGE.min, Math.min(DOCK_WIDTH_RANGE.max, value, window.innerWidth - (sidebarCollapsed ? 56 : sidebarWidth) - 520)));

  const resizePanelBy = (side: "left" | "right", delta: number): void => {
    const next = clampWidth(side, (side === "left" ? sidebarWidth : dockWidth) + delta);
    if (side === "left") setSidebarWidth(next);
    else setDockWidth(next);
    persistLayout({
      ...currentPreferences(),
      sidebarWidth: side === "left" ? next : sidebarWidth,
      dockWidth: side === "right" ? next : dockWidth,
    });
  };

  const resizePanel = (side: "left" | "right", start: React.PointerEvent): void => {
    start.preventDefault();
    let next = side === "left" ? sidebarWidth : dockWidth;
    document.body.classList.add("resizing-panels");
    const move = (event: PointerEvent): void => {
      next = clampWidth(side, side === "left" ? event.clientX : window.innerWidth - event.clientX);
      if (side === "left") setSidebarWidth(next);
      else setDockWidth(next);
    };
    const stop = (): void => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", stop);
      document.body.classList.remove("resizing-panels");
      persistLayout({
        ...currentPreferences(),
        sidebarWidth: side === "left" ? next : sidebarWidth,
        dockWidth: side === "right" ? next : dockWidth,
      });
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", stop, { once: true });
  };

  const selectedSummary = sessions.find((item) => item.sessionId === opened?.sessionId);
  const currentTitle = selectedSummary === undefined ? opened?.title ?? "Current session" : sessionTitle(selectedSummary);
  const visibleSessions = sessions.filter((session) => matchesSession(session, query));
  const projectFolders = useMemo(
    () =>
      [...new Set([bootstrap?.cwd, preview?.opened.cwd, ...sessions.map((session) => session.cwd)])]
        .filter((path): path is string => path !== undefined && path.trim() !== "")
        .slice(0, 4),
    [bootstrap?.cwd, preview?.opened.cwd, sessions],
  );
  const promptBreakpoints = useMemo(() => transcriptPromptBreakpoints(conversation), [conversation]);
  const transcriptMatches = useMemo(() => transcriptMessageMatches(conversation, transcriptQuery), [conversation, transcriptQuery]);
  const usageStats = useMemo(() => sessionUsageStats(conversation), [conversation]);
  const stateHistory = useMemo(() => sessionStateHistory(conversation), [conversation]);
  const pausedQueue = useMemo(() => pausedQueueItems(conversation.queue), [conversation.queue]);
  const peers = useMemo(
    () => sessionPeers(presence, opened?.sessionId, client?.connection.attachmentId),
    [presence, opened?.sessionId, client],
  );
  const peerDescription = presenceDescription(peers);
  const slashCommands = useMemo(
    () => (/^\/[a-z0-9-]*$/u.test(draft.trim()) ? filterCommands(commands, draft).slice(0, 6) : []),
    [commands, draft],
  );
  const connected = connection === "connected";
  const configurationPending = configurationState.pending.length > 0;
  const webToolPending = configurationState.pending.filter(
    (field): field is WebToolField => field === "webSearch" || field === "webFetch",
  );
  const webToolErrors = {
    ...(configurationState.errors.webSearch === undefined
      ? {}
      : { webSearch: configurationState.errors.webSearch }),
    ...(configurationState.errors.webFetch === undefined
      ? {}
      : { webFetch: configurationState.errors.webFetch }),
  };
  const modelConfigurationError =
    configurationState.errors.modelId ??
    configurationState.errors.providerId ??
    configurationState.errors.thinkingLevel;
  const deliveryActive = conversation.activeOperationId !== undefined || pendingTurnDeliveries > 0;
  const orderedPendingInputs = useMemo(() => orderPendingTurnInputs(pendingInputs), [pendingInputs]);
  const attachmentUploading = attachments.some((attachment) => attachment.status === "uploading");
  const readyAttachmentCount = attachments.filter((attachment) => attachment.status === "ready").length;
  const hasCapability = (capability: string): boolean =>
    preview?.capabilities === undefined
      ? preview !== undefined || client?.connection.grantedCapabilities.includes(capability) === true
      : preview.capabilities.includes(capability);
  const canUpload = hasCapability("session.blob.start") &&
    (preview?.uploadBlob !== undefined || client !== undefined);
  const canShell = hasCapability("session.shell") && (preview?.shell !== undefined || client !== undefined);
  const canConfigure = hasCapability("session.configure");
  const canCreate = preview === undefined && client === undefined
    ? true
    : hasCapability("session.create");
  const unavailableConfigurationError =
    !canConfigure && connected ? "Session configuration was not granted" : undefined;
  const presentedModelConfigurationError =
    modelActionError ?? modelConfigurationError ?? unavailableConfigurationError;
  const presentedWebToolErrors = unavailableConfigurationError === undefined
    ? webToolErrors
    : { webSearch: unavailableConfigurationError, webFetch: unavailableConfigurationError };
  const canDeliver = hasCapability(deliveryActive ? "session.steer" : "session.send.prompt") &&
    (preview?.deliverPrompt !== undefined || client !== undefined);
  const canInterrupt = hasCapability("session.interrupt") &&
    (preview?.interrupt !== undefined || client !== undefined);
  const canLoginProvider = preview?.loginProvider !== undefined ||
    bootstrap?.hostCapabilities.includes("provider.auth.login") === true;
  const projectFolderValidator = preview !== undefined
    ? validatePreviewProjectFolder
    : bootstrap?.hostCapabilities.includes("project.folder.validate") === true
      ? validateProjectFolder
      : undefined;
  const codeSession = opened?.profile !== "chat";
  const canBrowseWorkspace = codeSession &&
    hasCapability("session.workspace.list") &&
    hasCapability("session.workspace.read") &&
    (preview?.workspaceClient !== undefined || client !== undefined);
  const canReviewWorkspace = codeSession &&
    hasCapability("session.workspace.status") &&
    hasCapability("session.workspace.diff") &&
    (preview?.workspace !== undefined || preview?.workspaceClient !== undefined || client !== undefined);
  const canCheckpointWorkspace = codeSession &&
    hasCapability("session.workspace.checkpoint") &&
    (preview?.workspaceClient !== undefined || client !== undefined);
  const lifecycleCapabilities = new Set<string>(preview?.capabilities ?? (preview === undefined
    ? client?.connection.grantedCapabilities ?? []
    : [
        ...(preview.cloneSession === undefined ? [] : ["session.clone"]),
        ...(preview.renameSession === undefined ? [] : ["session.rename"]),
        ...(preview.deleteSession === undefined ? [] : ["session.delete"]),
        ...(preview.exportSession === undefined ? [] : ["session.export"]),
        ...(preview.importSession === undefined ? [] : ["session.import"]),
        ...(preview.disposeSession === undefined ? [] : ["session.dispose"]),
      ]));
  const canManageSession = ["session.clone", "session.rename", "session.delete", "session.export", "session.dispose"]
    .some((capability) => lifecycleCapabilities.has(capability));
  const canImport = lifecycleCapabilities.has("session.import");

  const jumpToMessage = (id: string): void => {
    document.getElementById(`message-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActivePromptId(id);
  };

  const moveTranscriptMatch = (direction: -1 | 1): void => {
    if (transcriptMatches.length === 0) return;
    const current = transcriptMatch < 0 ? (direction === 1 ? -1 : 0) : transcriptMatch;
    const next = (current + direction + transcriptMatches.length) % transcriptMatches.length;
    setTranscriptMatch(next);
    const id = transcriptMatches[next];
    if (id !== undefined) jumpToMessage(id);
  };

  const trackTranscriptScroll = (): void => {
    const viewport = transcript.current;
    if (viewport === null) return;
    setTranscriptNavigationVisible(true);
    if (transcriptNavigationTimer.current !== undefined) clearTimeout(transcriptNavigationTimer.current);
    transcriptNavigationTimer.current = setTimeout(() => setTranscriptNavigationVisible(false), 1400);
    const threshold = viewport.getBoundingClientRect().top + 120;
    let active = promptBreakpoints[0]?.id;
    for (const point of promptBreakpoints) {
      const element = document.getElementById(`message-${point.id}`);
      if (element !== null && element.getBoundingClientRect().top <= threshold) active = point.id;
    }
    setActivePromptId(active);
  };

  const paneUnavailableReasons: Readonly<Record<PaneId, string | undefined>> = {
    browser: undefined,
    files: canBrowseWorkspace ? undefined : "Workspace browsing was not granted",
    changes: canReviewWorkspace ? undefined : "Workspace review was not granted",
    terminal: canShell ? undefined : "Shell access was not granted",
  };
  const terminalRecords = useMemo(() => terminalEntries(conversation), [conversation]);

  return <main className={`shell${sidebarCollapsed && !sidebarOpen ? " sidebar-collapsed" : ""}${dockOpen ? " dock-open" : ""}${mobileDock ? " mobile-dock" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px`, "--dock-width": `${dockWidth}px` } as CSSProperties}>
    <CommandPalette commands={commands} open={commandPaletteOpen} {...(commandPaletteError === undefined ? {} : { error: commandPaletteError })} onClose={() => { setCommandPaletteOpen(false); setCommandPaletteError(undefined); }} onSelect={selectCommand} />
    <button ref={mobileMenu} className="mobile-menu" aria-label="Open sessions" aria-controls="session-sidebar" aria-expanded={sidebarOpen} onClick={() => { setMobileDock(false); setSidebarOpen(true); }}><span></span><span></span><span></span></button>
    {sidebarOpen && <button className="scrim" aria-label="Close sessions" onClick={() => setSidebarOpen(false)} />}
    <aside id="session-sidebar" ref={sidebarPanel} className={sidebarOpen ? "sidebar open" : "sidebar"} aria-label="Sessions" role={sidebarOpen ? "dialog" : undefined} aria-modal={sidebarOpen || undefined} inert={mobileDock} onKeyDown={(event) => { if (sidebarOpen) trapDialogFocus(event, sidebarPanel.current); }}>
      <div className="brand"><span className="brand-mark">A</span><strong>Axl</strong><button ref={sidebarClose} className="sidebar-toggle" aria-label={sidebarOpen ? "Close sessions" : sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={toggleSidebar}><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6 2.5v11m4.5-8L8 8l2.5 2.5" /></svg></button></div>
      <div className="workspace-actions"><span>Workspace</span><div>{canImport && <button aria-label="Import session" title="Import session" disabled={busy} onClick={() => artifactInput.current?.click()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8m-3-3 3 3 3-3M3 13h10" /></svg></button>}<button aria-label="New session" title={canCreate ? "New session" : "Unavailable because session creation was not granted"} disabled={busy || !canCreate} onClick={() => openNewSession()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg></button></div><input ref={artifactInput} className="attachment-input" type="file" accept="application/json,.json" tabIndex={-1} aria-hidden="true" onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) void importArtifact(file); }} /></div>
      <label className="search"><span aria-hidden="true">⌕</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search sessions" placeholder="Search sessions" /></label>
      <nav>{visibleSessions.map((session) => <button key={session.sessionId} aria-label={`${sessionTitle(session)}, ${session.runtime.state}`} className={session.sessionId === opened?.sessionId ? "session active" : "session"} onClick={() => client && void openSession(client, session.sessionId)}><span className={`session-icon ${session.runtime.state}`} aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3 3.5h10v7H7l-3 2v-2H3z" /></svg></span><span><strong>{sessionTitle(session)}</strong><small>{session.cwd}</small></span></button>)}{visibleSessions.length === 0 && <p className="no-sessions">No matching sessions</p>}</nav>
      <button className="daemon" aria-label={connection === "disconnected" && client !== undefined ? "Reconnect local daemon" : "Open settings"} aria-expanded={controlCenter !== undefined} onClick={() => { if (connection === "disconnected" && client !== undefined) { void reconnect(); return; } setUsageOpen(false); setTranscriptSearchOpen(false); setControlCenter("settings"); }}><span className={`daemon-status ${connection}`} aria-hidden="true"></span><span><strong>Local daemon</strong><small>{connection === "disconnected" && client === undefined ? "Connection unavailable" : DAEMON_CONNECTION_LABELS[connection]}</small></span>{connection === "disconnected" && client !== undefined ? <svg className="daemon-action" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 6a5 5 0 1 0 .2 3M13 2.5V6H9.5" /></svg> : <svg className="daemon-action" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.25" /><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M12.4 3.6l-1.05 1.05M4.65 11.35 3.6 12.4" /></svg>}</button>
      {!sidebarCollapsed && <div className="panel-resizer left" role="separator" aria-orientation="vertical" aria-label="Resize session sidebar" aria-valuemin={200} aria-valuemax={420} aria-valuenow={sidebarWidth} aria-valuetext={`${sidebarWidth} pixels wide`} aria-keyshortcuts="ArrowLeft ArrowRight" tabIndex={0} onPointerDown={(event) => resizePanel("left", event)} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resizePanelBy("left", event.key === "ArrowLeft" ? -16 : 16); } }} />}
    </aside>
    <section className="workspace" inert={sidebarOpen || mobileDock}>
      <header className="topbar"><div><span className="crumb">Sessions</span><span className="separator">›</span><strong>{opened ? currentTitle : "Select a session"}</strong>{opened && <span className={`session-profile ${opened.profile}`}>{opened.profile === "chat" ? "Chat" : opened.profile === "standard" ? "Code" : opened.profile}</span>}{peers.length > 0 && <span className="session-presence" role="status" aria-label={peerDescription} title={peerDescription}><i aria-hidden="true"></i>{peers.length} other</span>}</div><div className="top-actions"><button className="command-toggle" aria-label="Open command palette" title="Commands (Ctrl+K)" onClick={() => { setCommandPaletteError(undefined); setCommandPaletteOpen(true); void refreshCommandDirectory(opened?.sessionId).catch((cause: unknown) => setCommandPaletteError(cause instanceof Error ? cause.message : "Could not refresh commands")); }}>/</button>{opened && canManageSession && <button className={sessionLifecycleOpen ? "session-manage active" : "session-manage"} aria-label="Manage session" aria-expanded={sessionLifecycleOpen} onClick={() => { setControlCenter(undefined); setSessionLifecycleError(undefined); setSessionLifecycleOpen(true); }}><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="13" cy="8" r="1" /></svg></button>}{opened && <button ref={usageToggle} className={usageOpen ? "usage-toggle active" : "usage-toggle"} aria-label="Show session usage" aria-expanded={usageOpen} onClick={() => { setControlCenter(undefined); setTranscriptSearchOpen(false); setUsageOpen((open) => !open); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12V8M8 12V4M13 12V6" /></svg><span>Usage</span></button>}{opened && <button className={transcriptSearchOpen ? "transcript-search-toggle active" : "transcript-search-toggle"} aria-label="Search transcript" aria-expanded={transcriptSearchOpen} onClick={() => { setControlCenter(undefined); setUsageOpen(false); setTranscriptSearchOpen((open) => !open); }}><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" /><path d="m10.25 10.25 3 3" /></svg></button>}{opened && dockOpen && <button ref={mobileDockToggle} type="button" className="mobile-dock-toggle" aria-label="Show panes" aria-controls="pane-dock" aria-expanded={mobileDock} onClick={() => { setSidebarOpen(false); setMobileDock(true); }}><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M9 2.5v11M9 8h5" /></svg></button>}{opened && <PanePicker openPanes={paneLayout.panes} unavailableReasons={paneUnavailableReasons} badges={workspaceReview === undefined ? {} : { changes: workspaceReview.status.entries.length }} onToggle={togglePaneOpen} />}</div></header>
      {opened && conversation.sandbox?.enforced === false && <div className="unsafe-banner" role="alert"><strong>Unsafe session</strong><span>Sandbox enforcement is disabled. Tools run with your host permissions.</span></div>}
      {usageOpen && <section ref={usagePanel} className="session-usage" aria-label="Session usage"><header><strong>Session usage</strong><button type="button" aria-label="Close session usage" onClick={() => setUsageOpen(false)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button></header><p>{conversation.provider && conversation.model ? `${conversation.provider} / ${conversation.model}` : conversation.model ?? "No model selected"}{conversation.thinking ? ` · ${conversation.thinking}` : ""}</p><dl><div><dt>Input</dt><dd>{compactNumber(conversation.usage.inputTokens)}</dd></div><div><dt>Output</dt><dd>{compactNumber(conversation.usage.outputTokens)}</dd></div><div><dt>Cache read</dt><dd>{compactNumber(conversation.usage.cacheReadTokens)}</dd></div><div><dt>Cache hit</dt><dd>{usageStats.cacheHitPercent.toFixed(1)}%</dd></div><div><dt>Reasoning</dt><dd>{compactNumber(conversation.usage.reasoningTokens)}</dd></div><div><dt>Throughput</dt><dd>{usageStats.tokensPerSecond === undefined ? "Unknown" : `${usageStats.tokensPerSecond.toFixed(1)} tok/s`}</dd></div><div><dt>Recorded cost</dt><dd>${conversation.usage.costUsd.toFixed(4)}</dd></div></dl>{usageStats.unknownCostResponses > 0 && <small>{usageStats.unknownCostResponses} response{usageStats.unknownCostResponses === 1 ? " has" : "s have"} no cost data.</small>}{stateHistory.length > 0 && <details className="state-history"><summary>Configuration history</summary><ol>{stateHistory.map((entry) => <li key={entry.id}><span><strong>{entry.label}</strong><small>{entry.detail}</small></span><time>{new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></li>)}</ol></details>}</section>}
      {transcriptSearchOpen && <div className="transcript-search" role="search"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" /><path d="m10.25 10.25 3 3" /></svg><input autoFocus type="search" aria-label="Search transcript" placeholder="Search transcript" value={transcriptQuery} onChange={(event) => setTranscriptQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); moveTranscriptMatch(event.shiftKey ? -1 : 1); } }} /><span>{transcriptQuery.trim() ? `${transcriptMatches.length === 0 ? 0 : Math.max(0, transcriptMatch + 1)} / ${transcriptMatches.length}` : ""}</span><button type="button" aria-label="Previous result" disabled={transcriptMatches.length === 0} onClick={() => moveTranscriptMatch(-1)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4" /></svg></button><button type="button" aria-label="Next result" disabled={transcriptMatches.length === 0} onClick={() => moveTranscriptMatch(1)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button><button type="button" aria-label="Close transcript search" onClick={() => { setTranscriptSearchOpen(false); setTranscriptQuery(""); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button></div>}
      <div className="thread" ref={transcript} onScroll={trackTranscriptScroll}>
        {opened ? <div className="thread-inner"><div className="thread-title"><h1>{currentTitle}</h1>{opened.profile !== "chat" && <p>{opened.cwd}</p>}</div><Suspense fallback={null}><Conversation conversation={conversation} searchQuery={transcriptQuery} resolveBlobUrl={(blob) => preview?.resolveBlobUrl?.(blob.sha256) ?? blobUrls.get(blob.sha256)} loadFullToolOutput={hasCapability("session.blob.read") && (preview?.readBlob !== undefined || client !== undefined) ? loadFullToolOutput : undefined} onRespondInteraction={hasCapability("session.interaction.respond") ? respondInteraction : undefined} onCopyMessage={(text) => void copyMessage(text)} onForkMessage={hasCapability("session.fork") ? (eventId) => void forkMessage(eventId) : undefined} /></Suspense>{conversation.activity && <article className="message assistant live"><span className="avatar axl">A</span><div><header><strong>Axl</strong><time>working</time></header>{conversation.activity.thinking && <details><summary>Thinking</summary><p>{conversation.activity.thinking}</p></details>}<p className="waiting-response">{conversation.activity.text || "Waiting for response"}<span className="waiting-dots" aria-hidden="true"><i></i><i></i><i></i></span></p></div></article>}</div> : <div className="empty"><span className="brand-mark large">A</span><h1>No session selected</h1><p>Resume a durable session or start one in this workspace.</p><button title={canCreate ? undefined : "Unavailable because session creation was not granted"} disabled={!canCreate} onClick={() => openNewSession()}>New session</button></div>}
      </div>
      {promptBreakpoints.length > 1 && <nav className={`prompt-breakpoints${transcriptNavigationVisible || transcriptSearchOpen ? " visible" : ""}`} aria-label="Conversation prompts" onMouseEnter={() => { if (transcriptNavigationTimer.current !== undefined) clearTimeout(transcriptNavigationTimer.current); setTranscriptNavigationVisible(true); }} onMouseLeave={() => setTranscriptNavigationVisible(false)}>{promptBreakpoints.map((point) => <button type="button" key={point.id} className={point.id === activePromptId ? "active" : ""} title={point.text} onClick={() => jumpToMessage(point.id)}><span>{point.text}</span></button>)}</nav>}
      {!connected && <div className="connection-banner" role="status" aria-live="polite"><span>{connection === "disconnected" ? "Connection to the daemon was lost." : connection === "incompatible" ? "The browser and daemon versions are incompatible." : "Connecting to the daemon…"}</span>{connection === "disconnected" && client !== undefined && <button onClick={() => void reconnect()}>Reconnect</button>}</div>}
      {adoptionNoticeVisible && !adoptionOpen && <div className="action-notice" role="status">Existing setups found. <button type="button" onClick={() => { setAdoptionOpen(true); adoptionController.current?.dismissFindings(); setAdoptionNoticeVisible(false); }}>Review with /adopt</button><button type="button" aria-label="Dismiss adoption findings" onClick={() => { adoptionController.current?.dismissFindings(); setAdoptionNoticeVisible(false); }}>Dismiss</button></div>}
      {actionNotice && !error && <div className="action-notice" role="status">{actionNotice}</div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(undefined)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button></div>}
      {directOperation && directOperation.source !== "terminal" && <div className="direct-operation" role="status" aria-live="polite"><progress aria-label={directOperation.kind === "compaction" ? "Compaction progress" : "Shell command progress"} /><span><strong>{directOperation.kind === "compaction" ? "Compacting context" : "Running shell command"}</strong><small>{directOperation.kind === "compaction" ? "Summarizing older context into a durable checkpoint." : "The sandboxed command result will appear in the transcript."}</small></span><button type="button" disabled={directOperation.cancelling} onClick={() => void cancelDirectOperation()}>{directOperation.cancelling ? "Cancelling…" : "Cancel"}</button></div>}
      {opened && <form className="composer" onSubmit={(event) => { event.preventDefault(); if (canDeliver) void send(); }}>{slashCommands.length > 0 && <div className="slash-commands" role="listbox" aria-label="Slash commands">{slashCommands.map((command) => <button key={command.id} type="button" role="option" aria-selected={command === slashCommands[slashCommandIndex]} disabled={command.availability.state === "unavailable"} onClick={() => selectCommand(command)}><strong>/{command.name}</strong><span>{command.availability.state === "unavailable" ? command.availability.reason : command.description}</span></button>)}</div>}<input ref={fileInput} className="attachment-input" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={(event) => { attachFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />{attachments.length > 0 && <div className="composer-attachments" aria-label="Prompt attachments">{attachments.map((attachment) => <div key={attachment.id} className={`composer-attachment ${attachment.status}`}><span className="attachment-glyph" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3" /></svg></span><span className="attachment-copy"><strong title={attachment.file.name}>{attachment.file.name}</strong><small>{attachment.status === "uploading" ? `Uploading ${Math.round(attachment.progress * 100)}%` : attachment.status === "failed" ? attachment.error : `${Math.ceil((attachment.reference?.sizeBytes ?? attachment.file.size) / 1024)} KB · Ready`}</small></span>{attachment.status === "failed" && <button type="button" onClick={() => void uploadAttachment(attachment)}>Retry</button>}<button type="button" aria-label={attachment.status === "uploading" ? `Cancel upload ${attachment.file.name}` : `Remove ${attachment.file.name}`} onClick={() => removeAttachment(attachment.id)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button></div>)}</div>}{orderedPendingInputs.length > 0 && <div className="pending-inputs" role="status" aria-label="Pending prompt delivery">{orderedPendingInputs.map((pending) => <div key={pending.id}><strong>{pending.mode === "steer" ? "Steering" : pending.mode === "follow_up" ? "Follow-up" : "Interrupting"}</strong><span>{pending.text}</span></div>)}</div>}<textarea ref={composer} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (slashCommands.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setSlashCommandIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + slashCommands.length) % slashCommands.length); } else if (slashCommands.length > 0 && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) { event.preventDefault(); selectCommand(slashCommands[slashCommandIndex] as EffectiveCommand); } else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(promptDeliveryShortcut(event)); } }} placeholder="Ask Axl…" aria-label="Message" aria-keyshortcuts="Enter Alt+Enter Control+Enter Meta+Enter Shift+Tab" aria-expanded={slashCommands.length > 0} rows={3} disabled={busy} /><div className="composer-footer"><button type="button" className="attach-button" aria-label="Attach files" title={canUpload ? "Attach files" : "Unavailable because attachment upload was not granted"} disabled={!canUpload || busy || !connected} onClick={() => fileInput.current?.click()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 8.5 4.2-4.2a2.1 2.1 0 0 1 3 3l-5.5 5.5a3.5 3.5 0 0 1-5-5l5.4-5.4" /></svg></button>{canShell && <button type="button" className="shell-button" aria-label="Run shell command" title="Run shell command (! includes output, !! excludes it)" disabled={busy || !connected} onClick={() => { setDraft((current) => current || "! "); queueMicrotask(() => composer.current?.focus()); }}>&gt;_</button>}<span className="delivery-hint" title="Ctrl/Cmd+Enter interrupts and delivers."><span><kbd>Enter</kbd>{deliveryActive ? "Steer" : "Send"}</span><span><kbd>Alt Enter</kbd>Follow up</span></span>{pendingDeliveries > 0 && <span className="delivery-status" role="status">Delivering {pendingDeliveries}</span>}{profileSupportsWebTools(conversation.profile ?? opened.profile) && <WebToolControls compact webSearch={conversation.webSearch} webFetch={conversation.webFetch} pending={webToolPending} errors={presentedWebToolErrors} disabled={!canConfigure || busy || conversation.activeOperationId !== undefined || !connected} {...(unavailableConfigurationError === undefined ? {} : { unavailableReason: unavailableConfigurationError })} onChange={(field, value) => { if (value !== undefined) void configureWebTool(field, value); }} />}<ModelPicker choices={modelCatalog} provider={conversation.provider} model={conversation.model} thinking={conversation.thinking} openRequest={modelPickerOpenRequest} initialFocus={modelPickerInitialFocus} disabled={!canConfigure || busy || configurationPending || (preview === undefined && conversation.activeOperationId !== undefined) || !connected} {...(unavailableConfigurationError === undefined ? {} : { unavailableReason: unavailableConfigurationError })} {...(presentedModelConfigurationError === undefined ? {} : { error: presentedModelConfigurationError })} onModel={(choice) => void configureModel(choice)} onThinking={(level) => void configureThinking(level)} />{conversation.activeOperationId && directOperation === undefined && <button type="button" className="composer-submit stop" aria-label="Stop response" onClick={() => void interrupt()} title={canInterrupt ? undefined : "Unavailable because session interruption was not granted"} disabled={!connected || !canInterrupt}><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.75" y="3.75" width="8.5" height="8.5" rx="1.25" /></svg></button>}<button className="composer-submit send" aria-label={deliveryActive ? "Deliver during active response" : "Send message"} title={canDeliver ? undefined : `Unavailable because ${deliveryActive ? "steering" : "prompt delivery"} was not granted`} disabled={!canDeliver || (!draft.trim() && readyAttachmentCount === 0) || attachmentUploading || busy || !connected}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14 2 8.5 14 6.4 9.6 2 7.5 14 2Z M6.4 9.6 10 6" /></svg></button></div></form>}
    </section>
    <div id="pane-dock" ref={mobileDockPanel} className={`dock-column${dockOpen ? " open" : ""}`} aria-hidden={!dockOpen} aria-label={mobileDock ? "Open panes" : undefined} role={mobileDock ? "dialog" : undefined} aria-modal={mobileDock || undefined} inert={sidebarOpen} onKeyDown={(event) => { if (mobileDock) trapDialogFocus(event, mobileDockPanel.current); }}>
      <button ref={mobileDockClose} type="button" className="mobile-dock-close" onClick={() => setMobileDock(false)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 3-5 5 5 5" /></svg>Conversation</button>
      {dockOpen && <div className="panel-resizer right" role="separator" aria-orientation="vertical" aria-label="Resize pane dock" aria-valuemin={DOCK_WIDTH_RANGE.min} aria-valuemax={DOCK_WIDTH_RANGE.max} aria-valuenow={dockWidth} aria-valuetext={`${dockWidth} pixels wide`} aria-keyshortcuts="ArrowLeft ArrowRight" tabIndex={0} onPointerDown={(event) => resizePanel("right", event)} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resizePanelBy("right", event.key === "ArrowLeft" ? 16 : -16); } }} />}
      <Dock
        layout={paneLayout}
        onLayout={applyPaneLayout}
        renderControls={(pane) => pane === "files"
          ? <button type="button" className="icon-button" aria-label="Refresh files" onClick={refreshWorkspaceFiles}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 6a5 5 0 1 0 .2 3M13 2.5V6H9.5" /></svg></button>
          : pane === "changes"
            ? <button type="button" className="icon-button" aria-label="Refresh changes" onClick={refreshWorkspaceChanges}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 6a5 5 0 1 0 .2 3M13 2.5V6H9.5" /></svg></button>
            : undefined}
        renderPane={(pane) => {
          switch (pane) {
            case "browser":
              return <BrowserPane state={browserPane} onState={setBrowserPane} />;
            case "files":
              return opened
                ? <WorkspaceExplorer browser={workspaceBrowser} loading={browserLoading} error={browserError} onOpenDirectory={(path) => void loadWorkspaceDirectory(path)} onOpenFile={(path) => void loadWorkspaceFile(path)} onLoadMoreEntries={() => void loadWorkspaceDirectory(workspaceBrowser.path, true)} onLoadMoreFile={() => { if (workspaceBrowser.file) void loadWorkspaceFile(workspaceBrowser.file.path, true); }} onRetry={refreshWorkspaceFiles} onMentionPath={mentionPath} filesSplit={filesSplit} onFilesSplit={setFilesSplit} />
                : <div className="pane-empty"><strong>No session</strong><span>Open a session to browse its workspace.</span></div>;
            case "changes":
              return opened
                ? <WorkspaceChanges review={workspaceReview} loading={reviewLoading} error={reviewError} view={changesView} scope={workspaceScope} canCheckpoint={canCheckpointWorkspace} checkpointEnabled={workspaceCheckpointEnabled} checkpointDisabled={busy || conversation.activeOperationId !== undefined} onScope={(scope) => void loadWorkspaceChanges(scope)} onCheckpoint={(enabled) => void configureWorkspaceCheckpoint(enabled)} onViewChange={(view) => { setChangesView(view); persistLayout({ ...currentPreferences(), changesView: view }); }} onRetry={refreshWorkspaceChanges} onMentionPath={mentionPath} onOpenInFiles={openInFiles} changesSplit={changesSplit} onChangesSplit={setChangesSplit} />
                : <div className="pane-empty"><strong>No session</strong><span>Open a session to review its changes.</span></div>;
            case "terminal":
              return <TerminalPane entries={terminalRecords} running={directOperation?.kind === "shell" && directOperation.source === "terminal" && directOperation.command !== undefined ? { command: directOperation.command, cancelling: directOperation.cancelling } : undefined} error={terminalError} disabled={!canShell || !connected || opened === undefined} cwd={opened?.cwd ?? bootstrap?.cwd ?? ""} onRun={(command, excluded) => void runTerminalCommand(command, excluded)} onCancel={() => void cancelDirectOperation()} />;
            default:
              return null;
          }
        }}
      />
    </div>
    {adoptionOpen && <AdoptionDialog
      state={adoptionState}
      onRefresh={() => {
        const adoption = adoptionController.current;
        if (adoption === undefined) return;
        const projectRoot = opened?.cwd;
        void adoption.loadAll({
          ...(projectRoot === undefined ? { scopes: ["global"] as const } : { projectRoot, scopes: ["global", "project"] as const }),
          includeMalformed: true,
        }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Adoption scan failed"));
      }}
      onInspect={(candidate: AdoptionCandidate) => {
        void adoptionController.current?.inspect(candidate).catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : "Adoption inspection failed"),
        );
      }}
      onDismissFindings={() => {
        adoptionController.current?.dismissFindings();
        setAdoptionNoticeVisible(false);
      }}
      onClose={() => setAdoptionOpen(false)}
    />}
    {controlCenter && <Suspense fallback={null}><ControlCenter tab={controlCenter} preferences={currentPreferences()} theme={theme} providers={providerInventory} providerLoading={providerLoading} providerRefresh={providerDirectory.refresh} providerError={providerError} providerLogin={providerLogin} settingsError={settingsError} canRefresh={hasCapability("provider.catalog.refresh")} canLogin={canLoginProvider} canLogout={hasCapability("provider.auth.logout")} onTab={setControlCenter} onPreferences={applyWebPreferences} onTheme={(nextTheme) => { setSettingsError(undefined); setTheme(nextTheme); }} onRefresh={(providerId) => void refreshProviders(providerId)} onCancelRefresh={() => providerDirectoryController.current?.cancelRefresh()} onLogin={(providerId, method) => void startProviderLogin(providerId, method)} onCancelLogin={cancelProviderLogin} onLogout={(providerId) => void logoutProvider(providerId)} onCopyLogin={(providerId, method) => void copyProviderLogin(providerId, method)} onClose={() => { setControlCenter(undefined); setSettingsError(undefined); }} /></Suspense>}
    {sessionLifecycleOpen && selectedSummary && <SessionLifecycle session={selectedSummary} busy={busy} capabilities={lifecycleCapabilities} {...(sessionLifecycleError === undefined ? {} : { error: sessionLifecycleError })} onRename={(title) => void renameSession(title)} onClone={() => void cloneSession()} onExport={() => void exportArtifact()} onDispose={() => void disposeSession()} onDelete={() => void deleteSession()} onClose={() => { setSessionLifecycleOpen(false); setSessionLifecycleError(undefined); }} />}
    {requeueOpen && <RequeueDialog items={pausedQueue} busyItemId={requeueBusyItemId} error={requeueError} onRequeue={(queueItemId) => void requeueItem(queueItemId)} onClose={() => { setRequeueOpen(false); setRequeueError(undefined); }} />}
    {newSessionOpen && <NewSessionDialog
      draft={newSessionDraft}
      models={modelCatalog}
      modelPickerOpenRequest={newSessionModelPickerOpenRequest}
      busy={busy}
      projectFolders={projectFolders}
      {...(newSessionError === undefined ? {} : { error: newSessionError })}
      {...(canCreate ? {} : { unavailableReason: "Session creation was not granted" })}
      {...(projectFolderValidator === undefined ? {} : { onValidateProjectFolder: projectFolderValidator })}
      onChange={updateNewSession}
      onSubmit={() => void createSession()}
      onClose={() => {
        setNewSessionOpen(false);
        setNewSessionError(undefined);
      }}
    />}
  </main>;
}
