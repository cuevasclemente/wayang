import { useId } from "react";

export interface ExternalActionApprovalRequest {
  requestId: string;
  sessionId: string;
  selectionId: string;
  connector: string;
  workspace?: string;
  toolName: string;
  target?: string;
  summary: string;
  argumentsHash: string;
  createdAt: number;
  timeoutMs: number;
  submitting: boolean;
  responseError?: string;
}

interface ExternalActionApprovalProps {
  request: ExternalActionApprovalRequest;
  onRespond: (request: ExternalActionApprovalRequest, approved: boolean) => void;
}

export function ExternalActionApproval({ request, onRespond }: ExternalActionApprovalProps) {
  const headingId = useId();
  const metadata = [
    ["Connector", request.connector],
    ["Workspace", request.workspace],
    ["Tool", request.toolName],
    ["Target", request.target],
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);

  return (
    <article
      data-testid="external-action-approval"
      data-approval-kind="external-action"
      aria-labelledby={headingId}
      className="rounded-lg border border-amber-700/70 bg-amber-950/35 p-3 text-amber-50 shadow-lg shadow-amber-950/20"
    >
      <p
        data-testid="external-action-arrival-announcement"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
      >
        Review required: an external action approval arrived. No action has been approved.
      </p>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 id={headingId} className="text-[10px] font-semibold uppercase tracking-wider text-amber-300">
            External action approval required
          </h2>
          <p className="mt-1 text-xs text-amber-100/80">
            Review the exact action below. Approval applies only to this request.
          </p>
        </div>
        <span className="shrink-0 rounded border border-amber-700/60 bg-amber-900/40 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-200">
          Write
        </span>
      </div>

      <dl className="mb-3 grid gap-2 text-xs sm:grid-cols-2">
        {metadata.map(([label, value]) => (
          <div key={label} className="min-w-0 rounded border border-amber-900/60 bg-neutral-950/35 px-2 py-1.5">
            <dt className="text-[10px] uppercase tracking-wide text-amber-400/80">{label}</dt>
            <dd className="mt-0.5 break-words font-mono text-amber-50">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mb-3">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-400/80">
          Full action summary
        </div>
        <pre
          data-testid="external-action-summary"
          aria-label="Full action summary"
          className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-amber-900/70 bg-neutral-950/70 p-2 font-mono text-xs leading-relaxed text-amber-50"
        >
          {request.summary}
        </pre>
      </div>

      {request.responseError && (
        <div className="mb-2 text-xs text-amber-200" role="status" aria-live="polite" aria-atomic="true">
          {request.responseError}
        </div>
      )}
      {request.submitting && (
        <div className="mb-2 text-xs text-amber-200" role="status" aria-live="polite" aria-atomic="true">
          Waiting for acknowledgement…
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          disabled={request.submitting}
          onClick={() => onRespond(request, false)}
          className="rounded border border-amber-700 bg-neutral-950/60 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-950 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Deny
        </button>
        <button
          type="button"
          disabled={request.submitting}
          onClick={() => onRespond(request, true)}
          className="rounded border border-amber-500 bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Approve
        </button>
      </div>
    </article>
  );
}
