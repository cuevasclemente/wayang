/** SQL-only session aggregation; imports no runtime config or private stores. */
import type { Database } from "better-sqlite3";
import type { ChunkRole, SearchFacets, SearchFilters } from "./types.js";
import { SearchQueryError, type ParsedSearchQuery } from "./query-parser.js";
import type { SearchBodyAuthorization } from "./query-authorization.js";

export const MARK_OPEN = "\u0001MARK_OPEN\u0001";
export const MARK_CLOSE = "\u0001MARK_CLOSE\u0001";

export interface KeywordSessionRow {
  session_id: string;
  cwd: string;
  title: string;
  model: string | null;
  last_active: number;
  archived: number;
  role: ChunkRole;
  message_id: string | null;
  transcript_epoch: string | null;
  active_branch: number;
  snippet: string;
  coverage: number;
  lexical: number;
}

/** Callers MUST supply fresh metadata IDs/project roots plus revision-bound body witnesses.
 * Omitting body witnesses fails closed to metadata-only results (including legacy metadata).
 */
export function queryKeywordSessions(
  db: Database,
  parsed: ParsedSearchQuery,
  allowedSessionIds: string[],
  allowedCwds: string[],
  filters: SearchFilters = {},
  bodyAuthorizations: readonly SearchBodyAuthorization[] = [],
): { rows: KeywordSessionRow[]; facets: SearchFacets } {
  if (!parsed.match || !allowedSessionIds.length || !allowedCwds.length) {
    return { rows: [], facets: { cwds: [], models: [] } };
  }
  const params: Record<string, string | number> = {
    match: parsed.match,
    policy_session_ids: JSON.stringify(allowedSessionIds),
    policy_cwds: JSON.stringify(allowedCwds),
    body_authorizations: JSON.stringify(bodyAuthorizations),
    limit: Number.isFinite(filters.limit) ? Math.max(1, Math.min(Math.floor(filters.limit!), 100)) : 30,
    mark_open: MARK_OPEN,
    mark_close: MARK_CLOSE,
  };
  const where = [
    "c.session_id IN (SELECT value FROM json_each(@policy_session_ids))",
    "c.cwd IN (SELECT value FROM json_each(@policy_cwds))",
    // This admission precedes every MATCH aggregation, snippet, facet and limit.
    // Current owner authorization alone must not admit legacy or stale bodies.
    `(c.role = 'meta' OR (c.role IN ('user', 'assistant') AND c.active_branch = 1
      AND c.message_id IS NOT NULL
      AND (c.session_id, c.generation, c.transcript_epoch) IN
        (SELECT session_id, generation, transcript_epoch FROM body_witnesses)))`,
  ];
  const archived = filters.archived ?? "false";
  if (archived === "false") where.push("c.archived = 0");
  else if (archived === "true") where.push("c.archived = 1");
  for (const key of ["cwd", "model"] as const) {
    if (filters[key]) { where.push(`c.${key} = @${key}`); params[key] = filters[key]!; }
  }
  if (typeof filters.since === "number") { where.push("c.last_active >= @since"); params.since = filters.since; }
  if (typeof filters.until === "number") { where.push("c.last_active <= @until"); params.until = filters.until; }
  if (filters.has_goal === true) where.push("(c.goal IS NOT NULL AND c.goal <> '')");
  if (filters.has_goal === false) where.push("(c.goal IS NULL OR c.goal = '')");
  if (filters.has_error === true) where.push("c.has_error = 1");
  if (filters.has_error === false) where.push("c.has_error = 0");

  // One bounded number of indexed MATCH scans, not a global top-N chunk sample.
  // Materialization evaluates FTS auxiliary functions in their valid cursor
  // context before GROUP BY/window operations. Only IDs/scores are staged here,
  // never transcript text/snippets for the full matching corpus.
  const legs = parsed.units.map((unit, index) => {
    params[`unit_${index}`] = unit.match;
    return `SELECT c.id, c.session_id, ${index} AS unit, bm25(chunks_fts, 1, 0, 0) AS lexical
      FROM chunks_fts JOIN search_chunks_current c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH @unit_${index} AND ${where.join(" AND ")}`;
  });
  // Coverage/lexical scores and facets still see ALL authorized matching hits.
  // The view overlays one current session metadata projection on every row;
  // metadata_id is only a cheap representative for those identical fields,
  // never the message anchor. Legacy body rows are already denied above.
  // Best-chunk aggregation/windowing is deferred until top sessions are known.
  // BM25 still uses shared-FTS corpus statistics, including unpublished rows;
  // visibility filtering does NOT provide staging-independent lexical ranking.
  const sql = `
    WITH body_witnesses AS MATERIALIZED (
      SELECT json_extract(value, '$.sessionId') AS session_id,
        json_extract(value, '$.generation') AS generation,
        json_extract(value, '$.transcriptEpoch') AS transcript_epoch
      FROM json_each(@body_authorizations)
    ),
    hits AS MATERIALIZED (${legs.join(" UNION ALL ")}),
    session_scores AS MATERIALIZED (
      SELECT session_id, COUNT(DISTINCT unit) AS coverage, MIN(lexical) AS lexical,
        MIN(id) AS metadata_id
      FROM hits GROUP BY session_id
    ),
    sessions AS MATERIALIZED (
      SELECT s.session_id, c.cwd, c.title, c.model, c.last_active, c.archived,
        s.coverage, s.lexical
      FROM session_scores s JOIN search_chunks_current c ON c.id = s.metadata_id
    ),
    top_sessions AS MATERIALIZED (
      SELECT * FROM sessions
      ORDER BY coverage DESC, lexical ASC, last_active DESC, session_id COLLATE BINARY ASC
      LIMIT @limit
    ),
    selected_hits AS MATERIALIZED (
      SELECT * FROM hits WHERE session_id IN (SELECT session_id FROM top_sessions)
    ),
    chunk_scores AS (
      SELECT id, session_id, COUNT(DISTINCT unit) AS coverage, MIN(lexical) AS lexical
      FROM selected_hits GROUP BY id, session_id
    ),
    ranked_chunks AS (
      SELECT id, session_id,
        ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY coverage DESC, lexical ASC, id ASC) AS position
      FROM chunk_scores
    )
    SELECT
      (SELECT json_group_array(json_object(
        'session_id', t.session_id, 'cwd', t.cwd, 'title', t.title, 'model', t.model,
        'last_active', t.last_active, 'archived', t.archived, 'role', t.role,
        'message_id', t.message_id, 'transcript_epoch', t.transcript_epoch,
        'active_branch', t.active_branch, 'coverage', t.coverage, 'lexical', t.lexical,
        'snippet', (SELECT snippet(chunks_fts, 0, @mark_open, @mark_close, '…', 16)
          FROM chunks_fts WHERE chunks_fts.rowid = t.id AND chunks_fts MATCH @match)
      )) FROM (
        SELECT s.*, c.id, c.role, c.message_id, c.transcript_epoch, c.active_branch
        FROM top_sessions s JOIN ranked_chunks r ON r.session_id = s.session_id AND r.position = 1
        JOIN search_chunks_current c ON c.id = r.id
        ORDER BY s.coverage DESC, s.lexical ASC, s.last_active DESC, s.session_id COLLATE BINARY ASC
      ) t) AS results_json,
      (SELECT json_group_array(json_object('value', cwd, 'count', n))
        FROM (SELECT cwd, COUNT(*) AS n FROM sessions GROUP BY cwd ORDER BY n DESC, cwd COLLATE BINARY ASC)) AS cwds_json,
      (SELECT json_group_array(json_object('value', model, 'count', n))
        FROM (SELECT model, COUNT(*) AS n FROM sessions WHERE model IS NOT NULL AND model <> ''
          GROUP BY model ORDER BY n DESC, model COLLATE BINARY ASC)) AS models_json
  `;
  try {
    const result = db.prepare(sql).get(params) as { results_json: string; cwds_json: string; models_json: string };
    return {
      rows: JSON.parse(result.results_json) as KeywordSessionRow[],
      facets: { cwds: JSON.parse(result.cwds_json), models: JSON.parse(result.models_json) },
    };
  } catch {
    // No raw query, SQLite diagnostic, database path, or transcript in logs/errors.
    throw new SearchQueryError("search_unavailable");
  }
}

/** Only backend-created mark delimiters and line breaks become HTML. */
export function sanitizeSnippet(raw: string): string {
  return (raw || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
    .replaceAll(MARK_OPEN, "<mark>").replaceAll(MARK_CLOSE, "</mark>")
    .replace(/\r\n|\n|\r/g, "<br>");
}
