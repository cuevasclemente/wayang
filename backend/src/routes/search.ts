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
  getSearchDb,
  getWatcherStatus,
  indexSession,
  reindexAll,
  runSearch,
  SCHEMA_VERSION,
} from "../search/index.js";
import type { SearchFilters } from "../search/index.js";

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

router.get("/sessions/search", (req: Request, res: Response) => {
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

  try {
    const response = runSearch(q, filters);
    res.json(response);
  } catch (err: any) {
    console.error("[search] /sessions/search failed:", err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

export function getSearchHealthSnapshot() {
  const db = getSearchDb();
  const allowedSessionIds = new Set(listIndexableSessions().map((session) => session.id));
  const states = db
    .prepare("SELECT session_id, error, indexed_at_ms FROM session_index_state")
    .all() as Array<{ session_id: string; error: string | null; indexed_at_ms: number }>;
  const allowedStates = states.filter((state) => allowedSessionIds.has(state.session_id));
  const total = allowedSessionIds.size;
  const indexed = allowedStates.length;
  const errors = allowedStates
    .filter((state) => state.error)
    .sort((a, b) => b.indexed_at_ms - a.indexed_at_ms);
  const watcher = getWatcherStatus();
  return {
    total_sessions: total,
    indexed_sessions: indexed,
    pending: Math.max(0, total - indexed),
    errored: errors.length,
    last_error: errors[0]?.error ?? watcher.lastError ?? undefined,
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
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
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
    reindexAll({ force: true })
      .then((summary) =>
        console.log(
          `[search] reindex(force) summary total=${summary.total} indexed=${summary.indexed} errors=${summary.errors}`,
        ),
      )
      .catch((err) => console.error("[search] reindex(force) failed:", err));
    res.status(202).json({ queued: -1, note: "background_reindex_started" });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});
