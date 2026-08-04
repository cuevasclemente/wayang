import type { StoreData } from "../db.js";
import { WorkspaceStoreError } from "../workspace-types.js";
import type { ProtectedAutomationJobRow } from "./types.js";

function nextRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER - 1) {
    throw new WorkspaceStoreError("Protected automation job revision is exhausted", 409);
  }
  return value + 1;
}

function blockedReason(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")
    || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value, "utf8") > 256) {
    throw new WorkspaceStoreError("blocked_reason is invalid or exceeds its compiled bound");
  }
  return value;
}

function finiteTimestamp(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new WorkspaceStoreError("block time must be a nonnegative finite timestamp");
  }
  return value;
}

/**
 * Denial-only draft helper shared by policy, profile, and explicit capability
 * revocation transactions. It has no store singleton or capability imports, so
 * callers can compose denial into one durable commit without an import cycle.
 */
export function blockProtectedAutomationJobsDraft(
  draft: StoreData,
  predicate: (row: ProtectedAutomationJobRow) => boolean,
  reason: string,
  now = Date.now(),
  forceRevision = false,
): ProtectedAutomationJobRow[] {
  const reasonValue = blockedReason(reason);
  const timestamp = finiteTimestamp(now);
  const changed: ProtectedAutomationJobRow[] = [];
  for (const row of draft.protectedAutomationJobs) {
    if (row.deleted_at !== null || !predicate(row)) continue;
    if (!forceRevision && !row.enabled && row.blocked_reason === reasonValue && row.next_run_at === null) continue;
    row.revision = nextRevision(row.revision);
    row.enabled = false;
    row.blocked_reason = reasonValue;
    row.updated_at = Math.max(timestamp, row.updated_at, row.created_at);
    row.next_run_at = null;
    for (const run of draft.protectedAutomationRuns) {
      if (run.job_id === row.id && run.status === "queued") {
        run.status = "cancelled";
        run.finished_at = Math.max(timestamp, run.started_at);
        run.outcome_code = "authority_blocked";
        run.exit_code = null;
      }
    }
    changed.push({ ...row, argv: [...row.argv], allowed_https_origins: [...row.allowed_https_origins] });
  }
  return changed;
}
