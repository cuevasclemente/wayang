/** Main-thread prepare/release boundary: exact authorization, never transcript body reads. */
import { buildProjectPolicyProjection, getPolicyGeneration } from "../policy.js";
import { getSearchDb, getSearchDbPath } from "./db.js";
import { listIndexableSessionAuthorizations } from "./policy-filter.js";
import { authorizeSearchQueryBodies, getVisibleBodySessionIds, type SearchQueryAuthorization } from "./query-authorization.js";
import { getPublishedSearchRevision, SEARCH_EXTRACTION_VERSION } from "./revision.js";
import { boundedSnapshotDigest, queryDatabaseSnapshot } from "./query-snapshot.js";
import { QUERY_WORKER_BUDGETS, type QueryWorkerRequest } from "./query-worker-protocol.js";
import { SearchQueryError, type ParsedSearchQuery } from "./query-parser.js";
import type { SearchFilters } from "./types.js";
import type { SessionIndexAuthorization } from "./policy-filter.js";
import type { Database } from "better-sqlite3";

type Presentation = { session_id: string; cwd: string; title: string; goal: string | null; model: string | null;
  last_active: number; archived: number; has_error: number };

/** Suppress stale searchable/filter metadata per session, never poison the whole query.
 * Recency is intentionally last-indexed: last_active-only drift remains searchable,
 * and both ranking and since/until filters consistently use that indexed timestamp.
 */
function rejectedPresentationSessionIds(db: Database, observations: SessionIndexAuthorization[], bodyIds: Set<string>): Set<string> {
  const expected = new Map(observations.map(observation => [observation.session.id, observation.session]));
  const ids = JSON.stringify([...expected.keys()]);
  const found = new Set<string>();
  const rejected = new Set<string>();
  const check = (projection: Presentation) => {
    const row = expected.get(projection.session_id)!;
    if (projection.cwd !== row.cwd || projection.title !== (row.title || "(untitled)") || projection.goal !== row.goal
      || projection.model !== row.model
      || projection.archived !== (row.archived ? 1 : 0) || projection.has_error !== (row.error ? 1 : 0)) {
      rejected.add(row.id);
    }
    found.add(row.id);
  };
  for (const row of db.prepare(`SELECT session_id,cwd,title,goal,model,last_active,archived,has_error
    FROM search_session_metadata WHERE session_id IN (SELECT value FROM json_each(?))`).iterate(ids)) check(row as Presentation);
  for (const id of bodyIds) if (!found.has(id)) rejected.add(id);
  // Legacy metadata is the sole exception to requiring a current metadata row;
  // its actual searchable presentation must still agree with current metadata.
  for (const row of db.prepare(`SELECT session_id,cwd,title,goal,model,last_active,archived,has_error
    FROM search_chunks_current WHERE role='meta' AND session_id IN (SELECT value FROM json_each(?))
      AND session_id NOT IN (SELECT session_id FROM search_session_metadata)`).iterate(ids)) check(row as Presentation);
  return rejected;
}

export interface PreparedSearchQuery {
  request: QueryWorkerRequest;
  authorization: SearchQueryAuthorization;
  /** Full exact-authorized catalog for status, before metadata admission exclusions. */
  eligibleSessionIds: string[];
  /** Internal IDs only; the response exposes an aggregate count. */
  rejectedMetadataSessionIds: string[];
  releaseSnapshot: string;
}
export function prepareSearchQuery(parsed: ParsedSearchQuery, filters: SearchFilters): PreparedSearchQuery {
  try {
    const policyGeneration = getPolicyGeneration();
    const allowedCwds = buildProjectPolicyProjection().projects.filter(project => project.global_index)
      .map(project => project.cwd).sort();
    const observed = listIndexableSessionAuthorizations().sort((a, b) => a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0);
    if (observed.length > QUERY_WORKER_BUDGETS.authorizedSessions || allowedCwds.length > QUERY_WORKER_BUDGETS.authorizedSessions) {
      throw new SearchQueryError("search_request_too_large");
    }
    const ids = observed.map(({ session }) => session.id);
    const db = ids.length && allowedCwds.length ? getSearchDb() : null;
    const authorization: SearchQueryAuthorization = db ? authorizeSearchQueryBodies(observed, id => getPublishedSearchRevision(db, id),
      SEARCH_EXTRACTION_VERSION, getVisibleBodySessionIds(db, ids))
      : { metadataSessionIds: ids, bodies: [], rejectedBodySessionIds: [] };
    const rejectedMetadata = db ? rejectedPresentationSessionIds(db, observed,
      new Set(authorization.bodies.map(body => body.sessionId))) : new Set<string>();
    // Apply exclusion to admission, BEFORE worker coverage/ranking/facets/limits.
    // Keep independent body-rejection evidence; these counts are not a partition.
    authorization.metadataSessionIds = ids.filter(id => !rejectedMetadata.has(id));
    authorization.bodies = authorization.bodies.filter(body => !rejectedMetadata.has(body.sessionId));
    const rejectedMetadataSessionIds = [...rejectedMetadata].sort();
    const databaseSnapshot = db ? queryDatabaseSnapshot(db, authorization.metadataSessionIds)
      : boundedSnapshotDigest(["no-authorized-database-query"]);
    // Hash search authority, not transient runtime/catalog fields or live recency.
    // Every phase still exact-authorizes the full eligible catalog. Body grant
    // transitions capture relevant file changes; already-denied bodies need not
    // invalidate unrelated results merely because their files keep growing.
    // Admitted DB metadata/documents remain attested. Excluded sessions are
    // represented by ID/authority and exclusion state, so new/deleted sessions
    // or an excluded->admitted transition still invalidate the entire response.
    const releaseSnapshot = boundedSnapshotDigest((function* () {
      yield ["query-release-v2", policyGeneration, allowedCwds, filters, databaseSnapshot];
      for (const { session } of observed) yield [session.id, session.cwd, session.project_id ?? null,
        session.agent_profile_id ?? null];
      yield authorization;
      yield rejectedMetadataSessionIds;
    })());
    if (getPolicyGeneration() !== policyGeneration) throw new SearchQueryError("search_changed");
    return { authorization, eligibleSessionIds: ids, rejectedMetadataSessionIds, releaseSnapshot,
      request: { dbPath: getSearchDbPath(), parsed, filters, metadataSessionIds: authorization.metadataSessionIds,
        allowedCwds, bodies: authorization.bodies, databaseSnapshot } };
  } catch (error) {
    if (error instanceof SearchQueryError) throw error;
    throw new SearchQueryError("search_unavailable");
  }
}
