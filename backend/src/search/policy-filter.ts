import type { SessionRow } from "../db.js";
import { authorizeProjectAction } from "../policy.js";
import { isLegacyPrivateSessionQuarantined, listSessions } from "../sessions.js";

/** Current per-session index authorization; unknown or stale references deny. */
export function isSessionIndexable(session: SessionRow): boolean {
  // Deny from durable metadata before policy evaluation or JSONL/index access.
  if (isLegacyPrivateSessionQuarantined(session)) return false;
  return authorizeProjectAction({
    cwd: session.cwd,
    actor: "indexer",
    agentProfileId: session.agent_profile_id ?? null,
  }).allowed;
}

export function listIndexableSessions(): SessionRow[] {
  return listSessions(true).filter(isSessionIndexable);
}

export function getIndexableSessionIds(): Set<string> {
  return new Set(listIndexableSessions().map((session) => session.id));
}
