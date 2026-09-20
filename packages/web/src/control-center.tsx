// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState, type JSX } from "react";
import {
  describeMcpServerDefinition,
  formatMcpServerSummary,
  MCP_ADD_SERVER_QUESTIONS,
  MCP_IMPORT_QUESTION,
  MCP_STATUS_LABELS,
  type McpConfigListResult,
  type McpServerDefinition,
  type McpServerEntry,
  mcpServerDefinitionFromDraft,
  mcpRequiredEnvironment,
  mcpServerDraftFromAnswers,
  parseMcpImport,
  type ProviderInventoryGroup,
  type ProviderLoginMethod,
  summarizeMcpServers,
} from "@axl/sdk";
import { QuestionnaireForm } from "@axl/ui/react";
import type { WebTheme } from "./commands.ts";
import { trapDialogFocus } from "./dialog-focus.ts";
import { DOCK_WIDTH_RANGE, SIDEBAR_WIDTH_RANGE, type WebPreferences } from "./environment.ts";
import { PANE_IDS, PANE_LABELS } from "./panes.ts";

export type ControlCenterTab = "settings" | "providers" | "mcp";

function authLabel(provider: ProviderInventoryGroup): string {
  if (!provider.enabled) return "disabled";
  if (provider.authMethods.includes("keyless")) return "no sign-in required";
  if (provider.authentication.phase === "authenticated") return "connected";
  if (provider.authentication.phase === "reauthentication_required") return "needs attention";
  return "not connected";
}

function loginLabel(method: ProviderLoginMethod, reconnect: boolean, copy: boolean): string {
  const label = method === "api_key" ? "API key" : "OAuth";
  if (copy) return `Copy ${label} command`;
  return reconnect ? `Reconnect with ${label}` : `Connect with ${label}`;
}

export function ControlCenter({
  tab,
  preferences,
  theme,
  providers,
  providerLoading,
  providerRefresh,
  providerError,
  providerLogin,
  settingsError,
  mcp,
  mcpError,
  mcpBusy,
  mcpActiveIdentities,
  canRefresh,
  canLogin,
  canLogout,
  onTab,
  onPreferences,
  onTheme,
  onRefresh,
  onCancelRefresh,
  onLogin,
  onCancelLogin,
  onLogout,
  onCopyLogin,
  onMcpAdd,
  onMcpImport,
  onMcpRemove,
  onMcpSetEnabled,
  onMcpReload,
  onClose,
}: {
  readonly tab: ControlCenterTab;
  readonly preferences: WebPreferences;
  readonly theme: WebTheme;
  readonly providers: readonly ProviderInventoryGroup[];
  readonly providerLoading: boolean;
  readonly providerRefresh?: { readonly providerId?: string } | undefined;
  readonly providerError?: string | undefined;
  readonly providerLogin?: {
    readonly providerId: string;
    readonly method: ProviderLoginMethod;
  } | undefined;
  readonly settingsError?: string | undefined;
  readonly mcp?: McpConfigListResult | undefined;
  readonly mcpError?: string | undefined;
  readonly mcpBusy: boolean;
  /** Capability identities activated in this session, e.g. `mcp:server/tool`. */
  readonly mcpActiveIdentities: ReadonlySet<string>;
  readonly canRefresh: boolean;
  readonly canLogin: boolean;
  readonly canLogout: boolean;
  readonly onTab: (tab: ControlCenterTab) => void;
  readonly onPreferences: (preferences: WebPreferences) => void;
  readonly onTheme: (theme: WebTheme) => void;
  readonly onRefresh: (providerId?: string) => void;
  readonly onCancelRefresh: () => void;
  readonly onLogin: (providerId: string, method: ProviderLoginMethod) => void;
  readonly onCancelLogin: () => void;
  readonly onLogout: (providerId: string) => void;
  readonly onCopyLogin: (providerId: string, method: ProviderLoginMethod) => void;
  /** Probes the definition, saves it only on success, and reloads. Rejects with a user-facing message. */
  readonly onMcpAdd: (name: string, definition: McpServerDefinition) => Promise<void>;
  /** Probes every pasted server, saves them only if all answer, and reloads. */
  readonly onMcpImport: (servers: readonly { readonly name: string; readonly definition: McpServerDefinition }[]) => Promise<void>;
  readonly onMcpRemove: (name: string) => void;
  readonly onMcpSetEnabled: (name: string, enabled: boolean) => void;
  readonly onMcpReload: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const dialog = useRef<HTMLElement>(null);
  const [mcpAdding, setMcpAdding] = useState<"guided" | "import">();
  const [mcpExpanded, setMcpExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [mcpRemoving, setMcpRemoving] = useState<string>();
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.querySelector<HTMLElement>("button, input")?.focus();
    return () => prior?.focus();
  }, []);

  const trapFocus = (event: React.KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    trapDialogFocus(event, dialog.current);
  };

  return <div className="control-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="control-center" ref={dialog} role="dialog" aria-modal="true" aria-label="Web controls" onKeyDown={trapFocus}>
      <header><nav aria-label="Web controls"><button className={tab === "settings" ? "active" : ""} onClick={() => onTab("settings")}>Settings</button><button className={tab === "providers" ? "active" : ""} onClick={() => onTab("providers")}>Providers</button><button className={tab === "mcp" ? "active" : ""} onClick={() => onTab("mcp")}>MCP</button></nav><button className="control-close" aria-label="Close" onClick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button></header>
      {tab === "settings" ? <div className="settings-pane">
        <div className="setting-row"><span><strong>Session rail</strong><small>Keep the session list visible on desktop</small></span><button className={preferences.sidebarCollapsed ? "setting-switch" : "setting-switch active"} role="switch" aria-checked={!preferences.sidebarCollapsed} onClick={() => onPreferences({ ...preferences, sidebarCollapsed: !preferences.sidebarCollapsed })}><i /></button></div>
        <div className="setting-row"><span><strong>Default changes view</strong><small>Choose how workspace changes open</small></span><div className="setting-segments"><button className={preferences.changesView === "files" ? "active" : ""} onClick={() => onPreferences({ ...preferences, changesView: "files" })}>Files</button><button className={preferences.changesView === "all" ? "active" : ""} onClick={() => onPreferences({ ...preferences, changesView: "all" })}>All</button></div></div>
        <label className="setting-range"><span><strong>Session rail width</strong><small>{preferences.sidebarWidth}px</small></span><input type="range" min={SIDEBAR_WIDTH_RANGE.min} max={SIDEBAR_WIDTH_RANGE.max} step="8" value={preferences.sidebarWidth} onChange={(event) => onPreferences({ ...preferences, sidebarWidth: Number(event.target.value) })} /></label>
        <label className="setting-range"><span><strong>Pane dock width</strong><small>{preferences.dockWidth}px</small></span><input type="range" min={DOCK_WIDTH_RANGE.min} max={DOCK_WIDTH_RANGE.max} step="8" value={preferences.dockWidth} onChange={(event) => onPreferences({ ...preferences, dockWidth: Number(event.target.value) })} /></label>
        <div className="setting-row"><span><strong>Panes</strong><small>Tiles open in the dock beside the conversation</small></span><div className="setting-segments">{PANE_IDS.map((pane) => { const open = preferences.panes.includes(pane); return <button key={pane} className={open ? "active" : ""} aria-pressed={open} onClick={() => onPreferences({ ...preferences, panes: open ? preferences.panes.filter((id) => id !== pane) : PANE_IDS.filter((id) => id === pane || preferences.panes.includes(id)) })}>{PANE_LABELS[pane]}</button>; })}</div></div>
        <div className="setting-row"><span><strong>Appearance</strong><small>Follow your device or choose a fixed theme</small></span><div className="setting-segments" aria-label="Appearance"><button className={theme === "system" ? "active" : ""} aria-pressed={theme === "system"} onClick={() => onTheme("system")}>System</button><button className={theme === "light" ? "active" : ""} aria-pressed={theme === "light"} onClick={() => onTheme("light")}>Light</button><button className={theme === "dark" ? "active" : ""} aria-pressed={theme === "dark"} onClick={() => onTheme("dark")}>Dark</button></div></div>
        {settingsError && <p className="provider-error" role="alert">{settingsError}</p>}
        <section className="shortcut-list" aria-labelledby="keyboard-shortcuts"><strong id="keyboard-shortcuts">Keyboard shortcuts</strong><dl><div><dt><kbd>Ctrl/⌘ K</kbd></dt><dd>Commands</dd></div><div><dt><kbd>Ctrl/⌘ L</kbd></dt><dd>Models</dd></div><div><dt><kbd>Shift Tab</kbd></dt><dd>Cycle effort in composer</dd></div><div><dt><kbd>Ctrl/⌘ F</kbd></dt><dd>Search transcript</dd></div><div><dt><kbd>Alt ↑</kbd></dt><dd>Restore queued prompts</dd></div><div><dt><kbd>Esc</kbd></dt><dd>Close overlay, then restore and interrupt</dd></div></dl></section>
      </div> : tab === "providers" ? <div className="providers-pane">
        <div className="providers-heading"><span><strong>Model providers</strong><small>Authentication and catalog state from the daemon</small></span>{providerRefresh?.providerId === undefined && providerRefresh !== undefined ? <button onClick={onCancelRefresh}>Cancel refresh</button> : <button title={canRefresh ? undefined : "Unavailable because provider catalog refresh was not granted"} onClick={() => onRefresh()} disabled={!canRefresh || providerLoading || providerRefresh !== undefined}>Refresh all</button>}</div>
        {providerError && <p className="provider-error" role="alert">{providerError}</p>}
        {providerLogin && <div className="provider-login" role="status" aria-live="polite"><span><strong>Complete {providerLogin.method === "api_key" ? "API key" : "OAuth"} sign-in in the terminal</strong><small>The trusted Axl host is waiting for your response. Credentials never enter this page.</small></span><button onClick={onCancelLogin}>Cancel</button></div>}
        {providers.length === 0 && !providerLoading && <p className="provider-empty">No provider inventory is available.</p>}
        <div className="provider-list">{providers.map((provider) => {
          const reconnect = provider.authentication.phase === "reauthentication_required";
          const refreshing = providerRefresh?.providerId === provider.providerId;
          const controlsDisabled = providerLoading || providerRefresh !== undefined || providerLogin !== undefined;
          return <article className="provider-row" key={provider.providerId}><div className="provider-mark" aria-hidden="true">{provider.displayName.slice(0, 1).toLocaleUpperCase()}</div><div><header><strong>{provider.displayName}</strong><span className={`provider-state ${provider.authentication.phase}`}>{authLabel(provider)}</span></header><p>{provider.models.length} model{provider.models.length === 1 ? "" : "s"} · {provider.catalog.refreshable ? "dynamic catalog" : "static catalog"}{provider.region ? ` · ${provider.region}` : provider.regionFamily ? ` · ${provider.regionFamily}` : ""}{provider.authentication.source ? ` · ${provider.authentication.source}` : ""}</p>{provider.catalogError && <small className="provider-error">{provider.catalogError.message}</small>}</div><div className="provider-actions">{provider.catalog.refreshable && (refreshing ? <button onClick={onCancelRefresh}>Cancel</button> : <button title={canRefresh ? undefined : "Unavailable because provider catalog refresh was not granted"} onClick={() => onRefresh(provider.providerId)} disabled={!canRefresh || controlsDisabled}>Refresh</button>)}{provider.authentication.phase === "authenticated" ? <button title={canLogout ? undefined : "Unavailable because provider logout was not granted"} onClick={() => onLogout(provider.providerId)} disabled={!canLogout || controlsDisabled}>Log out</button> : provider.loginMethods.map((method) => <button key={method} onClick={() => canLogin ? onLogin(provider.providerId, method) : onCopyLogin(provider.providerId, method)} disabled={controlsDisabled}>{loginLabel(method, reconnect, !canLogin)}</button>)}</div></article>;
        })}</div>
        <p className="provider-footnote">Sign-in prompts and credentials stay in the trusted terminal host. This page receives only provider status.</p>
      </div> : <div className="providers-pane">
        <div className="providers-heading"><span><strong>MCP servers</strong><small>{mcp?.path ?? "Global MCP configuration"}{mcp && mcp.servers.length > 0 ? ` · ${formatMcpServerSummary(summarizeMcpServers(mcp.servers))}` : ""}</small></span><span className="provider-actions"><button disabled={mcpBusy || mcp === undefined} onClick={onMcpReload}>Reload</button><button disabled={mcpBusy || mcpAdding !== undefined} onClick={() => setMcpAdding("import")}>Paste config</button><button className="primary" disabled={mcpBusy || mcpAdding !== undefined} onClick={() => setMcpAdding("guided")}>Add server</button></span></div>
        {mcpError && <p className="provider-error" role="alert">{mcpError}</p>}
        {mcp?.servers.length === 0 && mcpAdding === undefined && <p className="provider-empty">No MCP servers are configured. Paste the config block from any MCP server's README, or use the guided add flow.</p>}
        <div className="provider-list">{mcp?.servers.map((server) => <McpServerRow key={server.name} server={server} busy={mcpBusy} expanded={mcpExpanded.has(server.name)} confirming={mcpRemoving === server.name} activeIdentities={mcpActiveIdentities} onToggle={() => setMcpExpanded((current) => { const next = new Set(current); if (next.has(server.name)) next.delete(server.name); else next.add(server.name); return next; })} onRemove={() => { if (mcpRemoving === server.name) { setMcpRemoving(undefined); onMcpRemove(server.name); } else setMcpRemoving(server.name); }} onKeep={() => setMcpRemoving(undefined)} onSetEnabled={(enabled) => onMcpSetEnabled(server.name, enabled)} />)}</div>
        {mcpAdding === "import" && <div className="mcp-add"><QuestionnaireForm
          title="Import MCP servers"
          questions={[MCP_IMPORT_QUESTION]}
          submitLabel="Connect and save"
          pendingLabel="Connecting to each server…"
          review={(answers) => {
            try {
              const servers = parseMcpImport(answers[0]?.customAnswer ?? "");
              const required = mcpRequiredEnvironment(servers);
              return <><span>Will be written to {mcp?.path ?? "~/.axl/mcp.json"} as:</span><pre>{JSON.stringify(Object.fromEntries(servers.map((server) => [server.name, server.definition])), null, 2)}</pre>{required.length > 0 && <span>Reads from the daemon's environment: <code>{required.join(", ")}</code>. Export them before starting the daemon.</span>}<span>Axl connects to each server first and saves only if all of them answer. A server that asks for OAuth is saved and authorized in your browser when the session reloads.</span></>;
            } catch (cause) {
              return <span className="provider-error" role="alert">{cause instanceof Error ? cause.message : "Invalid input"}</span>;
            }
          }}
          onSubmit={async (answers) => {
            await onMcpImport(parseMcpImport(answers[0]?.customAnswer ?? ""));
            setMcpAdding(undefined);
          }}
          onCancel={() => setMcpAdding(undefined)}
        /></div>}
        {mcpAdding === "guided" && <div className="mcp-add"><QuestionnaireForm
          title="Add MCP server"
          questions={MCP_ADD_SERVER_QUESTIONS}
          submitLabel="Connect and save"
          pendingLabel="Connecting to the server…"
          review={(answers) => {
            try {
              const { name, definition } = mcpServerDefinitionFromDraft(mcpServerDraftFromAnswers(answers));
              const required = mcpRequiredEnvironment([{ definition }]);
              return <><span>Will be written to {mcp?.path ?? "~/.axl/mcp.json"} as:</span><pre>{JSON.stringify({ [name]: definition }, null, 2)}</pre>{required.length > 0 && <span>Reads from the daemon's environment: <code>{required.join(", ")}</code>. Export them before starting the daemon.</span>}<span>Axl connects first and saves only if the server answers. A server that asks for OAuth is saved and authorized in your browser when the session reloads.</span></>;
            } catch (cause) {
              return <span className="provider-error" role="alert">{cause instanceof Error ? cause.message : "Incomplete answers"}</span>;
            }
          }}
          onSubmit={async (answers) => {
            const { name, definition } = mcpServerDefinitionFromDraft(mcpServerDraftFromAnswers(answers));
            await onMcpAdd(name, definition);
            setMcpAdding(undefined);
          }}
          onCancel={() => setMcpAdding(undefined)}
        /></div>}
        <p className="provider-footnote">Servers are saved to the daemon's global configuration and connect only when their tools are activated. Header and environment values name variables in the daemon's environment; Axl never stores the secrets themselves.</p>
      </div>}
    </section>
  </div>;
}

function McpServerRow({ server, busy, expanded, confirming, activeIdentities, onToggle, onRemove, onKeep, onSetEnabled }: {
  readonly server: McpServerEntry;
  readonly busy: boolean;
  readonly expanded: boolean;
  readonly confirming: boolean;
  readonly activeIdentities: ReadonlySet<string>;
  readonly onToggle: () => void;
  readonly onRemove: () => void;
  readonly onKeep: () => void;
  readonly onSetEnabled: (enabled: boolean) => void;
}): JSX.Element {
  const toolCount = server.tools.length;
  return <article className="provider-row" aria-label={`MCP server ${server.name}`}>
    <div className="provider-mark" aria-hidden="true">{"url" in server.definition ? "⇅" : ">_"}</div>
    <div>
      <header><strong>{server.name}</strong><span className={`provider-state ${server.status}`}>{MCP_STATUS_LABELS[server.status]}</span></header>
      <p>{describeMcpServerDefinition(server.definition)}{server.status === "discovered" ? ` · ${toolCount} tool${toolCount === 1 ? "" : "s"}` : ""}</p>
      {server.error && <small className="provider-error" role="alert">{server.error}</small>}
      {expanded && toolCount > 0 && <ul className="mcp-tools" aria-label={`${server.name} tools`}>{server.tools.map((tool) => {
        const active = activeIdentities.has(`mcp:${server.name}/${tool.name}`);
        return <li key={tool.name} className={active ? "active" : undefined} title={active ? "Activated in this session" : "Available through capability search"}><span aria-hidden="true">{active ? "●" : "○"}</span><span><strong>{tool.name}</strong>{tool.description}</span></li>;
      })}</ul>}
    </div>
    <div className="provider-actions">
      {confirming
        ? <><span className="provider-state failed">Remove {server.name}?</span><button disabled={busy} onClick={onRemove}>Remove</button><button disabled={busy} onClick={onKeep}>Keep</button></>
        : <>
          {toolCount > 0 && <button disabled={busy} aria-expanded={expanded} onClick={onToggle}>{expanded ? "Hide tools" : "Tools"}</button>}
          <button disabled={busy} onClick={() => onSetEnabled(server.status === "disabled")}>{server.status === "disabled" ? "Enable" : "Disable"}</button>
          <button disabled={busy} onClick={onRemove}>Remove</button>
        </>}
    </div>
  </article>;
}
