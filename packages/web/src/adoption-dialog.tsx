// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import type {
  AdoptionCandidate,
  AdoptionControllerState,
  AdoptionInspectResult,
} from "@axl/sdk";
import { adoptionCandidateDescription, groupAdoptionCandidates } from "./adoption-presentation.ts";
import { adoptionTrustReviewPresentation } from "./adoption-workflow.ts";

export interface AdoptionDialogProps {
  readonly state: AdoptionControllerState;
  readonly onRefresh: () => void;
  readonly onInspect: (candidate: AdoptionCandidate) => void;
  readonly onActivate: (
    candidate: AdoptionCandidate,
    report: AdoptionInspectResult,
  ) => Promise<void>;
  readonly onDismissFindings: () => void;
  readonly onClose: () => void;
}

function CandidateRow({
  candidate,
  onInspect,
}: {
  readonly candidate: AdoptionCandidate;
  readonly onInspect: (candidate: AdoptionCandidate) => void;
}) {
  return (
    <li>
      <button type="button" onClick={() => onInspect(candidate)}>
        <strong>{candidate.displayName}</strong>
        <span>{adoptionCandidateDescription(candidate)}</span>
      </button>
    </li>
  );
}

function Inspection({
  report,
  onActivate,
}: {
  readonly report: AdoptionInspectResult;
  readonly onActivate: (
    candidate: AdoptionCandidate,
    report: AdoptionInspectResult,
  ) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [activated, setActivated] = useState(false);
  const [error, setError] = useState<string>();
  const review = report.trustReview;
  const presentation = adoptionTrustReviewPresentation(report);
  const blocked =
    review === undefined || review.executableFiles.length > 0 || review.conflicts.length > 0;

  const activate = async () => {
    setInstalling(true);
    setError(undefined);
    try {
      await onActivate(report.candidate, report);
      setActivated(true);
      setConfirming(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Native Agent Skill activation failed");
    } finally {
      setInstalling(false);
    }
  };

  return (
    <section aria-label="Adoption inspection">
      <h3>{report.candidate.displayName}</h3>
      <p>
        {report.adapter.id} {report.adapter.version} · {report.inventory.fileCount} files ·{" "}
        {report.inventory.totalBytes} bytes
      </p>
      {report.inventory.executable && <p role="alert">Contains executable surfaces.</p>}
      <h4>Resources</h4>
      <ul>
        {report.surfaces.map((surface) => (
          <li key={surface.surfaceId}>
            {surface.kind} · {surface.name}
            {surface.executable ? " · executable" : ""}
            {surface.dynamicBehavior === "unknown" ? " · dynamic behavior unknown" : ""}
          </li>
        ))}
        {report.diagnostics.map((diagnostic, index) => (
          <li key={`${diagnostic.code}-${diagnostic.relativePath ?? index}`}>
            {diagnostic.severity} · {diagnostic.code} · {diagnostic.message}
          </li>
        ))}
      </ul>
      {review !== undefined && (
        <section aria-label="Trust review">
          <h4>Trust review</h4>
          <dl>
            <dt>Source</dt>
            <dd><code>{presentation?.sourceIdentity}</code></dd>
            <dt>Source hash</dt><dd><code>{review.sourceContentSha256}</code></dd>
            <dt>Policy</dt><dd><code>{review.policyGeneration}</code></dd>
            <dt>Destination</dt><dd>{review.targetScope}</dd>
            <dt>License</dt><dd>{review.licenseExpressions.join(", ") || "Not declared"}</dd>
          </dl>
          <h5>License files and notices</h5>
          <ul>
            {review.licenseFiles.map((file) => <li key={`license-${file.relativePath}`}>license · {file.relativePath}</li>)}
            {review.noticeFiles.map((file) => <li key={`notice-${file.relativePath}`}>notice · {file.relativePath}</li>)}
            {review.licenseFiles.length === 0 && review.noticeFiles.length === 0 && <li>None found</li>}
          </ul>
          <h5>Capabilities</h5>
          <ul>
            {review.capabilityRequests.map((request) => <li key={request.capability}>{request.capability} · {request.rationale}</li>)}
            {review.capabilityRequests.length === 0 && <li>None requested</li>}
          </ul>
          <h5>Declarative documents and assets</h5>
          <ul>
            {review.declarativeFiles.map((file) => (
              <li key={file.relativePath}>{file.relativePath}</li>
            ))}
          </ul>
          <h5>Executable helpers</h5>
          <ul>
            {review.executableFiles.map((file) => (
              <li key={file.relativePath}>{file.relativePath}</li>
            ))}
            {review.executableFiles.length === 0 && <li>None detected</li>}
          </ul>
          <h5>Conflicts and precedence changes</h5>
          <ul>
            {review.conflicts.map((conflict) => <li key={`conflict-${conflict}`} role="alert">{conflict}</li>)}
            {review.precedenceChanges.map((change) => <li key={`precedence-${change}`}>{change}</li>)}
            {review.conflicts.length === 0 && review.precedenceChanges.length === 0 && <li>None</li>}
          </ul>
          {error && <p role="alert">{error}</p>}
          {activated ? (
            <p role="status">Agent Skill activated.</p>
          ) : confirming ? (
            <div role="alert">
              <p>Activate this exact immutable Agent Skill revision?</p>
              <button type="button" disabled={installing} onClick={() => void activate()}>
                {installing ? "Activating…" : "Confirm activation"}
              </button>
              <button type="button" disabled={installing} onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          ) : (
            <button type="button" disabled={blocked} onClick={() => setConfirming(true)}>
              {blocked ? "Native installation blocked" : "Install Agent Skill"}
            </button>
          )}
        </section>
      )}
      <p>Inspection only until explicit activation. No source was executed.</p>
    </section>
  );
}

/** SDK-backed adoption discovery surface. It has no filesystem or process authority. */
export function AdoptionDialog({
  state,
  onRefresh,
  onInspect,
  onActivate,
  onDismissFindings,
  onClose,
}: AdoptionDialogProps) {
  const groups = groupAdoptionCandidates(state.candidates);
  return (
    <div className="control-scrim" role="presentation">
      <section className="new-session-dialog adoption-dialog" role="dialog" aria-modal="true" aria-label="Adopt resources">
        <header>
          <h2>Adopt existing resources</h2>
          <button type="button" onClick={onClose} aria-label="Close adoption discovery">×</button>
        </header>
        {state.status === "unavailable" ? (
          <p role="status">Adoption discovery is unavailable on this connection.</p>
        ) : (
          <>
            <div className="dialog-actions">
              <button type="button" onClick={onRefresh} disabled={state.status === "loading"}>
                {state.status === "loading" ? "Scanning…" : "Rescan"}
              </button>
              <button type="button" onClick={onDismissFindings}>Dismiss findings</button>
            </div>
            {state.error && <p role="alert">{state.error.message}</p>}
            {state.status !== "loading" && state.candidates.length === 0 && (
              <p>No supported resources were found in approved roots.</p>
            )}
            {[...groups].map(([group, candidates]) => (
              <section key={group}>
                <h3>{group}</h3>
                <ul>
                  {candidates.map((candidate) => (
                    <CandidateRow key={candidate.candidateId} candidate={candidate} onInspect={onInspect} />
                  ))}
                </ul>
              </section>
            ))}
            {state.warnings.length > 0 && (
              <section>
                <h3>Skipped or malformed resources</h3>
                <ul>
                  {state.warnings.map((warning, index) => (
                    <li key={`${warning.code}-${warning.relativePath ?? index}`}>
                      {warning.severity} · {warning.code} · {warning.message}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {state.inspection && <Inspection report={state.inspection} onActivate={onActivate} />}
          </>
        )}
      </section>
    </div>
  );
}
