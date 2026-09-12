// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, type JSX } from "react";
import type { ProviderInventoryGroup, ProviderLoginMethod } from "@axl/sdk";
import type { WebPreferences } from "./environment.ts";

export type ControlCenterTab = "settings" | "providers";

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
  providers,
  providerLoading,
  providerError,
  providerLogin,
  canRefresh,
  canLogin,
  canLogout,
  onTab,
  onPreferences,
  onRefresh,
  onLogin,
  onCancelLogin,
  onLogout,
  onCopyLogin,
  onClose,
}: {
  readonly tab: ControlCenterTab;
  readonly preferences: WebPreferences;
  readonly providers: readonly ProviderInventoryGroup[];
  readonly providerLoading: boolean;
  readonly providerError?: string | undefined;
  readonly providerLogin?: {
    readonly providerId: string;
    readonly method: ProviderLoginMethod;
  } | undefined;
  readonly canRefresh: boolean;
  readonly canLogin: boolean;
  readonly canLogout: boolean;
  readonly onTab: (tab: ControlCenterTab) => void;
  readonly onPreferences: (preferences: WebPreferences) => void;
  readonly onRefresh: (providerId?: string) => void;
  readonly onLogin: (providerId: string, method: ProviderLoginMethod) => void;
  readonly onCancelLogin: () => void;
  readonly onLogout: (providerId: string) => void;
  readonly onCopyLogin: (providerId: string, method: ProviderLoginMethod) => void;
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
    if (event.key !== "Tab" || dialog.current === null) return;
    const controls = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
    const first = controls[0];
    const last = controls.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return <div className="control-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="control-center" ref={dialog} role="dialog" aria-modal="true" aria-label="Web controls" onKeyDown={trapFocus}>
      <header><nav aria-label="Web controls"><button className={tab === "settings" ? "active" : ""} onClick={() => onTab("settings")}>Settings</button><button className={tab === "providers" ? "active" : ""} onClick={() => onTab("providers")}>Providers</button></nav><button className="control-close" aria-label="Close" onClick={onClose}>×</button></header>
      {tab === "settings" ? <div className="settings-pane">
        <div className="setting-row"><span><strong>Session rail</strong><small>Keep the session list visible on desktop</small></span><button className={preferences.sidebarCollapsed ? "setting-switch" : "setting-switch active"} role="switch" aria-checked={!preferences.sidebarCollapsed} onClick={() => onPreferences({ ...preferences, sidebarCollapsed: !preferences.sidebarCollapsed })}><i /></button></div>
        <div className="setting-row"><span><strong>Default changes view</strong><small>Choose how workspace changes open</small></span><div className="setting-segments"><button className={preferences.changesView === "files" ? "active" : ""} onClick={() => onPreferences({ ...preferences, changesView: "files" })}>Files</button><button className={preferences.changesView === "all" ? "active" : ""} onClick={() => onPreferences({ ...preferences, changesView: "all" })}>All</button></div></div>
        <label className="setting-range"><span><strong>Session rail width</strong><small>{preferences.sidebarWidth}px</small></span><input type="range" min="200" max="420" step="8" value={preferences.sidebarWidth} onChange={(event) => onPreferences({ ...preferences, sidebarWidth: Number(event.target.value) })} /></label>
        <label className="setting-range"><span><strong>Changes panel width</strong><small>{preferences.changesWidth}px</small></span><input type="range" min="420" max="900" step="8" value={preferences.changesWidth} onChange={(event) => onPreferences({ ...preferences, changesWidth: Number(event.target.value) })} /></label>
        <div className="setting-row static"><span><strong>Appearance</strong><small>Dark theme · motion follows your system preference</small></span></div>
      </div> : <div className="providers-pane">
        <div className="providers-heading"><span><strong>Model providers</strong><small>Authentication and catalog state from the daemon</small></span><button onClick={() => onRefresh()} disabled={!canRefresh || providerLoading}>{providerLoading ? "Refreshing…" : "Refresh all"}</button></div>
        {providerError && <p className="provider-error" role="alert">{providerError}</p>}
        {providerLogin && <div className="provider-login" role="status" aria-live="polite"><span><strong>Complete {providerLogin.method === "api_key" ? "API key" : "OAuth"} sign-in in the terminal</strong><small>The trusted Axl host is waiting for your response. Credentials never enter this page.</small></span><button onClick={onCancelLogin}>Cancel</button></div>}
        {providers.length === 0 && !providerLoading && <p className="provider-empty">No provider inventory is available.</p>}
        <div className="provider-list">{providers.map((provider) => {
          const reconnect = provider.authentication.phase === "reauthentication_required";
          const controlsDisabled = providerLoading || providerLogin !== undefined;
          return <article className="provider-row" key={provider.providerId}><div className="provider-mark" aria-hidden="true">{provider.displayName.slice(0, 1).toLocaleUpperCase()}</div><div><header><strong>{provider.displayName}</strong><span className={`provider-state ${provider.authentication.phase}`}>{authLabel(provider)}</span></header><p>{provider.models.length} model{provider.models.length === 1 ? "" : "s"} · {provider.catalog.refreshable ? "dynamic catalog" : "static catalog"}{provider.region ? ` · ${provider.region}` : provider.regionFamily ? ` · ${provider.regionFamily}` : ""}{provider.authentication.source ? ` · ${provider.authentication.source}` : ""}</p>{provider.catalogError && <small className="provider-error">{provider.catalogError.message}</small>}</div><div className="provider-actions">{provider.catalog.refreshable && <button onClick={() => onRefresh(provider.providerId)} disabled={!canRefresh || controlsDisabled}>Refresh</button>}{provider.authentication.phase === "authenticated" ? <button onClick={() => onLogout(provider.providerId)} disabled={!canLogout || controlsDisabled}>Log out</button> : provider.loginMethods.map((method) => <button key={method} onClick={() => canLogin ? onLogin(provider.providerId, method) : onCopyLogin(provider.providerId, method)} disabled={controlsDisabled}>{loginLabel(method, reconnect, !canLogin)}</button>)}</div></article>;
        })}</div>
        <p className="provider-footnote">Sign-in prompts and credentials stay in the trusted terminal host. This page receives only provider status.</p>
      </div>}
    </section>
  </div>;
}
