// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import type {
  ConversationRecord,
  ConversationState,
  EventId,
  InteractionAction,
  JsonObject,
  JsonValue,
  ProjectedInteraction,
  ProjectedPermission,
  ProjectedToolCall,
  UserContent,
} from "@axl/sdk";

const DETAIL_CHARACTER_LIMIT = 16_384;
const MESSAGE_CHARACTER_LIMIT = 131_072;
const SUMMARY_CHARACTER_LIMIT = 2_048;
const MAX_INTERACTION_FIELDS = 32;

function boundedText(value: string, limit = DETAIL_CHARACTER_LIMIT): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… ${value.length - limit} characters omitted`;
}

function boundedJson(value: JsonValue | JsonObject): string {
  return boundedText(JSON.stringify(value, null, 2));
}

function textValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function firstInput(call: ProjectedToolCall, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = textValue(call.input[name]);
    if (value !== undefined) return boundedText(value, SUMMARY_CHARACTER_LIMIT);
  }
  return undefined;
}

function Content({ content, limit = DETAIL_CHARACTER_LIMIT }: {
  readonly content: readonly UserContent[];
  readonly limit?: number;
}): ReactNode {
  const text = content
    .map((part) =>
      part.type === "text"
        ? part.text
        : `Attachment: ${part.blob.name ?? "unnamed"} (${part.blob.mediaType}, ${part.blob.sizeBytes} bytes)`,
    )
    .join("\n");
  return <span className="content-text">{boundedText(text, limit)}</span>;
}

function DetailValue({ label, value }: { readonly label: string; readonly value: JsonValue | JsonObject }) {
  return (
    <section>
      <h4>{label}</h4>
      <pre>{boundedJson(value)}</pre>
    </section>
  );
}

function ToolDetails({ call }: { readonly call: ProjectedToolCall }) {
  return (
    <details className="record-details">
      <summary>Details</summary>
      <dl>
        <div><dt>Tool</dt><dd>{boundedText(call.name, 256)}</dd></div>
        <div><dt>Status</dt><dd>{call.result === undefined ? "Running" : call.result.isError ? "Failed" : "Completed"}</dd></div>
        {call.result === undefined ? null : <div><dt>Latency</dt><dd>{call.result.latencyMs} ms</dd></div>}
      </dl>
      <DetailValue label="Input" value={call.input} />
      {call.result === undefined ? null : (
        <section>
          <h4>Result</h4>
          <pre><Content content={call.result.content} /></pre>
        </section>
      )}
      {call.result?.details === undefined ? null : <DetailValue label="Result metadata" value={call.result.details} />}
    </details>
  );
}

function ToolFrame({ call, title, summary, className }: {
  readonly call: ProjectedToolCall;
  readonly title: string;
  readonly summary: string;
  readonly className: string;
}) {
  return (
    <article className={`record tool-card ${className}`} data-render-intent={call.renderIntent}>
      <header><strong>{title}</strong><span>{call.result === undefined ? "Running" : call.result.isError ? "Error" : "Done"}</span></header>
      <p>{summary}</p>
      <ToolDetails call={call} />
    </article>
  );
}

function ShellTool({ call }: { readonly call: ProjectedToolCall }) {
  return <ToolFrame call={call} title="Shell" summary={firstInput(call, ["command", "cmd"]) ?? call.name} className="tool-shell" />;
}
function ReadTool({ call }: { readonly call: ProjectedToolCall }) {
  return <ToolFrame call={call} title="Read" summary={firstInput(call, ["path", "file", "filename"]) ?? call.name} className="tool-read" />;
}
function EditTool({ call }: { readonly call: ProjectedToolCall }) {
  return <ToolFrame call={call} title="Edit / diff" summary={firstInput(call, ["path", "file", "filename", "patch"]) ?? call.name} className="tool-edit" />;
}
function SearchTool({ call }: { readonly call: ProjectedToolCall }) {
  return <ToolFrame call={call} title="Search" summary={firstInput(call, ["query", "pattern", "path"]) ?? call.name} className="tool-search" />;
}
function WebTool({ call }: { readonly call: ProjectedToolCall }) {
  return <ToolFrame call={call} title="Web" summary={firstInput(call, ["url", "query"]) ?? call.name} className="tool-web" />;
}
function McpTool({ call }: { readonly call: ProjectedToolCall }) {
  return <ToolFrame call={call} title="MCP" summary={firstInput(call, ["tool", "server", "name"]) ?? call.name} className="tool-mcp" />;
}
function WorkflowTool({ call }: { readonly call: ProjectedToolCall }) {
  return <ToolFrame call={call} title="Workflow" summary={firstInput(call, ["workflow", "name", "step"]) ?? call.name} className="tool-workflow" />;
}
function GenericTool({ call }: { readonly call: ProjectedToolCall }) {
  return <ToolFrame call={call} title="Tool" summary={boundedText(call.name, 256)} className="tool-generic" />;
}

const TOOL_RENDERERS: Record<ProjectedToolCall["renderIntent"], (props: { readonly call: ProjectedToolCall }) => ReactNode> = {
  shell: ShellTool,
  read: ReadTool,
  edit: EditTool,
  search: SearchTool,
  web: WebTool,
  mcp: McpTool,
  workflow: WorkflowTool,
  generic: GenericTool,
};

export function ToolCard({ call }: { readonly call: ProjectedToolCall }) {
  const Renderer = TOOL_RENDERERS[call.renderIntent];
  return <Renderer call={call} />;
}

export function GenericRecord({ title, value }: { readonly title: string; readonly value: JsonValue | JsonObject }) {
  return (
    <article className="record record-generic">
      <strong>{boundedText(title, 256)}</strong>
      <details className="record-details">
        <summary>Details</summary>
        <pre>{boundedJson(value)}</pre>
      </details>
    </article>
  );
}

function MessageRecord({ record }: { readonly record: Extract<ConversationRecord, { kind: "event" }> }) {
  const event = record.event;
  if (event.type === "user.message") {
    return <article className="record record-user-message"><small>User</small><div><Content content={event.payload.content} limit={MESSAGE_CHARACTER_LIMIT} /></div></article>;
  }
  if (event.type !== "assistant.message") return null;
  const text = event.payload.content.filter((part) => part.type !== "thinking");
  const thinking = event.payload.content.filter((part) => part.type === "thinking");
  return (
    <article className={`record record-assistant-message stop-${event.payload.stopReason}`}>
      <small>Assistant</small>
      {text.length === 0 ? null : <div><Content content={text} limit={MESSAGE_CHARACTER_LIMIT} /></div>}
      {thinking.length === 0 ? null : <details className="thinking"><summary>Thinking</summary><pre>{thinking.map((part) => boundedText(part.text)).join("\n")}</pre></details>}
      {event.payload.stopReason === "aborted" ? <p className="interrupted">Response interrupted</p> : null}
      {event.payload.errorMessage === undefined ? null : <p className="error-text">{boundedText(event.payload.errorMessage)}</p>}
      {event.payload.usage === undefined ? null : <details className="record-details"><summary>Usage</summary><pre>{boundedJson(event.payload.usage)}</pre></details>}
    </article>
  );
}

function PermissionRecord({ permission }: { readonly permission: ProjectedPermission }) {
  return (
    <article className="record record-permission">
      <strong>Permission</strong>
      <p>{boundedText(permission.request.payload.description)}</p>
      <p>{permission.resolution === undefined ? "Pending" : permission.resolution.payload.decision.replaceAll("_", " ")}</p>
      <details className="record-details">
        <summary>Details</summary>
        <dl>
          <div><dt>Capability</dt><dd>{boundedText(permission.request.payload.capability, 512)}</dd></div>
          {permission.resolution?.payload.reason === undefined ? null : <div><dt>Reason</dt><dd>{boundedText(permission.resolution.payload.reason)}</dd></div>}
        </dl>
      </details>
    </article>
  );
}

function ConversationEvent({ record, state }: { readonly record: ConversationRecord; readonly state: ConversationState }) {
  if (record.kind === "unknown_event") return <GenericRecord title={`Unknown event: ${record.event.type}`} value={record.event.payload} />;
  const event = record.event;
  if (event.type === "user.message" || event.type === "assistant.message") return <MessageRecord record={record} />;
  if (event.type === "tool.call") {
    const call = state.tools.find((item) => item.callId === event.payload.callId);
    return call === undefined ? <GenericRecord title={`Unpaired tool: ${event.payload.name}`} value={event.payload} /> : <ToolCard call={call} />;
  }
  if (event.type === "tool.result" || event.type === "permission.resolved" || event.type === "interaction.resolved" || event.type.startsWith("queue.")) return null;
  if (event.type === "permission.requested") {
    const permission = state.permissions.find((item) => item.request.id === event.id);
    return permission === undefined ? <GenericRecord title="Permission" value={event.payload} /> : <PermissionRecord permission={permission} />;
  }
  if (event.type === "session.error") {
    return <article className="record record-error" role="alert"><strong>Error: {boundedText(event.payload.code, 256)}</strong><p>{boundedText(event.payload.message)}</p><details className="record-details"><summary>Details</summary><p>Retryable: {event.payload.retryable ? "yes" : "no"}</p>{event.payload.details === undefined ? null : <pre>{boundedJson(event.payload.details)}</pre>}</details></article>;
  }
  if (event.type === "context.compacted") {
    return <article className="record record-compaction"><strong>Context compacted</strong><p>{boundedText(event.payload.summary)}</p><details className="record-details"><summary>Details</summary><p>{event.payload.replacedEventIds.length} events replaced</p>{event.payload.usage === undefined ? null : <pre>{boundedJson(event.payload.usage)}</pre>}</details></article>;
  }
  if (event.type === "user.shell") {
    return <article className="record tool-card tool-shell"><header><strong>Shell</strong><span>{event.payload.isError ? "Error" : "Done"}</span></header><p>{boundedText(event.payload.command, SUMMARY_CHARACTER_LIMIT)}</p><details className="record-details"><summary>Details</summary><pre><Content content={event.payload.content} /></pre><p>{event.payload.excluded ? "Excluded from model context" : "Included in model context"}</p></details></article>;
  }
  if (event.type === "interaction.requested") return null;
  return <GenericRecord title={event.type} value={event.payload} />;
}

export interface InteractionField {
  readonly name: string;
  readonly description?: string;
  readonly type: "string" | "number" | "integer" | "boolean";
  readonly required: boolean;
  readonly choices?: readonly string[];
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function interactionFields(interaction: ProjectedInteraction): readonly InteractionField[] {
  if (interaction.request.payload.kind !== "mcp_elicitation_form") return [];
  const request = objectValue(interaction.request.payload.data?.request);
  const schema = objectValue(request?.requestedSchema);
  const properties = objectValue(schema?.properties);
  if (properties === undefined) return [];
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
  return Object.entries(properties).slice(0, MAX_INTERACTION_FIELDS).flatMap(([name, value]) => {
    const field = objectValue(value);
    const type = field?.type;
    if (field === undefined || (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean")) return [];
    const choices = Array.isArray(field.enum) ? field.enum.filter((item): item is string => typeof item === "string").slice(0, 64) : undefined;
    return [{ name, type, required: required.has(name), ...(typeof field.description === "string" ? { description: boundedText(field.description, 1_024) } : {}), ...(choices === undefined || choices.length === 0 ? {} : { choices }) }];
  });
}

export function parseInteractionValue(field: InteractionField, raw: FormDataEntryValue | null): JsonValue | undefined {
  if (field.type === "boolean") return raw !== null;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") {
    if (field.required) throw new Error(`${field.name} is required`);
    return undefined;
  }
  if (field.choices !== undefined && !field.choices.includes(text)) throw new Error(`${field.name} is not an allowed value`);
  if (field.type === "string") return boundedText(text);
  const number = Number(text);
  if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) throw new Error(`${field.name} must be a ${field.type}`);
  return number;
}

function InteractionCard({ interaction, disabled, onRespond }: {
  readonly interaction: ProjectedInteraction;
  readonly disabled: boolean;
  readonly onRespond: (interactionId: string, action: InteractionAction, content?: JsonObject) => void;
}) {
  const [error, setError] = useState<string>();
  const request = interaction.request.payload;
  const fields = interactionFields(interaction);
  const resolved = interaction.resolution?.payload;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const content = Object.create(null) as Record<string, JsonValue>;
    try {
      for (const field of fields) {
        const value = parseInteractionValue(field, data.get(field.name));
        if (value !== undefined) content[field.name] = value;
      }
      setError(undefined);
      onRespond(interaction.interactionId, "accept", content);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Invalid response");
    }
  };
  return (
    <article className="interaction record">
      <h2>{resolved === undefined ? "Response needed" : "Interaction resolved"}</h2>
      <p>{boundedText(request.message)}</p>
      <small>{request.kind} · {boundedText(request.source, 512)}</small>
      {resolved === undefined && fields.length > 0 ? (
        <form className="interaction-form" onSubmit={submit}>
          {fields.map((field) => <label key={field.name}>{field.name}{field.required ? " (required)" : ""}{field.description === undefined ? null : <small>{field.description}</small>}{field.type === "boolean" ? <input name={field.name} type="checkbox" /> : field.choices === undefined ? <input name={field.name} type={field.type === "string" ? "text" : "number"} step={field.type === "number" ? "any" : undefined} required={field.required} /> : <select name={field.name} required={field.required}><option value="">Select</option>{field.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}</select>}</label>)}
          {error === undefined ? null : <p role="alert" className="error-text">{error}</p>}
          <div className="actions"><button type="submit" disabled={disabled}>Submit</button><button type="button" disabled={disabled} onClick={() => onRespond(interaction.interactionId, "decline")}>Decline</button><button type="button" disabled={disabled} onClick={() => onRespond(interaction.interactionId, "cancel")}>Cancel</button></div>
        </form>
      ) : resolved === undefined ? (
        <div className="actions">{(["accept", "decline", "cancel"] as const).map((action) => <button type="button" disabled={disabled} key={action} onClick={() => onRespond(interaction.interactionId, action)}>{action}</button>)}</div>
      ) : <p>Decision: {resolved.action}</p>}
      <details className="record-details"><summary>Details</summary>{request.data === undefined ? <p>No structured request data</p> : <pre>{boundedJson(request.data)}</pre>}{resolved?.content === undefined ? null : <DetailValue label="Response" value={resolved.content} />}</details>
    </article>
  );
}

export function ConversationPresentation({ state, interactionDisabled, queueDisabled, onRespond, onRequeue }: {
  readonly state: ConversationState;
  readonly interactionDisabled: boolean;
  readonly queueDisabled: boolean;
  readonly onRespond: (interactionId: string, action: InteractionAction, content?: JsonObject) => void;
  readonly onRequeue: (queueItemId: EventId) => void;
}) {
  return (
    <>
      <ol className="records" aria-label="Conversation events">
        {state.records.map((record) => <li key={record.event.id}><ConversationEvent record={record} state={state} /></li>)}
      </ol>
      {state.activity === undefined ? null : <section className="activity" aria-label="Current activity"><strong>Working</strong>{state.activity.thinking === "" ? null : <details className="thinking" open><summary>Thinking</summary><pre>{boundedText(state.activity.thinking)}</pre></details>}{state.activity.text === "" ? null : <pre>{boundedText(state.activity.text)}</pre>}<details className="record-details"><summary>Live details</summary><dl><div><dt>Operation</dt><dd>{state.activity.operationId}</dd></div><div><dt>Sequence</dt><dd>{state.activity.sequence}</dd></div><div><dt>Pending tool calls</dt><dd>{state.activity.toolCalls.length}</dd></div></dl></details></section>}
      {state.interactions.map((interaction) => <InteractionCard key={interaction.interactionId} interaction={interaction} disabled={interactionDisabled || interaction.resolution !== undefined} onRespond={onRespond} />)}
      {state.queue.length === 0 ? null : <section aria-label="Prompt queue" className="queue"><h2>Queue</h2><ul>{state.queue.map((item) => <li key={item.queueItemId}><span>{item.status} · <Content content={item.content} limit={SUMMARY_CHARACTER_LIMIT} /></span>{item.status === "paused" ? <button type="button" disabled={queueDisabled} onClick={() => onRequeue(item.queueItemId)}>Requeue</button> : null}</li>)}</ul></section>}
      {state.uncertainShellOperations.map((operation) => <article className="record record-warning" key={operation.operationId}><strong>Shell outcome uncertain</strong><p>{boundedText(operation.command, SUMMARY_CHARACTER_LIMIT)}</p><p>Review canonical session history before retrying.</p></article>)}
    </>
  );
}
