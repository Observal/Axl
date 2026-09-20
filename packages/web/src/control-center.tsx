// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, type JSX } from "react";
import type {
  McpConfigListResult,
  McpServerDefinition,
  ProviderInventoryGroup,
  ProviderLoginMethod,
} from "@axl/sdk";
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
  mcpPresets,
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
  onMcpRemove,
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
  readonly mcpPresets: Readonly<Record<string, McpServerDefinition>>;
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
  readonly onMcpAdd: (name: string, definition: McpServerDefinition) => void;
  readonly onMcpRemove: (name: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const dialog = useRef<HTMLElement>(null);
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
        <div className="providers-heading"><span><strong>MCP servers</strong><small>{mcp?.path ?? "Global MCP configuration"}</small></span></div>
        {mcpError && <p className="provider-error" role="alert">{mcpError}</p>}
        {mcp?.servers.length === 0 && <p className="provider-empty">No MCP servers are configured.</p>}
        <div className="provider-list">{mcp?.servers.map((server) => <article className="provider-row" key={server.name}><div className="provider-mark" aria-hidden="true">M</div><div><header><strong>{server.name}</strong><span className="provider-state authenticated">active</span></header><p>{"url" in server.definition ? server.definition.url : `${server.definition.command} ${(server.definition.args ?? []).join(" ")}`}</p></div><div className="provider-actions"><button disabled={mcpBusy} onClick={() => onMcpRemove(server.name)}>Remove</button></div></article>)}</div>
        <div className="providers-heading"><span><strong>Add a tested server</strong><small>Saved globally and available after reload</small></span></div>
        <div className="provider-list">{Object.entries(mcpPresets).filter(([name]) => !mcp?.servers.some((server) => server.name === name)).map(([name, definition]) => <article className="provider-row" key={name}><div className="provider-mark" aria-hidden="true">+</div><div><header><strong>{name}</strong></header><p>{"url" in definition ? definition.url : definition.command}</p></div><div className="provider-actions"><button disabled={mcpBusy} onClick={() => onMcpAdd(name, definition)}>Add</button></div></article>)}</div>
      </div>}
    </section>
  </div>;
}
