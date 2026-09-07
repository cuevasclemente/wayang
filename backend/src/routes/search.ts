/**
 * routes/search.ts — Session history search API.
 *
 *   GET  /api/sessions/search
 *   GET  /api/sessions/search/health
 *   POST /api/sessions/search/reindex
 *
 * See docs/session-history-search.md for the response shape.
 */

import { Router, type Request, type Response } from "express";
import { listIndexableSessions } from "../search/policy-filter.js";
import {
  getWatcherStatus,
  indexSession,
  reindexAll,
  SCHEMA_VERSION,
} from "../search/index.js";
import type { SearchFilters } from "../search/index.js";
import { SearchQueryError } from "../search/query-parser.js";
import { runSearchAsync } from "../search/search.js";
import { getSearchStatus } from "../search/status.js";
import { getSearchQueueStatus } from "../search/indexer.js";

let fullReindex: Promise<unknown> | undefined;

export const router = Router();

// Tiny in-memory token bucket per remote address. 5 rps with burst 5.
const RATE = 5;
const BURST = 5;
const buckets = new Map<string, { tokens: number; updated: number }>();

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: BURST, updated: now };
  const elapsed = (now - b.updated) / 1000;
  b.tokens = Math.min(BURST, b.tokens + elapsed * RATE);
  b.updated = now;
  if (b.tokens < 1) {
    buckets.set(ip, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(ip, b);
  return true;
}

function parseBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (v === "true" || v === true) return true;
  if (v === "false" || v === false) return false;
  return undefined;
}

function parseEpoch(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 1e10) return n; // already ms
    if (Number.isFinite(n) && n > 0) return n * 1000; // seconds → ms
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

router.get("/sessions/search", async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!rateLimit(ip)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  const q = String(req.query.q ?? "").trim();
  const archivedRaw = req.query.archived;
  const archived: SearchFilters["archived"] =
    archivedRaw === "true" || archivedRaw === "false" || archivedRaw === "any"
      ? archivedRaw
      : "false";

  const filters: SearchFilters = {
    cwd: typeof req.query.cwd === "string" && req.query.cwd ? req.query.cwd : undefined,
    archived,
    since: parseEpoch(req.query.since),
    until: parseEpoch(req.query.until),
    model: typeof req.query.model === "string" && req.query.model ? req.query.model : undefined,
    has_goal: parseBool(req.query.has_goal),
    has_error: parseBool(req.query.has_error),
    limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
  };

  const controller = new AbortController();
  const cancelDisconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.once("close", cancelDisconnected);
  try {
    await runSearchAsync(q, filters, {
      signal: controller.signal,
      // No await between final authorization and transport release.
      release: response => { if (!controller.signal.aborted) res.json(response); },
    });
  } catch (err) {
    if (controller.signal.aborted || res.headersSent) return;
    if (err instanceof SearchQueryError) {
      const inputError = ["query_too_long", "too_many_units", "unit_too_long", "unmatched_quote", "empty_unit", "invalid_query"].includes(err.code);
      res.status(inputError ? 400 : err.code === "search_busy" ? 429 : 503).json({ error: err.message, code: err.code });
    } else {
      console.error("[search] query unavailable");
      res.status(503).json({ error: "Search is temporarily unavailable.", code: "search_unavailable" });
    }
  } finally {
    res.off("close", cancelDisconnected);
  }
});

export function getSearchHealthSnapshot() {
  const allowedSessionIds = listIndexableSessions().map((session) => session.id);
  const status = getSearchStatus(allowedSessionIds);
  const counts = status.coverage!.counts;
  const total = allowedSessionIds.length;
  const indexed = counts.current + counts.metadata_only;
  const errors = counts.failed + counts.unsupported + counts.partial;
  const watcher = getWatcherStatus();
  return {
    total_sessions: total,
    indexed_sessions: indexed,
    pending: Math.max(0, total - indexed),
    errored: errors,
    last_error: errors ? "Some eligible sessions have incomplete or failed indexing." : watcher.lastError ?? undefined,
    ...status,
    queue: getSearchQueueStatus(),
    schema_version: SCHEMA_VERSION,
    embedder: "off" as const,
    watcher: {
      started: watcher.started,
      background_indexing_enabled: watcher.backgroundIndexingEnabled,
      policy_projection_available: watcher.policyProjectionAvailable,
      backfill_done: watcher.backfillDone,
      backfill_running: watcher.backfillRunning,
      last_tick_at: watcher.lastTickAt,
    },
  };
}

router.get("/sessions/search/health", (_req: Request, res: Response) => {
  try {
    res.json(getSearchHealthSnapshot());
  } catch {
    res.status(503).json({ error: "Search health is temporarily unavailable." });
  }
});

router.post("/sessions/search/reindex", async (req: Request, res: Response) => {
  try {
    const sessionId = typeof req.body?.session_id === "string" ? req.body.session_id : null;
    if (sessionId) {
      const r = await indexSession(sessionId, { force: true });
      res.status(202).json({ queued: 1, result: r });
      return;
    }
    // Async: kick off and return immediately so the client isn't blocked on
    // the full corpus pass.
    fullReindex ??= reindexAll({ force: true })
      .then((summary) =>
        console.log(
          `[search] reindex(force) summary total=${summary.total} indexed=${summary.indexed} errors=${summary.errors}`,
        ),
      )
      .catch(() => console.error("[search] manual reindex failed"))
      .finally(() => { fullReindex = undefined; });
    res.status(202).json({ queued: -1, note: "background_reindex_started" });
  } catch {
    res.status(503).json({ error: "Search indexing is temporarily unavailable." });
  }
});
