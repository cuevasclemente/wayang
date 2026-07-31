import { canonicalizeProjectCwd } from "../projects.js";
import { getSessionById } from "../sessions.js";
import { WorkspaceStoreError } from "../workspace-types.js";
import type { BrowserPersistence, BrowserSessionLookup } from "./types.js";

export interface ResolvedBrowserSessionLookup {
  sessionId: string | null;
  projectCwd: string;
  persistence: BrowserPersistence;
}

/**
 * Resolve the durable browser target before authorization or runtime lookup.
 * A session id may never be combined with a different project, even if both
 * projects would otherwise be authorized for the caller.
 */
export function resolveBrowserSessionLookup(lookup: BrowserSessionLookup): ResolvedBrowserSessionLookup {
  const sessionId = typeof lookup.sessionId === "string" && lookup.sessionId.trim()
    ? lookup.sessionId.trim()
    : null;
  const persistence = lookup.persistence ?? "shared";
  const requestedProjectCwd = typeof lookup.projectCwd === "string" && lookup.projectCwd.trim()
    ? canonicalizeProjectCwd(lookup.projectCwd)
    : null;

  if (sessionId) {
    const session = getSessionById(sessionId);
    if (!session) throw new WorkspaceStoreError("Browser session was not found", 404);
    const durableProjectCwd = canonicalizeProjectCwd(session.cwd);
    if (requestedProjectCwd && requestedProjectCwd !== durableProjectCwd) {
      throw new WorkspaceStoreError("Browser session project does not match the durable session cwd", 409);
    }
    return { sessionId, projectCwd: durableProjectCwd, persistence };
  }

  if (requestedProjectCwd) return { sessionId: null, projectCwd: requestedProjectCwd, persistence };
  throw new WorkspaceStoreError("sessionId or projectCwd is required");
}
