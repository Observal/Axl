// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, useEffect, useState } from "react";
import type {
  InteractionAction,
  JsonObject,
  JsonValue,
  ProjectedInteraction,
  UserQuestion,
  UserQuestionAnswer,
} from "@axl/sdk";
import { Markdown } from "./markdown.tsx";

export type InteractionResponder = (
  interactionId: string,
  action: InteractionAction,
  content?: JsonObject,
) => Promise<void>;

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function choices(schema: JsonObject): readonly { readonly value: string; readonly label: string }[] {
  if (Array.isArray(schema.enum)) {
    return schema.enum.flatMap((value) => typeof value === "string" ? [{ value, label: value }] : []);
  }
  const alternatives = Array.isArray(schema.oneOf) ? schema.oneOf : schema.anyOf;
  if (!Array.isArray(alternatives)) return [];
  return alternatives.flatMap((entry) => {
    const option = object(entry);
    return typeof option?.const === "string"
      ? [{ value: option.const, label: typeof option.title === "string" ? option.title : option.const }]
      : [];
  });
}

function initialValue(schema: JsonObject, required: boolean): JsonValue {
  if (schema.default !== undefined) return schema.default;
  if (!required) return null;
  if (schema.type === "boolean") return false;
  if (schema.type === "array") return [];
  return choices(schema)[0]?.value ?? "";
}

function safeUrl(data: JsonObject | undefined): string | undefined {
  const request = object(data?.request);
  const value = typeof data?.url === "string" ? data.url : typeof request?.url === "string" ? request.url : undefined;
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return url.href;
  } catch {
    return undefined;
  }
  return undefined;
}

function validateValue(name: string, schema: JsonObject, value: JsonValue, required: boolean): string | undefined {
  if ((value === "" || value === null) && !required) return undefined;
  if ((value === "" || value === null) && required) return `${name} is required`;
  if ((schema.type === "number" || schema.type === "integer") && typeof value !== "number") return `${name} must be a number`;
  if (schema.type === "integer" && typeof value === "number" && !Number.isInteger(value)) return `${name} must be an integer`;
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) return `${name} must be at least ${schema.minimum}`;
  if (typeof value === "number" && typeof schema.maximum === "number" && value > schema.maximum) return `${name} must be at most ${schema.maximum}`;
  if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) return `${name} is too short`;
  if (typeof value === "string" && typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${name} is too long`;
  if (Array.isArray(value) && typeof schema.minItems === "number" && value.length < schema.minItems) return `${name} needs at least ${schema.minItems} choices`;
  if (Array.isArray(value) && typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${name} allows at most ${schema.maxItems} choices`;
  return undefined;
}

function InteractionForm({ interaction, respond }: { readonly interaction: ProjectedInteraction; readonly respond: InteractionResponder }): React.JSX.Element {
  const requestData = object(interaction.request.payload.data?.request);
  const schema = object(requestData?.requestedSchema);
  const properties = object(schema?.properties) ?? {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
  const fields = Object.entries(properties).flatMap(([name, value]) => {
    const fieldSchema = object(value);
    return fieldSchema === undefined ? [] : [{ name, schema: fieldSchema }];
  });
  const [values, setValues] = useState<Record<string, JsonValue>>(() => Object.fromEntries(fields.map((field) => [field.name, initialValue(field.schema, required.has(field.name))])));
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState<InteractionAction>();

  const submit = async (action: InteractionAction): Promise<void> => {
    let content: JsonObject | undefined;
    if (action === "accept") {
      const next: Record<string, JsonValue> = {};
      for (const field of fields) {
        const value = values[field.name] ?? "";
        const message = validateValue(field.name, field.schema, value, required.has(field.name));
        if (message !== undefined) {
          setError(message);
          return;
        }
        if ((value !== "" && value !== null) || required.has(field.name)) next[field.name] = value;
      }
      content = next;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await respond(interaction.interactionId, action, content);
      setCompleted(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit the MCP response");
      setSubmitting(false);
    }
  };

  if (completed !== undefined) return <div className="notice system-notice"><strong>Interaction {completed}</strong><small>{interaction.request.payload.source} · {interaction.request.payload.message}</small></div>;
  if (schema === undefined) {
    return <InteractionApproval interaction={interaction} respond={respond} error="The MCP server supplied an unsupported form schema." />;
  }
  return <section className="interaction-card" aria-label="MCP input request">
    <header><span>MCP input</span><small>{interaction.request.payload.source}</small></header>
    <p>{interaction.request.payload.message}</p>
    <form onSubmit={(event) => { event.preventDefault(); void submit("accept"); }}>
      {fields.map((field) => {
        const title = typeof field.schema.title === "string" ? field.schema.title : field.name;
        const description = typeof field.schema.description === "string" ? field.schema.description : undefined;
        const options = field.schema.type === "array"
          ? choices(object(field.schema.items) ?? {})
          : choices(field.schema);
        const value = values[field.name] ?? "";
        if (field.schema.type === "boolean") return <label key={field.name}><span>{title}{required.has(field.name) && <b aria-label="required">*</b>}</span>{description && <small>{description}</small>}<select value={value === null ? "" : String(value)} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value === "" ? null : event.target.value === "true" }))}>{!required.has(field.name) && <option value="">Omit</option>}<option value="true">Yes</option><option value="false">No</option></select></label>;
        if (field.schema.type === "array") {
          const selected = Array.isArray(value) ? value : [];
          if (options.length > 0) return <fieldset key={field.name}><legend>{title}{required.has(field.name) && <b aria-label="required">*</b>}</legend>{description && <small>{description}</small>}{options.map((option) => <label className="interaction-choice" key={option.value}><input type="checkbox" checked={selected.includes(option.value)} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.checked ? [...selected, option.value] : selected.filter((entry) => entry !== option.value) }))} /><span>{option.label}</span></label>)}</fieldset>;
          return <label key={field.name}><span>{title}{required.has(field.name) && <b aria-label="required">*</b>}</span>{description && <small>{description}</small>}<input type="text" required={required.has(field.name)} value={selected.join(", ")} placeholder="Comma-separated values" onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) }))} /></label>;
        }
        if (options.length > 0) return <label key={field.name}><span>{title}{required.has(field.name) && <b aria-label="required">*</b>}</span>{description && <small>{description}</small>}<select required={required.has(field.name)} value={value === null ? "" : String(value)} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}>{!required.has(field.name) && <option value="">Omit</option>}{options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>;
        const numeric = field.schema.type === "number" || field.schema.type === "integer";
        return <label key={field.name}><span>{title}{required.has(field.name) && <b aria-label="required">*</b>}</span>{description && <small>{description}</small>}<input type={numeric ? "number" : "text"} required={required.has(field.name)} value={value === null ? "" : String(value)} step={field.schema.type === "integer" ? 1 : numeric ? "any" : undefined} min={typeof field.schema.minimum === "number" ? field.schema.minimum : undefined} max={typeof field.schema.maximum === "number" ? field.schema.maximum : undefined} minLength={typeof field.schema.minLength === "number" ? field.schema.minLength : undefined} maxLength={typeof field.schema.maxLength === "number" ? field.schema.maxLength : undefined} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value === "" ? (required.has(field.name) ? "" : null) : numeric ? Number(event.target.value) : event.target.value }))} /></label>;
      })}
      {error && <div className="interaction-error" role="alert">{error}</div>}
      <footer><button type="button" disabled={submitting} onClick={() => void submit("decline")}>Decline</button><button type="button" disabled={submitting} onClick={() => void submit("cancel")}>Cancel</button><button className="primary" type="submit" disabled={submitting}>{submitting ? "Submitting…" : "Submit"}</button></footer>
    </form>
  </section>;
}

export interface QuestionnaireFormProps {
  readonly questions: readonly UserQuestion[];
  /** Accessible label and visible heading for the review step. */
  readonly title?: string;
  readonly submitLabel?: string;
  readonly pendingLabel?: string;
  /** Extra review content derived from the answers, e.g. the exact effect of submitting. */
  readonly review?: (answers: readonly UserQuestionAnswer[]) => ReactNode;
  readonly onSubmit: (answers: readonly UserQuestionAnswer[]) => Promise<void>;
  readonly onCancel: () => void | Promise<void>;
}

/**
 * Stepped questionnaire shared by model questions and client-local guided flows.
 * Questions without options go straight to text entry.
 */
export function QuestionnaireForm({ questions, title, submitLabel = "Submit", pendingLabel = "Submitting…", review, onSubmit, onCancel }: QuestionnaireFormProps): React.JSX.Element {
  const [answers, setAnswers] = useState<readonly UserQuestionAnswer[]>(() =>
    questions.map((_, questionIndex) => ({ questionIndex, selectedLabels: [] })),
  );
  const [step, setStep] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [custom, setCustom] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const question = questions[step];
  const textOnly = question !== undefined && question.options.length === 0;
  useEffect(() => {
    if (textOnly) setCustom(true);
  }, [textOnly, step]);
  const answer = answers[step] ?? { questionIndex: step, selectedLabels: [] };
  const update = (next: UserQuestionAnswer): void => {
    setAnswers((current) => current.map((item, index) => index === step ? next : item));
  };
  const advance = (): void => {
    setCustom(false);
    setPreview(undefined);
    if (step === questions.length - 1) setReviewing(true);
    else setStep((current) => current + 1);
  };
  const submit = async (action: "accept" | "cancel"): Promise<void> => {
    setSubmitting(true);
    setError(undefined);
    try {
      if (action === "accept") await onSubmit(answers);
      else await onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit answers");
      setSubmitting(false);
    }
  };
  if (question === undefined) {
    return <div className="notice system-notice warning"><strong>Questionnaire unavailable</strong><small>No questions were provided.</small></div>;
  }
  if (reviewing) {
    return <section className="interaction-card questionnaire" aria-label={title ?? "Review answers"}>
      <header><strong>{title === undefined ? "Review answers" : `${title} · review`}</strong><small>{questions.length}/{questions.length}</small></header>
      <div className="question-review">
        {questions.map((item, index) => {
          const itemAnswer = answers[index];
          return <button type="button" key={item.question} onClick={() => { setStep(index); setReviewing(false); }}>
            <span><strong>{item.header}</strong><small>{[...(itemAnswer?.selectedLabels ?? []), itemAnswer?.customAnswer].filter(Boolean).join(", ") || "(unanswered)"}</small></span>
            <span>Edit</span>
          </button>;
        })}
      </div>
      {review && <div className="question-review-detail">{review(answers)}</div>}
      {error && <div className="interaction-error" role="alert">{error}</div>}
      <footer><button type="button" disabled={submitting} onClick={() => void submit("cancel")}>Cancel</button><button className="primary" type="button" disabled={submitting} onClick={() => void submit("accept")}>{submitting ? pendingLabel : submitLabel}</button></footer>
    </section>;
  }
  const hasAnswer = answer.selectedLabels.length > 0 || (answer.customAnswer?.trim().length ?? 0) > 0;
  return <section className="interaction-card questionnaire" aria-label={title ?? "Questions from Axl"}>
    <header><strong>{question.question}</strong><small>{title === undefined ? "" : `${question.header} · `}{step + 1}/{questions.length}</small></header>
    <div className={`question-stage${preview === undefined ? "" : " has-preview"}`}>
      <div className="question-options" role="group" aria-label={question.header}>
        {question.options.map((option, optionIndex) => {
          const selected = answer.selectedLabels.includes(option.label);
          return <button
            className={selected ? "selected" : undefined}
            type="button"
            key={option.label}
            aria-pressed={selected}
            onFocus={() => setPreview(option.preview)}
            onMouseEnter={() => setPreview(option.preview)}
            onClick={() => {
              const selectedLabels = question.multiSelect === true
                ? selected
                  ? answer.selectedLabels.filter((label) => label !== option.label)
                  : [...answer.selectedLabels, option.label]
                : [option.label];
              setCustom(false);
              update({
                questionIndex: step,
                selectedLabels,
                ...(question.multiSelect === true && answer.customAnswer !== undefined
                  ? { customAnswer: answer.customAnswer }
                  : {}),
              });
              if (question.multiSelect !== true) advance();
            }}
          >
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
            <kbd>{optionIndex + 1}</kbd>
          </button>;
        })}
        {!textOnly && <button
          className={custom ? "selected" : undefined}
          type="button"
          aria-pressed={custom}
          onFocus={() => setPreview(undefined)}
          onMouseEnter={() => setPreview(undefined)}
          onClick={() => {
            setCustom(true);
            update({
              questionIndex: step,
              selectedLabels: question.multiSelect === true ? answer.selectedLabels : [],
              customAnswer: answer.customAnswer ?? "",
            });
          }}
        >
          <span><strong>Type something else…</strong><small>Provide an answer not listed above</small></span>
          <kbd>{question.options.length + 1}</kbd>
        </button>}
        {(custom || textOnly) && <div className="question-custom">{textOnly
          ? <textarea
            aria-label={`Answer for ${question.header}`}
            autoFocus
            rows={3}
            maxLength={4000}
            value={answer.customAnswer ?? ""}
            onChange={(event) => update({ questionIndex: step, selectedLabels: [], customAnswer: event.target.value })}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && hasAnswer) { event.preventDefault(); advance(); } }}
          />
          : <input
            type="text"
            aria-label={`Answer for ${question.header}`}
            autoFocus
            maxLength={4000}
            value={answer.customAnswer ?? ""}
            onChange={(event) => update({ questionIndex: step, selectedLabels: question.multiSelect === true ? answer.selectedLabels : [], customAnswer: event.target.value })}
            onKeyDown={(event) => { if (event.key === "Enter" && hasAnswer) { event.preventDefault(); advance(); } }}
          />}</div>}
      </div>
      {preview && <div className="question-preview"><Markdown text={preview} /></div>}
    </div>
    {error && <div className="interaction-error" role="alert">{error}</div>}
    <footer>
      <button type="button" disabled={submitting} onClick={() => void submit("cancel")}>Cancel</button>
      <span>
        {step > 0 && <button type="button" onClick={() => { setStep((current) => current - 1); setCustom(false); setPreview(undefined); }}>Back</button>}
        {(question.multiSelect === true || custom || textOnly) && <button className="primary" type="button" disabled={!hasAnswer || submitting} onClick={advance}>{step === questions.length - 1 ? "Review" : "Continue"}</button>}
      </span>
    </footer>
  </section>;
}

function UserQuestionnaire({ interaction, respond }: { readonly interaction: ProjectedInteraction; readonly respond: InteractionResponder }): React.JSX.Element {
  const questions = Array.isArray(interaction.request.payload.data?.questions)
    ? interaction.request.payload.data.questions as unknown as readonly UserQuestion[]
    : [];
  return <QuestionnaireForm
    questions={questions}
    onSubmit={(answers) => respond(interaction.interactionId, "accept", { answers }).then(() => undefined)}
    onCancel={() => respond(interaction.interactionId, "cancel").then(() => undefined)}
  />;
}

function InteractionApproval({ interaction, respond, error: initialError }: { readonly interaction: ProjectedInteraction; readonly respond: InteractionResponder; readonly error?: string | undefined }): React.JSX.Element {
  const [error, setError] = useState(initialError);
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState<InteractionAction>();
  const url = safeUrl(interaction.request.payload.data);
  const submit = async (action: InteractionAction): Promise<void> => {
    setSubmitting(true);
    setError(undefined);
    try {
      await respond(interaction.interactionId, action);
      setCompleted(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit the MCP response");
      setSubmitting(false);
    }
  };
  if (completed !== undefined) return <div className="notice system-notice"><strong>Interaction {completed}</strong><small>{interaction.request.payload.source} · {interaction.request.payload.message}</small></div>;
  return <section className="interaction-card" aria-label="MCP approval request">
    <header><span>{interaction.request.payload.kind === "mcp_elicitation_url" ? "Browser authorization" : interaction.request.payload.kind.startsWith("mcp_sampling") ? "Model request" : "Approval required"}</span><small>{interaction.request.payload.source}</small></header>
    <p>{interaction.request.payload.message}</p>
    {url && <a className="interaction-url" href={url} target="_blank" rel="noreferrer">Open authorization page</a>}
    {interaction.request.payload.data && <details><summary>Request details</summary><pre>{JSON.stringify(interaction.request.payload.data, null, 2)}</pre></details>}
    {error && <div className="interaction-error" role="alert">{error}</div>}
    <footer><button type="button" disabled={submitting} onClick={() => void submit("decline")}>Decline</button><button type="button" disabled={submitting} onClick={() => void submit("cancel")}>Cancel</button>{initialError === undefined && <button className="primary" type="button" disabled={submitting} onClick={() => void submit("accept")}>{submitting ? "Submitting…" : "Accept"}</button>}</footer>
  </section>;
}

export function InteractionCard({ interaction, respond }: { readonly interaction: ProjectedInteraction; readonly respond?: InteractionResponder | undefined }): React.JSX.Element {
  const resolution = interaction.resolution;
  if (resolution !== undefined) return <div className="notice system-notice"><strong>Interaction {resolution.payload.action}</strong><small>{interaction.request.payload.source} · {interaction.request.payload.message}</small></div>;
  if (respond === undefined) return <div className="notice system-notice warning" role="status"><strong>Interaction required</strong><small>{interaction.request.payload.source} · {interaction.request.payload.message}</small></div>;
  if (interaction.request.payload.kind === "user_question") {
    return <UserQuestionnaire interaction={interaction} respond={respond} />;
  }
  return interaction.request.payload.kind === "mcp_elicitation_form"
    ? <InteractionForm interaction={interaction} respond={respond} />
    : <InteractionApproval interaction={interaction} respond={respond} />;
}
