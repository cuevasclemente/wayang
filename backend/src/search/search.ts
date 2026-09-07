/** Authorized session-wide optional-unit keyword search. */
import { buildProjectPolicyProjection } from "../policy.js";
import { getSearchDb } from "./db.js";
import { listIndexableSessionAuthorizations } from "./policy-filter.js";
import { getSearchStatus } from "./status.js";
import { authorizeSearchQueryBodies, getVisibleBodySessionIds, type SearchQueryAuthorization } from "./query-authorization.js";
import { getPublishedSearchRevision, SEARCH_EXTRACTION_VERSION } from "./revision.js";
import { prepareSearchQuery } from "./query-prepare.js";
import { executeRevalidatedSearch } from "./query-release.js";
import { getSearchQueryPool } from "./query-worker-client.js";
import { parseSearchQuery, SearchQueryError } from "./query-parser.js";
import { queryKeywordSessions, sanitizeSnippet } from "./query-sql.js";
import type { SearchFilters, SearchResponse, SearchResult } from "./types.js";

export { buildFtsExpression, SearchQueryError } from "./query-parser.js";
export { sanitizeSnippet } from "./query-sql.js";

export function runSearch(query: string, filters: SearchFilters = {}): SearchResponse {
  const start = performance.now();
  const parsed = parseSearchQuery(query);
  const trimmed = query.trim();
  if (trimmed.length < 2 || !parsed.match) return emptyResponse(trimmed, start);

  let matched: ReturnType<typeof queryKeywordSessions>;
  let status: Pick<SearchResponse, "coverage" | "degraded">;
  let authorization: SearchQueryAuthorization;
  try {
    const allowedCwds = buildProjectPolicyProjection().projects
      .filter((project) => project.global_index).map((project) => project.cwd);
    const observed = listIndexableSessionAuthorizations();
    const allowedSessionIds = observed.map(({ session }) => session.id);
    status = getSearchStatus(allowedSessionIds);
    if (!allowedCwds.length || !allowedSessionIds.length) return { ...emptyResponse(trimmed, start), ...status };
    const db = getSearchDb();
    authorization = authorizeSearchQueryBodies(observed, id => getPublishedSearchRevision(db, id),
      SEARCH_EXTRACTION_VERSION, getVisibleBodySessionIds(db, allowedSessionIds));
    // No yield between exact file/publication observations and SQL admission.
    matched = queryKeywordSessions(db, parsed, authorization.metadataSessionIds, allowedCwds, filters, authorization.bodies);
  } catch {
    throw new SearchQueryError("search_unavailable");
  }

  return formatSearchResponse(trimmed, start, matched, authorization, status);
}

/** Lead may fold this aggregate into the shared response type during integration. */
export type AsyncSearchResponse = SearchResponse & { metadata_revision_rejected: number };

/** Production route API. Never release worker snippets/facets without full reauthorization. */
export async function runSearchAsync(query: string, filters: SearchFilters = {}, options: { signal?: AbortSignal } = {}): Promise<AsyncSearchResponse> {
  const start = performance.now();
  const pool = getSearchQueryPool();
  const epoch = pool.status().epoch;
  const guard = () => {
    pool.assertRunning(epoch);
    if (options.signal?.aborted) throw new SearchQueryError("search_cancelled");
  };
  guard();
  const parsed = parseSearchQuery(query);
  const trimmed = query.trim();
  if (trimmed.length < 2 || !parsed.match) return { ...emptyResponse(trimmed, start), metadata_revision_rejected: 0 };
  const stableFilters = { ...filters };
  const { prepared, result } = await executeRevalidatedSearch({
    prepare: () => prepareSearchQuery(parsed, stableFilters),
    execute: prepared => prepared.request.metadataSessionIds.length && prepared.request.allowedCwds.length
      ? pool.query(prepared.request, options.signal) : Promise.resolve({ rows: [], facets: { cwds: [], models: [] } }),
    guard,
    signal: options.signal,
  });
  guard();
  const response = formatSearchResponse(trimmed, start, result, prepared.authorization, getSearchStatus(prepared.eligibleSessionIds));
  if (prepared.rejectedMetadataSessionIds.length && !response.degraded) response.degraded = "index_incomplete";
  return { ...response, metadata_revision_rejected: prepared.rejectedMetadataSessionIds.length };
}

function formatSearchResponse(trimmed: string, start: number, matched: ReturnType<typeof queryKeywordSessions>, authorization: SearchQueryAuthorization,
  status: Pick<SearchResponse, "coverage" | "degraded">): SearchResponse {
  const results: SearchResult[] = matched.rows.map((row, index) => ({
    session_id: row.session_id, title: row.title, cwd: row.cwd, model: row.model,
    last_active: row.last_active, archived: !!row.archived,
    best_role: row.role, best_message_id: row.message_id,
    best_message_active: Boolean(row.message_id && row.active_branch),
    best_transcript_epoch: row.transcript_epoch,
    best_anchor_status: row.message_id && row.active_branch ? "active" : "unavailable",
    score: row.coverage + 1 / (60 + index + 1),
    snippet_html: sanitizeSnippet(row.snippet),
  }));
  // A fresh body-revision rejection supersedes last-observed completion, even
  // while background discovery is paused. Keep counts explicitly observational.
  if (authorization.rejectedBodySessionIds.length && !status.degraded) status.degraded = "index_incomplete";
  return { ...emptyResponse(trimmed, start), ...status, results, facets: matched.facets,
    body_revision_rejected: authorization.rejectedBodySessionIds.length };
}

function emptyResponse(q: string, startedAt: number): SearchResponse {
  return { query: q, took_ms: Math.round((performance.now() - startedAt) * 10) / 10,
    results: [], facets: { cwds: [], models: [] }, ...getSearchStatus() };
}
