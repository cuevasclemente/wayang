import { useId } from "react";

export type ExternalActionApprovalStatus =
  | "pending"
  | "awaiting_ack"
  | "approved"
  | "denied"
  | "timeout"
  | "cancelled"
  | "stale"
  | "unknown"
  | "rejected"
  | "uncertain";

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
  status: ExternalActionApprovalStatus;
  live: boolean;
  lastSentAt?: number;
  retryAt?: number;
  responseError?: string;
  /** Internal-only fail-closed marker; never accepted from WebSocket data. */
  immutableCollision?: true;
  /** Internal-only retention recency; never accepted from WebSocket data. */
  retentionTouchedAt?: number;
}

interface ExternalActionApprovalProps {
  request: ExternalActionApprovalRequest;
  interactionEnabled: boolean;
  onRespond: (request: ExternalActionApprovalRequest, approved: boolean, trigger: HTMLButtonElement) => void;
  onDismiss: (request: ExternalActionApprovalRequest) => void;
}

const STATUS_COPY: Record<ExternalActionApprovalStatus, string> = {
  pending: "No response has been sent.",
  awaiting_ack: "Waiting for the server to acknowledge this response…",
  approved: "Wayang confirmed approval for this exact request and argument hash.",
  denied: "This action was not approved.",
  timeout: "This approval request expired without approval.",
  cancelled: "This action was not approved.",
  stale: "The server no longer recognizes this exact pending request; approval was not confirmed.",
  unknown: "The authoritative pending snapshot no longer contains this request, so success cannot be inferred.",
  rejected: "The server did not accept the response; review the status before trying again.",
  uncertain: "No acknowledgement arrived; the request may still be live. Review carefully before trying again.",
};

const STATUS_LABELS: Record<ExternalActionApprovalStatus, string> = {
  pending: "Pending review",
  awaiting_ack: "Awaiting acknowledgement",
  approved: "Approved",
  denied: "Denied",
  timeout: "Timed out",
  cancelled: "Cancelled",
  stale: "Stale",
  unknown: "Unknown outcome",
  rejected: "Rejected",
  uncertain: "Uncertain outcome",
};

export function ExternalActionApproval({ request, interactionEnabled, onRespond, onDismiss }: ExternalActionApprovalProps) {
  const headingId = useId();
  const statusId = useId();
  const metadata = [
    ["Connector", request.connector],
    ["Workspace", request.workspace],
    ["Tool", request.toolName],
    ["Target", request.target],
    ["Request ID", request.requestId],
    ["Argument hash", request.argumentsHash],
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
  const responseControlsDisabled = !interactionEnabled || request.submitting || !request.live;
  const approvalDisabled = responseControlsDisabled || request.retryAt !== undefined;
  const canDismiss = !request.live;

  return (
    <article
      data-testid="external-action-approval"
      data-approval-kind="external-action"
      data-approval-request-id={request.requestId}
      data-approval-status={request.status}
      tabIndex={-1}
      aria-labelledby={headingId}
      aria-describedby={statusId}
      className="rounded-lg border border-amber-700/70 bg-amber-950/35 p-3 text-amber-50 shadow-lg shadow-amber-950/20"
    >
      {request.status === "pending" && (
        <p
          data-testid="external-action-arrival-announcement"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className="sr-only"
        >
          Review required: an external action approval arrived. No action has been approved.
        </p>
      )}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 id={headingId} className="text-[10px] font-semibold uppercase tracking-wider text-amber-300">
            {request.live ? "External action approval required" : "External action outcome"}
          </h2>
          <p className="mt-1 text-xs text-amber-100/80">
            {request.live
              ? interactionEnabled
                ? "Review the connector-provided preview below. Wayang binds approval to every displayed immutable request field; approval requires your identity PIN."
                : "This preview is retained for review, but responses are disabled until this exact session selection is connected, loaded, and authoritatively synchronized."
              : "This retained card records the outcome visible to this browser. Dismiss it when you have finished reviewing it."}
          </p>
        </div>
        <span className="shrink-0 rounded border border-amber-700/60 bg-amber-900/40 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-200">
          External action
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
          Connector-provided action summary (unverified by Wayang)
        </div>
        <pre
          data-testid="external-action-summary"
          aria-label="Full action summary"
          className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-amber-900/70 bg-neutral-950/70 p-2 font-mono text-xs leading-relaxed text-amber-50"
        >
          {request.summary}
        </pre>
      </div>

      <div
        id={statusId}
        data-testid="external-action-status"
        className="mb-2 rounded border border-amber-900/60 bg-neutral-950/35 px-2 py-1.5 text-xs text-amber-100"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="font-semibold">{STATUS_LABELS[request.status]}.</span>{" "}
        {STATUS_COPY[request.status]}
        {request.responseError ? ` ${request.responseError}` : ""}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          disabled={responseControlsDisabled}
          onClick={(event) => onRespond(request, false, event.currentTarget)}
          className="rounded border border-amber-700 bg-neutral-950/60 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-950 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Deny
        </button>
        <button
          type="button"
          disabled={approvalDisabled}
          onClick={(event) => onRespond(request, true, event.currentTarget)}
          className="rounded border border-amber-500 bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {request.live && request.status !== "pending" ? "Approve with PIN again" : "Approve"}
        </button>
        {canDismiss && (
          <button
            type="button"
            onClick={() => onDismiss(request)}
            className="rounded border border-neutral-700 bg-neutral-950/60 px-3 py-1.5 text-xs font-semibold text-neutral-200 hover:bg-neutral-800"
          >
            Dismiss
          </button>
        )}
      </div>
    </article>
  );
}
