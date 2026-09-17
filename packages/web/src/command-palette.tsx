// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { EffectiveCommand } from "@axl/sdk";
import { trapDialogFocus } from "./dialog-focus.ts";

import { filterCommands } from "./commands.ts";

export function CommandPalette({
  commands,
  open,
  error,
  onClose,
  onSelect,
}: {
  readonly commands: readonly EffectiveCommand[];
  readonly open: boolean;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onSelect: (command: EffectiveCommand) => void;
}): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const dialog = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    if (!open) return;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    setQuery("");
    setActive(0);
    queueMicrotask(() => input.current?.focus());
    return () => prior?.focus();
  }, [open]);

  if (!open) return null;
  const handleDialogKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    trapDialogFocus(event, dialog.current);
  };

  const choose = (command: EffectiveCommand | undefined): void => {
    if (command === undefined || command.availability.state === "unavailable") return;
    onSelect(command);
  };
  return (
    <div className="command-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="command-palette" ref={dialog} role="dialog" aria-modal="true" aria-label="Commands" onKeyDown={handleDialogKeyDown}>
        <input
          ref={input}
          type="search"
          aria-label="Search commands"
          placeholder="Search commands"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setActive((current) => Math.min(current + 1, visible.length - 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActive((current) => Math.max(current - 1, 0)); }
            else if (event.key === "Enter") { event.preventDefault(); choose(visible[active]); }
          }}
        />
        {error && <p className="command-error" role="alert">{error}</p>}
        <div className="command-list" role="listbox" aria-label="Available commands">
          {visible.length === 0 && <p>No matching commands</p>}
          {visible.map((command, index) => (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected={index === active}
              disabled={command.availability.state === "unavailable"}
              className={index === active ? "active" : ""}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(command)}
            >
              <span><strong>/{command.name}</strong>{command.argument.hint && <code>{command.argument.hint}</code>}</span>
              <small>{command.availability.state === "unavailable" ? command.availability.reason : command.description}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
