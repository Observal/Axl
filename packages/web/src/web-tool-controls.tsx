// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useRef, type JSX } from "react";
import {
  parseStagedWebToolValue,
  stagedWebToolValue,
  type StagedWebToolValue,
  type WebToolField,
} from "./web-tools.ts";

function ToolRow({
  field,
  label,
  description,
  value,
  staged,
  pending,
  error,
  disabled,
  unavailableReason,
  onChange,
}: {
  readonly field: WebToolField;
  readonly label: string;
  readonly description: string;
  readonly value: boolean | undefined;
  readonly staged: boolean;
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly unavailableReason: string | undefined;
  readonly onChange: (field: WebToolField, value: boolean | undefined) => void;
}): JSX.Element {
  return (
    <div className="web-tool-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
        {error && <em role="alert">{error}</em>}
      </span>
      {staged ? (
        <select
          aria-label={`${label} configuration`}
          value={stagedWebToolValue(value)}
          disabled={disabled}
          title={unavailableReason}
          onChange={(event) =>
            onChange(field, parseStagedWebToolValue(event.target.value as StagedWebToolValue))
          }
        >
          <option value="default">Daemon default</option>
          <option value="on">Enabled</option>
          <option value="off">Disabled</option>
        </select>
      ) : (
        <button
          type="button"
          role="switch"
          aria-checked={value ?? false}
          aria-label={`${label} ${value === undefined ? "loading" : value ? "enabled" : "disabled"}`}
          disabled={disabled || value === undefined}
          title={unavailableReason}
          onClick={() => onChange(field, !value)}
        >
          <i aria-hidden="true" />
          <span>{pending ? "Rebuilding…" : value ? "Enabled" : "Disabled"}</span>
        </button>
      )}
    </div>
  );
}

export function WebToolControls({
  webSearch,
  webFetch,
  staged = false,
  pending = [],
  errors = {},
  disabled,
  unavailableReason,
  compact = false,
  onChange,
}: {
  readonly webSearch: boolean | undefined;
  readonly webFetch: boolean | undefined;
  readonly staged?: boolean;
  readonly pending?: readonly WebToolField[];
  readonly errors?: Readonly<Partial<Record<WebToolField, string>>>;
  readonly disabled: boolean;
  readonly unavailableReason?: string;
  readonly compact?: boolean;
  readonly onChange: (field: WebToolField, value: boolean | undefined) => void;
}): JSX.Element {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const rows = (
    <div className="web-tool-rows">
      <ToolRow
        field="webSearch"
        label="Search"
        description="Let the model search the public web"
        value={webSearch}
        staged={staged}
        pending={pending.includes("webSearch")}
        error={errors.webSearch}
        disabled={disabled || pending.length > 0}
        unavailableReason={unavailableReason}
        onChange={onChange}
      />
      <ToolRow
        field="webFetch"
        label="Fetch"
        description="Let the model read a specific public page"
        value={webFetch}
        staged={staged}
        pending={pending.includes("webFetch")}
        error={errors.webFetch}
        disabled={disabled || pending.length > 0}
        unavailableReason={unavailableReason}
        onChange={onChange}
      />
    </div>
  );
  const state =
    webSearch === undefined || webFetch === undefined
      ? "Loading configuration"
      : `Search ${webSearch ? "on" : "off"} · Fetch ${webFetch ? "on" : "off"}`;

  return compact ? (
    <details
      className="web-tool-config compact"
      ref={details}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !event.currentTarget.open) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.removeAttribute("open");
        summary.current?.focus();
      }}
    >
      <summary ref={summary} title={unavailableReason}>
        <span>Web tools</span>
        <small>{state}</small>
      </summary>
      <div className="web-tool-popover">
        <header>
          <strong>Web tool configuration</strong>
          <small>Changes rebuild the session runtime.</small>
        </header>
        {rows}
      </div>
    </details>
  ) : (
    <section className="web-tool-config" aria-labelledby="web-tool-config-title">
      <header>
        <strong id="web-tool-config-title">Web tool configuration</strong>
        <small>Applied when the Code session is created.</small>
      </header>
      {rows}
    </section>
  );
}
