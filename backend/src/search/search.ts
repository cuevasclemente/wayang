/**
 * search/search.ts — Query the chunks/chunks_fts indices.
 *
 * v1: BM25 keyword only. M3 adds a hybrid path via reciprocal-rank fusion.
 */

import { buildProjectPolicyProjection } from "../policy.js";
import { getSearchDb } from "./db.js";
import { listIndexableSessions } from "./policy-filter.js";
import { getWatcherStatus } from "./watcher.js";
import type {
  SearchFacets,
  SearchFilters,
  SearchResponse,
  SearchResult,
  ChunkRole,
} from "./types.js";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const PER_CHUNK_HIT_LIMIT = 200; // sample size before per-session aggregation

const MARK_OPEN = "\u0001MARK_OPEN\u0001";
const MARK_CLOSE = "\u0001MARK_CLOSE\u0001";

interface FtsRow {
  id: number;
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
  bm25: number;
}

export function runSearch(query: string, filters: SearchFilters = {}): SearchResponse {
  const start = performance.now();
  const trimmed = (query || "").trim();
  const limit = Math.max(1, Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

  if (trimmed.length < 2) {
    return emptyResponse(trimmed, start);
  }

  const ftsExpr = buildFtsExpression(trimmed);
  if (!ftsExpr) {
    return emptyResponse(trimmed, start);
  }

  // Query-time filtering is independent of purge success. Only currently
  // registered projects whose projection permits global indexing can
  // contribute snippets, results, or facets.
  const allowedCwds = buildProjectPolicyProjection().projects
    .filter((project) => project.global_index)
    .map((project) => project.cwd);
  const allowedSessionIds = listIndexableSessions().map((session) => session.id);
  if (allowedCwds.length === 0 || allowedSessionIds.length === 0) return emptyResponse(trimmed, start);

  const db = getSearchDb();
  const where: string[] = ["chunks_fts MATCH @match"];
  const params: Record<string, unknown> = {
    match: ftsExpr,
    policy_session_ids: JSON.stringify(allowedSessionIds),
  };
  // JSON1 avoids SQLite's host-parameter limit for larger session catalogs.
  where.push("c.session_id IN (SELECT value FROM json_each(@policy_session_ids))");
  const policyPlaceholders = allowedCwds.map((cwd, index) => {
    const key = `policy_cwd_${index}`;
    params[key] = cwd;
    return `@${key}`;
  });
  where.push(`c.cwd IN (${policyPlaceholders.join(", ")})`);

  // archived: false (default), true, any
  const archived = filters.archived ?? "false";
  if (archived === "false") where.push("c.archived = 0");
  else if (archived === "true") where.push("c.archived = 1");

  if (filters.cwd) {
    where.push("c.cwd = @cwd");
    params.cwd = filters.cwd;
  }
  if (filters.model) {
    where.push("c.model = @model");
    params.model = filters.model;
  }
  if (typeof filters.since === "number") {
    where.push("c.last_active >= @since");
    params.since = filters.since;
  }
  if (typeof filters.until === "number") {
    where.push("c.last_active <= @until");
    params.until = filters.until;
  }
  if (filters.has_goal === true) where.push("(c.goal IS NOT NULL AND c.goal <> '')");
  if (filters.has_goal === false) where.push("(c.goal IS NULL OR c.goal = '')");
  if (filters.has_error === true) where.push("c.has_error = 1");
  if (filters.has_error === false) where.push("c.has_error = 0");

  const whereSql = where.join(" AND ");

  const sql = `
    SELECT
      c.id,
      c.session_id,
      c.cwd,
      c.title,
      c.model,
      c.last_active,
      c.archived,
      c.role,
      c.message_id,
      c.transcript_epoch,
      c.active_branch,
      snippet(chunks_fts, 0, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 16) AS snippet,
      bm25(chunks_fts) AS bm25
    FROM chunks_fts
    JOIN chunks AS c ON c.id = chunks_fts.rowid
    WHERE ${whereSql}
    ORDER BY bm25 ASC
    LIMIT ${PER_CHUNK_HIT_LIMIT}
  `;

  let rows: FtsRow[];
  try {
    rows = db.prepare(sql).all(params) as FtsRow[];
  } catch (err) {
    console.error("[search] FTS query failed:", err, { ftsExpr });
    return emptyResponse(trimmed, start);
  }

  // Aggregate per session: keep the best (lowest bm25) chunk per session.
  type PerSession = SearchResult & { _rank: number; _bm25: number };
  const bySession = new Map<string, PerSession>();
  rows.forEach((row, index) => {
    const existing = bySession.get(row.session_id);
    if (existing && existing._rank <= index) return;
    bySession.set(row.session_id, {
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
      // RRF-shaped single-leg score for now; M3 will fuse with semantic leg.
      score: 1 / (60 + index + 1),
      snippet_html: sanitizeSnippet(row.snippet),
      _rank: index,
      _bm25: row.bm25,
    });
  });

  const aggregated = [...bySession.values()].sort(
    (a, b) => b.score - a.score || b.last_active - a.last_active,
  );

  // Strip internal fields.
  const results: SearchResult[] = aggregated.slice(0, limit).map((r) => ({
    session_id: r.session_id,
    title: r.title,
    cwd: r.cwd,
    model: r.model,
    last_active: r.last_active,
    archived: r.archived,
    score: r.score,
    best_role: r.best_role,
    snippet_html: r.snippet_html,
    best_message_id: r.best_message_id,
    best_message_active: r.best_message_active,
    best_transcript_epoch: r.best_transcript_epoch,
    best_anchor_status: r.best_anchor_status,
  }));

  const facets = buildFacets(aggregated);

  const took = performance.now() - start;
  const watcher = getWatcherStatus();
  const degraded =
    !watcher.backfillDone && watcher.backfillRunning ? ("indexing_in_progress" as const) : undefined;

  return {
    query: trimmed,
    took_ms: Math.round(took * 10) / 10,
    results,
    facets,
    degraded,
  };
}

function emptyResponse(q: string, startedAt: number): SearchResponse {
  const watcher = getWatcherStatus();
  const degraded =
    !watcher.backfillDone && watcher.backfillRunning ? ("indexing_in_progress" as const) : undefined;
  return {
    query: q,
    took_ms: Math.round((performance.now() - startedAt) * 10) / 10,
    results: [],
    facets: { cwds: [], models: [] },
    degraded,
  };
}

function buildFacets(rows: SearchResult[]): SearchFacets {
  const cwds = new Map<string, number>();
  const models = new Map<string, number>();
  for (const r of rows) {
    cwds.set(r.cwd, (cwds.get(r.cwd) ?? 0) + 1);
    if (r.model) models.set(r.model, (models.get(r.model) ?? 0) + 1);
  }
  return {
    cwds: [...cwds.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count),
    models: [...models.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * Build an FTS5 MATCH expression from a free-form user query.
 *
 * Strategy: split on whitespace, drop tokens with FTS-special characters,
 * quote each surviving token, and combine with AND (implicit). Adding `*` to
 * the last token makes it a prefix match so partial typing is friendly.
 *
 * Returns null if no usable tokens remain.
 */
export function buildFtsExpression(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map(sanitizeToken)
    .filter((t): t is string => !!t);
  if (tokens.length === 0) return null;
  const quoted = tokens.map((t, idx) => {
    const isLast = idx === tokens.length - 1;
    // Prefix-match the last token, but only if it's long enough to be useful.
    if (isLast && t.length >= 3) return `"${t}"*`;
    return `"${t}"`;
  });
  return quoted.join(" ");
}

function sanitizeToken(t: string): string | null {
  // Strip FTS5 syntax characters and quotes; if nothing remains, drop the token.
  const cleaned = t.replace(/["()*:\-]/g, " ").trim();
  if (!cleaned) return null;
  // Limit token length to defang pathological inputs.
  return cleaned.slice(0, 64);
}

/**
 * Sanitize an FTS5 snippet into an HTML-safe string with only `<mark>` tags
 * and `<br>` for line breaks (per spec §13.4 of the plan).
 */
export function sanitizeSnippet(raw: string): string {
  if (!raw) return "";
  // Escape HTML special chars first.
  let escaped = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  // Re-introduce the marker tokens as <mark>.
  escaped = escaped
    .replaceAll(MARK_OPEN, "<mark>")
    .replaceAll(MARK_CLOSE, "</mark>");
  // Preserve newlines.
  escaped = escaped.replace(/\r\n|\n|\r/g, "<br>");
  return escaped;
}
