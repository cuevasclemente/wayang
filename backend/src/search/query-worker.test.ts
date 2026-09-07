import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { ReadonlySearchQueryPool } from "./query-worker-client.js";
import { createQueryWorkerFixture } from "./query-worker-fixture.js";
import { SearchQueryError } from "./query-parser.js";
import { queryKeywordSessions } from "./query-sql.js";
import { queryDatabaseSnapshot } from "./query-snapshot.js";

const codeIs = (code: SearchQueryError["code"]) => (error: unknown) => error instanceof SearchQueryError && error.code === code;

test("actual read-only child imports the same SQL and closes its reader before success", async () => {
  const f = createQueryWorkerFixture();
  const pool = new ReadonlySearchQueryPool();
  try {
    const request = f.request();
    const before = f.db.prepare("SELECT COUNT(*) AS n FROM chunks").get();
    const result = await pool.query(request);
    const direct = queryKeywordSessions(f.db, request.parsed, request.metadataSessionIds, request.allowedCwds, request.filters, request.bodies);
    assert.deepEqual(result, direct);
    assert.equal(result.rows[0].message_id, "message-0");
    assert.deepEqual(f.db.prepare("SELECT COUNT(*) AS n FROM chunks").get(), before);
    assert.deepEqual(pool.status(), { running: 0, queued: 0, stopped: false, epoch: 0 });
    const checkpoint = f.db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
    assert.equal(checkpoint[0].busy, 0, "no completed query may retain a WAL reader");
  } finally { await pool.stop(); f.db.close(); }
});

for (const mutation of ["generation", "metadata", "removed-metadata", "new-publication"] as const) {
  test(`worker refuses a changed ${mutation} snapshot before MATCH`, async () => {
    const f = createQueryWorkerFixture();
    const pool = new ReadonlySearchQueryPool();
    try {
      const request = f.request();
      if (mutation === "generation") f.db.exec("UPDATE search_publication SET generation='generation-2'");
      if (mutation === "metadata") f.db.exec("UPDATE search_session_metadata SET title='Changed',revision='metadata-2'");
      if (mutation === "removed-metadata") f.db.exec("DELETE FROM search_session_metadata WHERE session_id='session-0'");
      if (mutation === "new-publication") f.db.exec("UPDATE search_publication SET source_revision='changed-source'");
      await assert.rejects(pool.query(request), codeIs("search_changed"));
    } finally { await pool.stop(); f.db.close(); }
  });
}

test("queue, active cancellation, queued cancellation and shutdown remain bounded", async () => {
  const f = createQueryWorkerFixture();
  const pool = new ReadonlySearchQueryPool({ queued: 1 });
  try {
    const active = new AbortController();
    const queued = new AbortController();
    const first = pool.query(f.request(), active.signal);
    const firstRejected = assert.rejects(first, codeIs("search_cancelled"));
    const second = pool.query(f.request(), queued.signal);
    const secondRejected = assert.rejects(second, codeIs("search_cancelled"));
    await assert.rejects(pool.query(f.request()), codeIs("search_busy"));
    assert.equal(pool.status().running, 1);
    assert.equal(pool.status().queued, 1);
    queued.abort(); active.abort();
    await Promise.all([firstRejected, secondRejected]);
    await pool.stop();
    assert.equal(pool.status().running, 0);
    assert.equal(pool.status().queued, 0);
    await assert.rejects(pool.query(f.request()), codeIs("search_stopped"));
  } finally { await pool.stop(); f.db.close(); }
});

test("deadline kills the child, reports a fixed error, and permits shutdown", async () => {
  const f = createQueryWorkerFixture();
  const pool = new ReadonlySearchQueryPool({ deadlineMs: 1 });
  try {
    await assert.rejects(pool.query(f.request()), codeIs("search_timeout"));
    await pool.stop();
    assert.equal(pool.status().running, 0);
  } finally { await pool.stop(); f.db.close(); }
});

test("request and result byte ceilings are explicit errors, never truncation", async () => {
  const f = createQueryWorkerFixture();
  const requestPool = new ReadonlySearchQueryPool({ requestBytes: 1 });
  const resultPool = new ReadonlySearchQueryPool({ resultBytes: 1 });
  try {
    await assert.rejects(requestPool.query(f.request()), codeIs("search_request_too_large"));
    assert.equal(requestPool.status().running, 0);
    await assert.rejects(resultPool.query(f.request()), codeIs("search_result_too_large"));
  } finally { await requestPool.stop(); await resultPool.stop(); f.db.close(); }
});

test("missing database reports only a safe failure and is never created", async () => {
  const f = createQueryWorkerFixture();
  const pool = new ReadonlySearchQueryPool();
  try {
    const request = { ...f.request(), dbPath: `${f.dbPath}.missing-private-canary` };
    await assert.rejects(pool.query(request), (error: unknown) => {
      assert.ok(error instanceof SearchQueryError);
      assert.equal(error.message, "Search is temporarily unavailable.");
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(existsSync(request.dbPath), false);
  } finally { await pool.stop(); f.db.close(); }
});

test("16 common units over 10,000 rows execute while the parent event loop keeps ticking", async t => {
  const f = createQueryWorkerFixture(500, 20);
  const pool = new ReadonlySearchQueryPool();
  try {
    const request = f.request(f.terms);
    const gaps: number[] = [];
    let previous = performance.now();
    const timer = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now; }, 10);
    const start = performance.now();
    let result;
    try { result = await pool.query(request); }
    finally { gaps.push(performance.now() - previous); clearInterval(timer); }
    assert.equal(result.rows.length, 30);
    assert.ok(result.rows.every(row => row.coverage === 16));
    assert.equal(result.facets.cwds[0].count, 500);
    assert.ok(gaps.length >= 3, "timer work must progress during process startup/query execution");
    t.diagnostic(JSON.stringify({ synthetic_rows: 10000, sessions: 500, units: 16,
      elapsed_ms: Math.round(performance.now() - start), timer_samples: gaps.length,
      max_parent_timer_gap_ms: Math.round(Math.max(...gaps)),
      database_snapshot_unchanged: request.databaseSnapshot === queryDatabaseSnapshot(f.db, f.ids) }));
    // Report latency rather than inventing a portable host-load-independent SLO.
    // The lead compares these observations against the measured sync baseline.
  } finally { await pool.stop(); f.db.close(); }
});
