import type { SessionRow } from "../db.js";
import { authorizeProjectAction } from "../policy.js";
import { isLegacyPrivateSessionQuarantined, listSessions } from "../sessions.js";
import { authorizeExactStandardTranscript } from "../standard-transcript-authorization.js";
import { eventRecoveryMarkerForSession } from "../transcript-recovery-journal.js";
import type { FileFingerprint } from "../session-metadata.js";

export interface SessionIndexAuthorization {
  session: SessionRow;
  /** Fresh exact-file witness; null permits metadata only, never old body text. */
  transcript: { path: string; fingerprint: FileFingerprint } | null;
}

/** Current per-session index authorization; unknown or stale references deny.
 * Keep the exact-file observation so search need not authorize the same file twice.
 */
export function getSessionIndexAuthorization(
  session: SessionRow,
  options: { recoveryMarkerId?: string } = {},
): SessionIndexAuthorization | null {
  // Deny from durable metadata before policy evaluation or JSONL/index access.
  if (isLegacyPrivateSessionQuarantined(session)) return null;
  const recovery = eventRecoveryMarkerForSession(session.id);
  if (recovery && recovery.id !== options.recoveryMarkerId) return null;
  const policy = authorizeProjectAction({
    cwd: session.cwd,
    actor: "indexer",
    agentProfileId: session.agent_profile_id ?? null,
  });
  if (!policy.allowed) return null;
  if (!session.pi_session_file) return { session, transcript: null };
  const exact = authorizeExactStandardTranscript(session.pi_session_file, { expectedSessionId: session.id });
  return exact ? { session, transcript: { path: exact.path, fingerprint: { ...exact.fingerprint } } } : null;
}

/** Preserve the existing boolean contract for indexing and other callers. */
export function isSessionIndexable(session: SessionRow, options: { recoveryMarkerId?: string } = {}): boolean {
  return getSessionIndexAuthorization(session, options) !== null;
}

export function listIndexableSessionAuthorizations(): SessionIndexAuthorization[] {
  return listSessions(true).flatMap((session) => {
    const authorization = getSessionIndexAuthorization(session);
    return authorization ? [authorization] : [];
  });
}

export function listIndexableSessions(): SessionRow[] {
  return listIndexableSessionAuthorizations().map(({ session }) => session);
}

export function getIndexableSessionIds(): Set<string> {
  return new Set(listIndexableSessions().map((session) => session.id));
}
