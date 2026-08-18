import * as fs from "node:fs";
import {
  beginTranscriptMutationSearchFence,
  endTranscriptMutationSearchFence,
  indexSession,
  removeSession as removeSearchSession,
} from "./search/indexer.js";
import { getSessionById } from "./sessions.js";
import { invalidateSessionFileSnapshot } from "./pi-bridge.js";
import { reconcileTranscriptMetadataAfterMutation } from "./transcript-mutations.js";
import {
  clearTranscriptRecoveryMarker,
  listTranscriptRecoveryMarkers,
  unlinkRecoveryTranscriptIfPresent,
} from "./transcript-recovery-journal.js";

export interface TranscriptRecoverySummary {
  recovered: number;
  pending: number;
}

async function recoverEventReconcile(marker: ReturnType<typeof listTranscriptRecoveryMarkers>[number]): Promise<boolean> {
  let searchFenced = false;
  try {
    beginTranscriptMutationSearchFence(marker.session_id);
    searchFenced = true;
    const session = getSessionById(marker.session_id);
    if (!session?.pi_session_file || !fs.existsSync(marker.pi_session_file)
      || fs.realpathSync.native(session.pi_session_file) !== marker.pi_session_file) {
      throw new Error("Event recovery transcript binding is unavailable");
    }
    invalidateSessionFileSnapshot(marker.pi_session_file);
    await reconcileTranscriptMetadataAfterMutation(marker.session_id);
    endTranscriptMutationSearchFence(marker.session_id);
    searchFenced = false;
    const indexed = await indexSession(marker.session_id, {
      force: true,
      recoveryMarkerId: marker.id,
    });
    if (indexed.error || indexed.mutationFenced) throw new Error("Event recovery search reindex failed");
    if (!clearTranscriptRecoveryMarker(marker.id)) throw new Error("Event recovery marker could not be cleared");
    return true;
  } catch {
    if (!searchFenced) {
      try { beginTranscriptMutationSearchFence(marker.session_id); searchFenced = true; }
      catch { /* an existing fence is already denial */ }
    }
    return false;
  }
}

async function recoverSessionDelete(marker: ReturnType<typeof listTranscriptRecoveryMarkers>[number]): Promise<boolean> {
  try {
    await removeSearchSession(marker.session_id);
    if (getSessionById(marker.session_id)) throw new Error("Deleted session row unexpectedly exists");
    unlinkRecoveryTranscriptIfPresent(marker.pi_session_file);
    if (!clearTranscriptRecoveryMarker(marker.id)) throw new Error("Session-delete recovery marker could not be cleared");
    return true;
  } catch {
    return false;
  }
}

/**
 * Run after store load and before ordinary catalog/search watchers. Failures
 * remain durable and deny indexing/import until the next startup attempt.
 */
export async function recoverTranscriptRecoveryJournal(): Promise<TranscriptRecoverySummary> {
  let recovered = 0;
  for (const marker of listTranscriptRecoveryMarkers()) {
    const ok = marker.kind === "event_reconcile"
      ? await recoverEventReconcile(marker)
      : await recoverSessionDelete(marker);
    if (ok) recovered++;
  }
  return {
    recovered,
    pending: listTranscriptRecoveryMarkers().length,
  };
}
