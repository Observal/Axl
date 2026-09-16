// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type {
  AdoptionCandidate,
  AdoptionControllerState,
  AdoptionInspectResult,
} from "@axl/sdk";
import { adoptionCandidateDescription, groupAdoptionCandidates } from "./adoption-presentation.ts";

export interface AdoptionDialogProps {
  readonly state: AdoptionControllerState;
  readonly onRefresh: () => void;
  readonly onInspect: (candidate: AdoptionCandidate) => void;
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
        <span>
          {adoptionCandidateDescription(candidate)}
        </span>
      </button>
    </li>
  );
}

function Inspection({ report }: { readonly report: AdoptionInspectResult }) {
  return (
    <section aria-label="Adoption inspection">
      <h3>{report.candidate.displayName}</h3>
      <p>
        {report.adapter.id} {report.adapter.version} · {report.inventory.fileCount} files ·{" "}
        {report.inventory.totalBytes} bytes
      </p>
      {report.inventory.executable && <p role="alert">Contains executable surfaces.</p>}
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
      <p>Inspection only. No source was executed and no installation or activation occurred.</p>
    </section>
  );
}

/** SDK-backed adoption discovery surface. It has no filesystem or process authority. */
export function AdoptionDialog({
  state,
  onRefresh,
  onInspect,
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
            {state.inspection && <Inspection report={state.inspection} />}
          </>
        )}
      </section>
    </div>
  );
}
