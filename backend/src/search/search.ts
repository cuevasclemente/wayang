/** Authorized session-wide optional-unit keyword search. */
import { buildProjectPolicyProjection } from "../policy.js";
import { getSearchDb } from "./db.js";
import { listIndexableSessions } from "./policy-filter.js";
import { getSearchStatus } from "./status.js";
import { parseSearchQuery, SearchQueryError } from "./query-parser.js";
import { queryKeywordSessions, sanitizeSnippet } from "./query-sql.js";
import type { SearchFilters, SearchResponse, SearchResult } from "./types.js";

export { buildFtsExpression, SearchQueryError } from "./query-parser.js";
export { sanitizeSnippet } from "./query-sql.js";

export function runSearch(query: string, filters: SearchFilters = {}): SearchResponse {
  const start = performance.now();
  // Parse BEFORE trimming/short-query handling: never silently truncate or hide
  // malformed/over-limit input behind an ordinary successful empty response.
  const parsed = parseSearchQuery(query);
  const trimmed = query.trim();
  if (trimmed.length < 2 || !parsed.match) return emptyResponse(trimmed, start);

  let matched: ReturnType<typeof queryKeywordSessions>;
  let status: Pick<SearchResponse, "coverage" | "degraded">;
  try {
    // Exact query-time authorization is independent of physical purge success.
    // Catalog visibility alone does not authorize search content or facets.
    const allowedCwds = buildProjectPolicyProjection().projects
      .filter((project) => project.global_index).map((project) => project.cwd);
    const allowedSessionIds = listIndexableSessions().map((session) => session.id);
    status = getSearchStatus(allowedSessionIds);
    if (!allowedCwds.length || !allowedSessionIds.length) return { ...emptyResponse(trimmed, start), ...status };
    matched = queryKeywordSessions(getSearchDb(), parsed, allowedSessionIds, allowedCwds, filters);
  } catch {
    throw new SearchQueryError("search_unavailable");
  }

  const results: SearchResult[] = matched.rows.map((row, index) => ({
    session_id: row.session_id,
    title: row.title,
    cwd: row.cwd,
    model: row.model,
    last_active: row.last_active,
    archived: !!row.archived,
    best_role: row.role,
    best_message_id: row.message_id,
    best_message_active: Boolean(row.message_id && row.active_branch),
    best_transcript_epoch: row.transcript_epoch,
    best_anchor_status: row.message_id && row.active_branch ? "active" : "unavailable",
    // Coverage dominates; fractional rank preserves the SQL lexical/recency/ID
    // ordering without letting repeated chunk hits become extra matching units.
    score: row.coverage + 1 / (60 + index + 1),
    snippet_html: sanitizeSnippet(row.snippet),
  }));
  return {
    ...emptyResponse(trimmed, start),
    ...status,
    results,
    facets: matched.facets,
  };
}

function emptyResponse(q: string, startedAt: number): SearchResponse {
  return {
    query: q,
    took_ms: Math.round((performance.now() - startedAt) * 10) / 10,
    results: [],
    facets: { cwds: [], models: [] },
    ...getSearchStatus(),
  };
}
