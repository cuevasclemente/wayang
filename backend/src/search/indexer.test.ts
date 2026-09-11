/**
 * indexer.test.ts — Integration tests for the indexer + search query.
 *
 * Each test uses an isolated WAYANG_DATA_DIR so search.db / store.json are
 * scratch. Real `~/.pi/agent/sessions` is never read.
 */

import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-indexer-"));
const piSessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-indexer-pi-"));
process.env.WAYANG_DATA_DIR = tmpRoot;
process.env.PI_CODING_AGENT_SESSION_DIR = piSessionsRoot;

// Import after env is set so getConfig() reads the temp dir.
const dbMod = await import("../db.js");
const projectsMod = await import("../projects.js");
const policyMod = await import("../policy.js");
const sessionsMod = await import("../sessions.js");
const agentProfilesMod = await import("../agent-profiles.js");
const searchRouteMod = await import("../routes/search.js");
const searchDbMod = await import("./db.js");
const indexerMod = await import("./indexer.js");
const policyFilterMod = await import("./policy-filter.js");
const policyProjectionMod = await import("./policy-projection.js");
const searchMod = await import("./search.js");
const watcherMod = await import("./watcher.js");
const transcriptIndexMod = await import("../transcript-pagination/structural-index.js");
const transcriptAuthorizationMod = await import("../standard-transcript-authorization.js");

dbMod.init();

// Register first so the production timing high-water counters normally belong
// to this benchmark. Report their baseline too; these are not resettable counters.
// This measures one synthetic catalog entry, not production corpus/storage load.
test("synthetic benchmark: 20k topology, bounded documents, excluded giant record and parent timer progress", async (t) => {
  const publication = await import("./publication.js");
  const extraction = await import("./extraction.js");
  const topologyEvents = 20_000;
  const includedDocuments = 2_000;
  assert.ok(topologyEvents < transcriptIndexMod.TRANSCRIPT_INDEX_MAX_TOPOLOGY_ENTRIES);
  const id = seedSession({id:"synthetic-benchmark-20k",title:"Synthetic bounded indexing benchmark",transcript:[]});
  const row = dbMod.getStore().sessions.find((candidate) => candidate.id === id)!;
  const file = row.pi_session_file!;
  let expectedTextBytes = 0;
  let includedSourceBytes = 0;
  let excludedRecordBytes = 0;
  let lines: string[] = [];
  // Fixture construction is outside the measured interval and never reads live
  // transcripts. Batching also avoids retaining all serialized topology in RAM.
  for (let i = 0; i < topologyEvents; i++) {
    const included = i % 10 === 0;
    const giant = i === 10_001;
    const text = giant ? "synthetic excluded payload ".repeat(300_000).slice(0,7*1024*1024)
      : included && (i === 0 || i === 10) ? "bounded document ".repeat(8192).slice(0,extraction.SEARCH_MAX_DOCUMENT_BYTES)
      : `synthetic ${included ? "included" : "excluded"} event ${i}`;
    const line = JSON.stringify({type:"message",id:`bench-${i}`,parentId:i ? `bench-${i-1}` : null,
      message:{role:included ? (i % 20 === 0 ? "user" : "assistant") : "toolResult",content:[{type:"text",text}]}})+"\n";
    if (included) {
      assert.ok(Buffer.byteLength(text) <= extraction.SEARCH_MAX_DOCUMENT_BYTES);
      expectedTextBytes += Buffer.byteLength(text);
      includedSourceBytes += Buffer.byteLength(line);
    }
    if (giant) excludedRecordBytes = Buffer.byteLength(line);
    lines.push(line);
    if (lines.length === 128 || i === topologyEvents-1) {fs.appendFileSync(file,lines.join(""));lines=[];}
  }
  assert.ok(excludedRecordBytes > extraction.SEARCH_MAX_RECORD_BYTES);
  assert.ok(excludedRecordBytes <= 8*1024*1024,"excluded physical record must remain inside cold structural admission");
  assert.ok(expectedTextBytes <= extraction.SEARCH_MAX_GENERATION_BYTES);
  assert.ok(transcriptAuthorizationMod.authorizeExactStandardTranscript(file,{expectedSessionId:id}));
  const db = searchDbMod.getSearchDb();
  const structure = transcriptIndexMod.getStructuralTranscriptIndex();
  const workersBefore = structure.getWorkerInstrumentation().workersStarted;
  const before = publication.getSearchPublicationMetrics();
  const countBodies = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE session_id=? AND role IN ('user','assistant')");
  const remaining = db.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(text AS BLOB))),0) AS bytes FROM chunks WHERE session_id=?");
  let previousRows = 0;
  let previousStageBytes = before.stageBytes;
  let stageHooks = 0;
  let maxStageRows = 0;
  let maxStageBytes = 0;
  let firstStageAt: number | undefined;
  let extractionDoneAt: number | undefined;
  let sampledExtractionAt: number | undefined;
  let timerTicks = 0;
  let maxTimerGapMs = 0;
  let cleanupMaxRows = 0;
  let cleanupMaxBytes = 0;
  let cleanupMaxCandidates = 0;
  let cleanupPasses = 0;
  const rssBefore = process.memoryUsage().rss;
  let peakRss = rssBefore;
  const started = performance.now();
  let lastTick = started;
  const timer = setInterval(() => {
    const now = performance.now();
    timerTicks++;
    maxTimerGapMs = Math.max(maxTimerGapMs,now-lastTick);lastTick=now;
    peakRss = Math.max(peakRss,process.memoryUsage().rss);
    if (indexerMod.getSearchQueueStatus().phase === "extracting") sampledExtractionAt ??= now;
  },5);
  let indexFinishedAt: number | undefined;
  let cleanupStartedAt: number | undefined;
  let indexMaxTimerGapMs = 0;
  try {
    const result = await indexerMod.indexSession(id,{force:true,
      afterStageForTests() {
        firstStageAt ??= performance.now();
        const stagedRows = (countBodies.get(id) as {n:number}).n;
        const stagedBytes = publication.getSearchPublicationMetrics().stageBytes;
        const rows = stagedRows-previousRows;
        const bytes = stagedBytes-previousStageBytes;
        assert.ok(rows > 0 && rows <= publication.SEARCH_STAGE_MAX_ROWS);
        assert.ok(bytes > 0 && bytes <= publication.SEARCH_STAGE_MAX_BYTES);
        maxStageRows=Math.max(maxStageRows,rows);maxStageBytes=Math.max(maxStageBytes,bytes);
        previousRows=stagedRows;previousStageBytes=stagedBytes;stageHooks++;
      },
      afterChunkingForTests() {extractionDoneAt=performance.now();},
    });
    indexFinishedAt=performance.now();
    indexMaxTimerGapMs=Math.max(maxTimerGapMs,indexFinishedAt-lastTick);
    assert.equal(result.error,undefined);assert.equal(result.outcome,"current");
    assert.equal(result.chunkCount,includedDocuments+1);
    assert.equal(previousRows,includedDocuments);
    assert.equal(previousStageBytes-before.stageBytes,expectedTextBytes);
    assert.equal(structure.getWorkerInstrumentation().workersStarted-workersBefore,1,"cold exact structural build");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM search_chunks_current WHERE session_id=?").get(id) as {n:number}).n,includedDocuments+1);
    assert.equal(db.prepare("SELECT id FROM chunks WHERE session_id=? AND message_id='bench-10001'").get(id),undefined);
    assert.ok(timerTicks > 0,"the parent timer must progress while workers index");
    assert.ok(stageHooks > 0);

    // Measure real reclamation, not just candidate scans over retained rows.
    // The generation has finished; invalidate before yielding to cleanup.
    cleanupStartedAt=performance.now();
    publication.invalidatePublication(db,id);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM search_chunks_current WHERE session_id=?").get(id) as {n:number}).n,0);
    let prior = remaining.get(id) as {n:number;bytes:number};
    for (; prior.n > 0 && cleanupPasses < includedDocuments+4; cleanupPasses++) {
      const candidatesBefore = publication.getSearchPublicationMetrics().cleanupCandidates;
      const removed = await publication.cleanupSearchChunks(db,{sessionId:id,maxBatches:1});
      const after = remaining.get(id) as {n:number;bytes:number};
      const candidates = publication.getSearchPublicationMetrics().cleanupCandidates-candidatesBefore;
      assert.equal(prior.n-after.n,removed);
      assert.ok(removed <= publication.SEARCH_STAGE_MAX_ROWS);
      assert.ok(prior.bytes-after.bytes <= publication.SEARCH_STAGE_MAX_BYTES);
      assert.ok(candidates <= 64);
      cleanupMaxRows=Math.max(cleanupMaxRows,removed);
      cleanupMaxBytes=Math.max(cleanupMaxBytes,prior.bytes-after.bytes);
      cleanupMaxCandidates=Math.max(cleanupMaxCandidates,candidates);
      prior=after;
    }
    assert.equal(prior.n,0,"bounded cleanup passes must eventually reclaim all synthetic documents");
  } finally {
    clearInterval(timer);
    const finished = performance.now();
    maxTimerGapMs=Math.max(maxTimerGapMs,finished-lastTick);
    peakRss=Math.max(peakRss,process.memoryUsage().rss);
    const after = publication.getSearchPublicationMetrics();
    t.diagnostic(JSON.stringify({benchmark:"synthetic-search-20k",topologyEvents,includedDocuments,
      excludedRecordBytes,fixtureBytes:fs.statSync(file).size,includedSourceBytesFromFixture:includedSourceBytes,
      coldIndexWallMs:indexFinishedAt === undefined ? null : indexFinishedAt-started,
      preFirstStageMs:firstStageAt === undefined ? null : firstStageAt-started,
      sampledExtractionThroughStagingMs:sampledExtractionAt === undefined || extractionDoneAt === undefined ? null : extractionDoneAt-sampledExtractionAt,
      cleanupWallMs:cleanupStartedAt === undefined ? null : finished-cleanupStartedAt,
      wallMs:finished-started,timerIntervalMs:5,timerTicks,indexMaxTimerGapMs,maxTimerGapMs,
      stageTransactions:after.stageTransactions-before.stageTransactions,stageTextBytes:after.stageBytes-before.stageBytes,
      maxStageRows,maxStageBytes,cleanupPasses,cleanupMaxRows,cleanupMaxBytes,cleanupMaxCandidates,
      cleanupRows:after.cleanupRows-before.cleanupRows,maxStageMs:after.maxStageMs,maxPublishMs:after.maxPublishMs,maxCleanupMs:after.maxCleanupMs,
      timingMaximaBaseline:{stage:before.maxStageMs,publish:before.maxPublishMs,cleanup:before.maxCleanupMs},
      peakObservedRssDeltaBytes:peakRss-rssBefore,finalRssDeltaBytes:process.memoryUsage().rss-rssBefore,
      caveat:"No speed/RSS SLA. Timings include test hooks and authorization; extraction start/RSS are sampled, publication maxima are process-wide; fixture construction/teardown excluded."}));
    // Do not make later corpus tests silently repeat this benchmark. Keep its
    // synthetic file on disk for inspection, but remove its catalog/index entry.
    await indexerMod.removeSession(id);
    fs.renameSync(file,path.join(tmpRoot,"synthetic-benchmark-20k.jsonl"));
    const store = dbMod.getStore();
    const position = store.sessions.findIndex((candidate) => candidate.id === id);
    if (position >= 0) {store.sessions.splice(position,1);dbMod.flush();}
  }
});

test("policy purge contains search DB initialization failure to one attempt", () => {
  let attempts = 0;
  let reports = 0;
  const previousError = console.error;
  console.error = () => { reports++; };
  try {
    const result = indexerMod.purgePolicyDeniedSessions({
      ensureSearchDb: () => {
        attempts++;
        throw new Error("synthetic native binding unavailable");
      },
    });
    assert.deepEqual(result, { purged: 0, errors: 1 });
    assert.equal(attempts, 1);
    assert.equal(reports, 1);
  } finally {
    console.error = previousError;
  }
});

test("background search indexing pause is explicit and fail-safe", () => {
  assert.equal(watcherMod.isSearchBackgroundIndexingEnabled(undefined), true);
  assert.equal(watcherMod.isSearchBackgroundIndexingEnabled("1"), true);
  assert.equal(watcherMod.isSearchBackgroundIndexingEnabled("0"), false);
  assert.throws(() => watcherMod.isSearchBackgroundIndexingEnabled("true"), /must be 0 or 1/);
  assert.throws(() => watcherMod.isSearchBackgroundIndexingEnabled("off"), /must be 0 or 1/);
});

test("paused watcher work preserves policy refresh while suppressing transcript indexing", async () => {
  const previous = process.env.WAYANG_SEARCH_BACKGROUND_INDEXING;
  process.env.WAYANG_SEARCH_BACKGROUND_INDEXING = "0";
  let calls = 0;
  const fakeIndex: typeof indexerMod.indexSession = async (sessionId) => {
    calls++;
    return { sessionId, chunkCount: 0, skipped: false };
  };
  try {
    watcherMod.startWatcher();
    let status = watcherMod.getWatcherStatus();
    assert.equal(status.started, true);
    assert.equal(status.backgroundIndexingEnabled, false);
    assert.equal(status.backfillRunning, false);
    watcherMod.stopWatcher();
    await indexerMod.stopSearchQueue();
    indexerMod.startSearchQueue(); // This test continues with explicit manual work.
    assert.equal(watcherMod.getWatcherStatus().started, false);

    await watcherMod.runWatcherTickForTests(fakeIndex);
    await watcherMod.indexSessionNow("paused-synthetic-session", fakeIndex);
    assert.equal(calls, 0);
    let projectionAttempts = 0;
    watcherMod.runPausedPolicyHeartbeat(() => {
      projectionAttempts++;
      throw new Error("synthetic projection outage");
    });
    let health = searchRouteMod.getSearchHealthSnapshot();
    assert.equal(health.watcher.background_indexing_enabled, false);
    assert.equal(health.watcher.policy_projection_available, false);
    assert.equal(health.last_error, "Dream policy projection is unavailable");

    watcherMod.runPausedPolicyHeartbeat(() => {
      projectionAttempts++;
      return undefined;
    });
    health = searchRouteMod.getSearchHealthSnapshot();
    assert.equal(projectionAttempts, 2);
    assert.equal(health.watcher.policy_projection_available, true);
    assert.equal(health.last_error, undefined);

    assert.doesNotThrow(() => watcherMod.runPausedPolicyHeartbeat(
      () => undefined,
      () => { throw new Error("synthetic generation failure"); },
    ));
    health = searchRouteMod.getSearchHealthSnapshot();
    assert.equal(health.watcher.policy_projection_available, false);
    assert.equal(health.last_error, "Dream policy projection is unavailable");

    watcherMod.runPausedPolicyHeartbeat(() => undefined, () => undefined);
    health = searchRouteMod.getSearchHealthSnapshot();
    assert.equal(health.watcher.policy_projection_available, true);
    assert.equal(health.last_error, undefined);
  } finally {
    if (previous === undefined) delete process.env.WAYANG_SEARCH_BACKGROUND_INDEXING;
    else process.env.WAYANG_SEARCH_BACKGROUND_INDEXING = previous;
  }
});

function writeFixture(sessionId: string, cwd: string, transcript: Array<{ role: "user" | "assistant"; text: string; id?: string }>): string {
  const dir = path.join(piSessionsRoot, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session.jsonl");
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: "session", version: 3, id: sessionId, cwd }));
  let parentId: string | null = null;
  for (let i = 0; i < transcript.length; i++) {
    const t = transcript[i];
    const messageId = t.id ?? `m${i}`;
    lines.push(
      JSON.stringify({
        type: "message",
        id: messageId,
        parentId,
        message: {
          role: t.role,
          content: [{ type: "text", text: t.text }],
        },
      }),
    );
    parentId = messageId;
  }
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return file;
}

function seedSession(opts: {
  id?: string;
  title: string;
  goal?: string;
  archived?: boolean;
  cwd?: string;
  transcript: Array<{ role: "user" | "assistant"; text: string; id?: string }>;
}): string {
  const store = dbMod.getStore();
  const id = opts.id ?? `sess-${store.sessions.length + 1}`;
  const cwd = opts.cwd ?? path.join(tmpRoot, `proj-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const { project } = projectsMod.ensureProjectForCwd(cwd);
  const file = writeFixture(id, project.cwd, opts.transcript);
  const now = Date.now();
  store.sessions.push({
    id,
    pi_session_file: file,
    title: opts.title,
    title_source: "explicit",
    cwd: project.cwd,
    project_id: project.id,
    provider: "openrouter",
    model: "test-model",
    agent_profile_id: project.default_agent_profile_id,
    pending_agent_switch: null,
    legacy_private_session_quarantine: false,
    legacy_capability_ineligible: false,
    created_at: now,
    last_active: now,
    archived: opts.archived ? 1 : 0,
    archived_at: opts.archived ? now : null,
    goal: opts.goal || null,
    goal_status: opts.goal ? "pending" : null,
    scheduled_job_id: null,
    scheduled_run_id: null,
    error: null,
  });
  dbMod.flush();
  return id;
}

test("indexer is idempotent when mtime is unchanged", async () => {
  const id = seedSession({
    title: "SSH tunnel debugging",
    transcript: [
      { role: "user", text: "Why does my ssh tunnel keep dropping?" },
      { role: "assistant", text: "Try BatchMode=yes and ServerAliveInterval=30." },
    ],
  });

  const first = await indexerMod.indexSession(id);
  assert.equal(first.skipped, false);
  assert.ok(first.chunkCount >= 1);
  const projectionPath = policyProjectionMod.getDreamPolicyProjectionPath();
  const projectionAfterFirst = fs.statSync(projectionPath);

  const second = await indexerMod.indexSession(id);
  assert.equal(second.skipped, true);
  const projectionAfterSecond = fs.statSync(projectionPath);
  assert.equal(projectionAfterSecond.ino, projectionAfterFirst.ino,
    "an unchanged store/policy must reuse the exact durable projection inode");
  assert.equal(projectionAfterSecond.mtimeMs, projectionAfterFirst.mtimeMs);
});

test("store replacement publishes a newly added Standard-session decision before indexing", async () => {
  const baselineId = seedSession({
    title: "Projection baseline",
    transcript: [{ role: "user", text: "synthetic projection baseline" }],
  });
  const baselineCwd = dbMod.getStore().sessions.find((session) => session.id === baselineId)!.cwd;
  policyProjectionMod.writeDreamPolicyProjection();
  const projectionPath = policyProjectionMod.getDreamPolicyProjectionPath();
  const before = fs.statSync(projectionPath);
  const sourceBefore = JSON.parse(fs.readFileSync(projectionPath, "utf8"))
    .source_store as { ino: number };

  const generationBefore = policyMod.getPolicyGeneration();
  const addedId = seedSession({
    title: "Projection invalidation",
    cwd: baselineCwd,
    transcript: [{ role: "user", text: "synthetic projection invalidation canary" }],
  });
  assert.equal(policyMod.getPolicyGeneration(), generationBefore,
    "adding a session in the same Standard project must isolate store-fingerprint invalidation");
  const beforeDecision = JSON.parse(fs.readFileSync(projectionPath, "utf8")) as {
    sessions: Array<{ session_id: string }>;
  };
  assert.equal(beforeDecision.sessions.some((entry) => entry.session_id === addedId), false);

  const indexed = await indexerMod.indexSession(addedId, { force: true });
  assert.equal(indexed.skipped, false);
  const after = fs.statSync(projectionPath);
  const durable = JSON.parse(fs.readFileSync(projectionPath, "utf8")) as {
    source_store: { ino: number };
    sessions: Array<{ session_id: string; dream: boolean }>;
  };
  assert.notEqual(after.ino, before.ino,
    "atomic store replacement must force a fresh durable projection publication");
  assert.notEqual(durable.source_store.ino, sourceBefore.ino);
  const addedDecision = durable.sessions.find((entry) => entry.session_id === addedId);
  assert.ok(addedDecision);
  assert.equal(addedDecision.dream, true);
});

test("full unchanged reindex reuses one projection and yields to HTTP event-loop work", async () => {
  seedSession({
    title: "Projection batch reuse one",
    transcript: [{ role: "user", text: "synthetic projection batch one" }],
  });
  seedSession({
    title: "Projection batch reuse two",
    transcript: [{ role: "assistant", text: "synthetic projection batch two" }],
  });
  await indexerMod.reindexAll();
  policyProjectionMod.writeDreamPolicyProjection();
  const projectionPath = policyProjectionMod.getDreamPolicyProjectionPath();
  const before = fs.statSync(projectionPath);
  let ioTurnObserved = false;
  const ioTurn = new Promise<void>((resolve) => setImmediate(() => {
    ioTurnObserved = true;
    resolve();
  }));
  const summary = await indexerMod.reindexAll();
  assert.ok(summary.total >= 2);
  assert.equal(summary.errors, 0);
  assert.equal(ioTurnObserved, true,
    "an unchanged full-corpus pass must yield before completing the catalog loop");
  await ioTurn;
  assert.equal(fs.statSync(projectionPath).ino, before.ino,
    "an unchanged full-corpus pass must not replace the durable projection");
  assert.deepEqual(
    fs.readdirSync(path.dirname(projectionPath)).filter((name) => name.startsWith(`${path.basename(projectionPath)}.`)),
    [],
  );
});

test("full reindex aborts once when the projection cannot be published", async () => {
  const id = seedSession({
    title: "Projection publication failure",
    transcript: [{ role: "user", text: "synthetic unavailable projection canary" }],
  });
  const projectionPath = policyProjectionMod.getDreamPolicyProjectionPath();
  fs.rmSync(projectionPath, { force: true });
  fs.mkdirSync(projectionPath);
  try {
    await assert.rejects(
      indexerMod.reindexAll({ force: true }),
      (error: unknown) => error instanceof policyProjectionMod.DreamPolicyProjectionUnavailableError,
    );
    const db = searchDbMod.getSearchDb();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?").get(id) as { n: number }).n, 0);
  } finally {
    fs.rmdirSync(projectionPath);
    policyProjectionMod.writeDreamPolicyProjection();
  }
});

test("periodic watcher tick aborts on the first global projection failure", async () => {
  const firstId = seedSession({
    title: "Watcher projection failure one",
    transcript: [{ role: "user", text: "synthetic watcher failure one" }],
  });
  const secondId = seedSession({
    title: "Watcher projection failure two",
    transcript: [{ role: "assistant", text: "synthetic watcher failure two" }],
  });
  const projectionPath = policyProjectionMod.getDreamPolicyProjectionPath();
  fs.rmSync(projectionPath, { force: true });
  fs.mkdirSync(projectionPath);
  try {
    await assert.rejects(
      watcherMod.runWatcherTickForTests(),
      (error: unknown) => error instanceof policyProjectionMod.DreamPolicyProjectionUnavailableError,
    );
    const db = searchDbMod.getSearchDb();
    for (const id of [firstId, secondId]) {
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?").get(id) as { n: number }).n, 0);
    }
  } finally {
    fs.rmdirSync(projectionPath);
    policyProjectionMod.writeDreamPolicyProjection();
  }
});

test("FTS search returns a session by transcript content", async () => {
  const id = seedSession({
    title: "Fish prompt theming",
    transcript: [
      { role: "user", text: "How do I add git branch info to my fish prompt?" },
      {
        role: "assistant",
        text: "Define fish_prompt and call fish_vcs_prompt inside it.",
      },
    ],
  });
  await indexerMod.indexSession(id);

  const out = searchMod.runSearch("fish prompt");
  const ids = out.results.map((r) => r.session_id);
  assert.ok(ids.includes(id), `expected ${id} in ${ids.join(",")}`);
  const hit = out.results.find((r) => r.session_id === id)!;
  assert.match(hit.snippet_html, /<mark>fish<\/mark>/i);
});

test("archived filter is respected by default and toggleable", async () => {
  const archivedId = seedSession({
    title: "Archived discovery",
    archived: true,
    transcript: [
      { role: "user", text: "Find sessions about kalshi forecasting calibration." },
      { role: "assistant", text: "Kalshi calibration depends on Brier score binning." },
    ],
  });
  await indexerMod.indexSession(archivedId);

  const hidden = searchMod.runSearch("kalshi calibration");
  assert.ok(!hidden.results.some((r) => r.session_id === archivedId));

  const shown = searchMod.runSearch("kalshi calibration", { archived: "any" });
  assert.ok(shown.results.some((r) => r.session_id === archivedId));

  const shownExplicit = searchMod.runSearch("kalshi calibration", { archived: "true" });
  assert.ok(shownExplicit.results.some((r) => r.session_id === archivedId));
});

test("meta-only chunk lets us find sessions by title", async () => {
  const id = seedSession({
    title: "Investigating Wayang WebSocket reconnection storms",
    transcript: [],
  });
  await indexerMod.indexSession(id);
  const out = searchMod.runSearch("websocket reconnection");
  assert.ok(out.results.some((r) => r.session_id === id));
});

test("buildFtsExpression sanitizes dangerous tokens", () => {
  const expr = searchMod.buildFtsExpression('foo OR bar (baz) "quoted"');
  assert.ok(expr);
  assert.ok(!expr!.includes("("));
  assert.ok(!expr!.includes(")"));
  // Tokens should still be searchable as words.
  assert.match(expr!, /"foo"/);
});

test("snippet sanitizer strips arbitrary HTML except <mark>", () => {
  const raw = "Hello <script>alert(1)</script> \x01MARK_OPEN\x01foo\x01MARK_CLOSE\x01 bar\nline2";
  const out = searchMod.sanitizeSnippet(raw);
  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("<mark>foo</mark>"));
  assert.ok(out.includes("<br>"));
});

test("force reindex picks up file changes even with same mtime", async () => {
  const id = seedSession({
    title: "Mtime check",
    transcript: [{ role: "user", text: "initial content alpha" }],
  });
  await indexerMod.indexSession(id);
  const before = searchMod.runSearch("alpha");
  assert.ok(before.results.some((r) => r.session_id === id));

  const store = dbMod.getStore();
  const row = store.sessions.find((s) => s.id === id)!;
  const lines = fs.readFileSync(row.pi_session_file!, "utf-8").split("\n");
  // Append a new message line.
  lines.splice(lines.length - 1, 0, JSON.stringify({
    type: "message",
    id: "mnew",
    message: { role: "user", content: [{ type: "text", text: "added zulu zulu zulu later" }] },
  }));
  fs.writeFileSync(row.pi_session_file!, lines.join("\n"), "utf-8");

  await indexerMod.indexSession(id, { force: true });
  const after = searchMod.runSearch("zulu");
  assert.ok(after.results.some((r) => r.session_id === id));
});

test("metadata generation CAS retries a paused stale clone and commits only the fresh goal projection", async () => {
  const oldGoal = "old metadata projection canary";
  const newGoal = "fresh metadata projection platypus";
  const id = seedSession({
    title: "Metadata CAS fixture",
    goal: oldGoal,
    transcript: [{ role: "user", text: "neutral transcript body" }],
  });
  let release!: () => void;
  let paused!: () => void;
  const pauseReached = new Promise<void>((resolve) => { paused = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let hookCalls = 0;
  const indexing = indexerMod.indexSession(id, {
    force: true,
    async afterChunkingForTests() {
      hookCalls++;
      if (hookCalls === 1) {
        paused();
        await gate;
      }
    },
  });
  await pauseReached;
  sessionsMod.updateGoal(id, newGoal, "pending");
  release();
  const result = await indexing;
  assert.equal(result.error, undefined);
  assert.equal(result.skipped, false);
  assert.ok(hookCalls >= 2, "metadata mutation must retry from a fresh durable row");

  const db = searchDbMod.getSearchDb();
  const rows = db.prepare("SELECT DISTINCT goal, title FROM search_chunks_current WHERE session_id = ?").all(id) as Array<{ goal: string | null; title: string }>;
  assert.deepEqual(rows, [{ goal: newGoal, title: "Metadata CAS fixture" }]);
  assert.equal(searchMod.runSearch("platypus").results.some((row) => row.session_id === id), true);
  // Words now admit optional OR matches; shared 'metadata projection' words
  // legitimately match the new goal. Assert the removed term/phrase instead.
  assert.equal(searchMod.runSearch("old").results.some((row) => row.session_id === id), false);
  assert.equal(searchMod.runSearch('"old metadata projection"').results.some((row) => row.session_id === id), false);
});

test("repeated metadata churn purges and returns a fixed retryable indexing error", async () => {
  const id = seedSession({
    title: "Repeated metadata churn",
    goal: "initial churn goal",
    transcript: [{ role: "user", text: "neutral repeated churn body" }],
  });
  let revision = 0;
  const result = await indexerMod.indexSession(id, {
    force: true,
    afterChunkingForTests() {
      revision++;
      sessionsMod.updateGoal(id, `churn goal ${revision}`, "pending");
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.retryable, true);
  assert.equal(result.error, "Session metadata changed repeatedly during indexing; retry later.");
  const db = searchDbMod.getSearchDb();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?").get(id) as { n: number }).n, 0);
});

test("transcript mutation fence purges first and blocks watcher/manual stale reindex until released", async () => {
  const id = seedSession({
    title: "Mutation fence canary",
    transcript: [{ role: "user", text: "stale searchable mutation canary" }],
  });
  await indexerMod.indexSession(id);
  assert.ok(searchMod.runSearch("mutation canary").results.some((result) => result.session_id === id));

  indexerMod.beginTranscriptMutationSearchFence(id);
  try {
    assert.equal(searchMod.runSearch("mutation canary").results.some((result) => result.session_id === id), false);
    const blocked = await indexerMod.indexSession(id, { force: true });
    assert.equal(blocked.skipped, true);
    assert.equal(blocked.mutationFenced, true);
    assert.equal(blocked.error, undefined);
    const db = searchDbMod.getSearchDb();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?").get(id) as { n: number }).n, 0);
  } finally {
    indexerMod.endTranscriptMutationSearchFence(id);
  }

  const reindexed = await indexerMod.indexSession(id, { force: true });
  assert.equal(reindexed.skipped, false);
  assert.ok(searchMod.runSearch("mutation canary").results.some((result) => result.session_id === id));
});

test("legacy private quarantine excludes stale chunks and blocks indexing despite project drift", async () => {
  const id = seedSession({
    title: "Legacy private quarantine canary",
    transcript: [{ role: "user", text: "synthetic sticky capybara canary" }],
  });
  await indexerMod.indexSession(id);
  assert.ok(searchMod.runSearch("capybara canary").results.some((result) => result.session_id === id));

  const row = dbMod.getStore().sessions.find((session) => session.id === id)!;
  row.legacy_private_session_quarantine = true;
  row.legacy_capability_ineligible = true;
  dbMod.flush();
  const project = projectsMod.getProjectByCwd(row.cwd)!;
  assert.equal(project.access_policy.privacy_mode, "standard", "current project is deliberately generic Standard");
  assert.equal(policyFilterMod.getIndexableSessionIds().has(id), false);
  assert.equal(searchMod.runSearch("capybara canary", { archived: "any" }).results.some((result) => result.session_id === id), false);

  const denied = await indexerMod.indexSession(id, { force: true });
  assert.equal(denied.policySkipped, true);
  const db = searchDbMod.getSearchDb();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?").get(id) as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM session_index_state WHERE session_id = ?").get(id) as { n: number }).n, 0);
});

test("standard allowlist live-filters stale profile chunks from query, facets, and health, then watcher purges", async () => {
  const id = seedSession({
    title: "Standard allowlist stale canary",
    transcript: [{ role: "user", text: "synthetic quokka allowlist canary" }],
  });
  await indexerMod.indexSession(id);
  assert.ok(searchMod.runSearch("quokka allowlist").results.some((result) => result.session_id === id));

  const row = dbMod.getStore().sessions.find((session) => session.id === id)!;
  const originalProfileId = row.agent_profile_id;
  assert.ok(originalProfileId);
  assert.ok(dbMod.getStore().agentProfiles.some((profile) => profile.id === originalProfileId));
  const project = projectsMod.getProjectByCwd(row.cwd)!;
  const alternateProfile = agentProfilesMod.createAgentProfile({ name: `Alternate standard search profile ${id}` });
  projectsMod.updateProject(project.id, {
    default_agent_profile_id: alternateProfile.id,
    access_policy: {
      privacy_mode: "standard",
      allowed_agent_profile_ids: [alternateProfile.id],
    },
  });

  // The watcher is intentionally stopped, simulating purge failure/delay while
  // stale transcript chunks and index state remain durable.
  const db = searchDbMod.getSearchDb();
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?").get(id) as { n: number }).n > 0);
  assert.ok(db.prepare("SELECT session_id FROM session_index_state WHERE session_id = ?").get(id));
  const hidden = searchMod.runSearch("quokka allowlist");
  assert.equal(hidden.results.some((result) => result.session_id === id), false);
  assert.equal(hidden.facets.cwds.some((facet) => facet.value === row.cwd), false);
  assert.equal(policyFilterMod.getIndexableSessionIds().has(id), false);
  assert.equal(transcriptAuthorizationMod.authorizeExactUiTranscript(
    row.pi_session_file!, { expectedSessionId: id },
  ), null, "owning UI authorization must observe the current profile allowlist");

  const health = searchRouteMod.getSearchHealthSnapshot();
  const authorizedIds = policyFilterMod.getIndexableSessionIds();
  const states = db.prepare("SELECT session_id FROM session_index_state").all() as Array<{ session_id: string }>;
  assert.equal(health.total_sessions, authorizedIds.size);
  assert.equal(health.indexed_sessions, states.filter((state) => authorizedIds.has(state.session_id)).length);
  assert.ok(states.some((state) => state.session_id === id), "stale denied state must exist for the health filter assertion");

  // A no-change paused heartbeat must not exact-authorize the whole corpus or
  // physically purge this stale row. Query-time authorization already hid it.
  watcherMod.runPausedPolicyHeartbeat();
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?").get(id) as { n: number }).n > 0);
  assert.ok(db.prepare("SELECT session_id FROM session_index_state WHERE session_id = ?").get(id));

  // Restore access, start the paused watcher, then tighten again. An actual
  // policy notification must still synchronously purge the disallowed session.
  projectsMod.updateProject(project.id, {
    default_agent_profile_id: originalProfileId,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null },
  });
  assert.ok(searchMod.runSearch("quokka allowlist").results.some((result) => result.session_id === id));
  const previousPause = process.env.WAYANG_SEARCH_BACKGROUND_INDEXING;
  process.env.WAYANG_SEARCH_BACKGROUND_INDEXING = "0";
  watcherMod.startWatcher();
  try {
    projectsMod.updateProject(project.id, {
      default_agent_profile_id: alternateProfile.id,
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [alternateProfile.id] },
    });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?").get(id) as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM session_index_state WHERE session_id = ?").get(id) as { n: number }).n, 0);
  } finally {
    watcherMod.stopWatcher();
    await indexerMod.stopSearchQueue();
    indexerMod.startSearchQueue();
    if (previousPause === undefined) delete process.env.WAYANG_SEARCH_BACKGROUND_INDEXING;
    else process.env.WAYANG_SEARCH_BACKGROUND_INDEXING = previousPause;
  }
});

test("protected policy live-filters stale results and indexing denial purges chunks and state", async () => {
  const id = seedSession({
    title: "Protected stale canary",
    transcript: [{ role: "user", text: "confidential synthetic narwhal canary" }],
  });
  await indexerMod.indexSession(id);
  assert.ok(searchMod.runSearch("narwhal canary").results.some((result) => result.session_id === id));

  const row = dbMod.getStore().sessions.find((session) => session.id === id)!;
  const project = projectsMod.getProjectByCwd(row.cwd)!;
  projectsMod.updateProject(project.id, {
    access_policy: {
      privacy_mode: "protected",
      allowed_agent_profile_ids: [project.default_agent_profile_id],
    },
  });

  assert.equal(transcriptAuthorizationMod.authorizeExactStandardTranscript(
    row.pi_session_file!, { expectedSessionId: id },
  ), null, "global Standard authorization must deny Protected transcripts");
  const owningAuthorization = transcriptAuthorizationMod.authorizeExactUiTranscript(
    row.pi_session_file!, { expectedSessionId: id },
  );
  assert.equal(owningAuthorization?.project.id, project.id,
    "the exact owning interactive UI remains authorized for Protected transcripts");

  // Query-time policy is independent of purge completion.
  const db = searchDbMod.getSearchDb();
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?").get(id) as { n: number }).n > 0);
  assert.equal(searchMod.runSearch("narwhal canary").results.some((result) => result.session_id === id), false);
  assert.equal(searchMod.runSearch("narwhal canary").facets.cwds.some((facet) => facet.value === row.cwd), false);

  const denied = await indexerMod.indexSession(id);
  assert.equal(denied.policySkipped, true);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?").get(id) as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM session_index_state WHERE session_id = ?").get(id) as { n: number }).n, 0);
});

test("exact Standard path collisions and header identity mismatches deny indexing and purge stale search text", async () => {
  const id = seedSession({
    title: "Exact durable authorization",
    transcript: [{ role: "user", text: "exact durable wombat canary" }],
  });
  await indexerMod.indexSession(id);
  assert.equal(searchMod.runSearch("wombat canary").results.some((result) => result.session_id === id), true);

  const store = dbMod.getStore();
  const row = store.sessions.find((session) => session.id === id)!;
  store.sessions.push({ ...row, id: `${id}-collision`, title: "Synthetic collision" });
  assert.equal(transcriptAuthorizationMod.authorizeExactStandardTranscript(
    row.pi_session_file!, { expectedSessionId: id },
  ), null);
  const collisionDenied = await indexerMod.indexSession(id, { force: true });
  assert.equal(collisionDenied.policySkipped, true);
  assert.equal(searchMod.runSearch("wombat canary", { archived: "any" }).results.some((result) => result.session_id === id), false);

  store.sessions.splice(store.sessions.findIndex((session) => session.id === `${id}-collision`), 1);
  dbMod.flush();
  const restored = await indexerMod.indexSession(id, { force: true });
  assert.equal(restored.skipped, false);
  assert.equal(searchMod.runSearch("wombat canary", { archived: "any" }).results.some((result) => result.session_id === id), true);

  const original = fs.readFileSync(row.pi_session_file!, "utf8").split("\n");
  original[0] = JSON.stringify({ type: "session", version: 3, id: `${id}-wrong-header`, cwd: row.cwd });
  fs.writeFileSync(row.pi_session_file!, original.join("\n"));
  assert.equal(searchMod.runSearch("wombat canary", { archived: "any" }).results.some((result) => result.session_id === id), false,
    "query-time exact authorization must hide stale chunks before the watcher purge");
  const idDenied = await indexerMod.indexSession(id, { force: true });
  assert.equal(idDenied.policySkipped, true);

  original[0] = JSON.stringify({ type: "session", version: 3, id, cwd: `${row.cwd}-wrong` });
  fs.writeFileSync(row.pi_session_file!, original.join("\n"));
  const cwdDenied = await indexerMod.indexSession(id, { force: true });
  assert.equal(cwdDenied.policySkipped, true);
});

test("fingerprint replacement after search chunking is purged before publication", async () => {
  const id = seedSession({
    title: "Fingerprint race",
    transcript: [{ role: "user", text: "stale fingerprint echidna canary" }],
  });
  const row = dbMod.getStore().sessions.find((session) => session.id === id)!;
  let raced = false;
  const result = await indexerMod.indexSession(id, {
    force: true,
    afterChunkingForTests() {
      if (raced) return;
      raced = true;
      fs.appendFileSync(row.pi_session_file!, JSON.stringify({
        type: "message", id: "fingerprint-race", parentId: "m0",
        message: { role: "assistant", content: [{ type: "text", text: "replacement" }] },
      }) + "\n");
    },
  });
  assert.equal(raced, true);
  assert.equal(result.policySkipped, true);
  assert.equal(searchMod.runSearch("echidna canary", { archived: "any" }).results.some((entry) => entry.session_id === id), false);
});

test("search publishes exact active-branch message anchors and excludes sibling content", async () => {
  const id = seedSession({
    title: "Branch-aware exact anchors",
    transcript: [{ role: "user", text: "placeholder" }],
  });
  const row = dbMod.getStore().sessions.find((session) => session.id === id)!;
  const lines = [
    { type: "session", version: 3, id, cwd: row.cwd },
    { type: "message", id: "root", parentId: null, message: { role: "user", content: [{ type: "text", text: "shared root" }] } },
    { type: "message", id: "off-branch", parentId: "root", message: { role: "assistant", content: [{ type: "text", text: "sibling marmot canary" }] } },
    { type: "message", id: "active-exact", parentId: "root", message: { role: "assistant", content: [{ type: "text", text: "active exact capybara" }] } },
  ];
  fs.writeFileSync(row.pi_session_file!, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  await indexerMod.indexSession(id, { force: true });
  assert.equal(searchMod.runSearch("sibling marmot", { archived: "any" }).results.some((result) => result.session_id === id), false);
  const active = searchMod.runSearch("exact capybara", { archived: "any" }).results.find((result) => result.session_id === id);
  assert.equal(active?.best_message_id, "active-exact");
  assert.equal(active?.best_message_active, true);
  assert.equal(active?.best_anchor_status, "active");
  assert.ok(active?.best_transcript_epoch);
});

test("search returns empty for short queries without throwing", () => {
  const out = searchMod.runSearch("a");
  assert.deepEqual(out.results, []);
});

test("metadata-only edits preserve body IDs and do not schedule extraction or structural body reads", async () => {
  const id = seedSession({title:"Metadata independent",transcript:[{role:"user",text:"body stays immutable"}]});
  await indexerMod.indexSession(id);
  const db = searchDbMod.getSearchDb();
  const before = db.prepare("SELECT id,text FROM chunks WHERE session_id=? AND role='user'").all(id);
  const stages = indexerMod.getSearchQueueStatus().publication.stageTransactions;
  const workers = transcriptIndexMod.getStructuralTranscriptIndex().getWorkerInstrumentation().workersStarted;
  const row = dbMod.getStore().sessions.find((s) => s.id === id)!;
  row.title = "Updated title"; row.goal = "Updated goal"; row.archived = 1; row.last_active++;
  dbMod.flush();
  const result = await indexerMod.indexSession(id);
  assert.equal(result.skipped,true);
  assert.deepEqual(db.prepare("SELECT id,text FROM chunks WHERE session_id=? AND role='user'").all(id),before);
  assert.equal(indexerMod.getSearchQueueStatus().publication.stageTransactions,stages);
  assert.equal(transcriptIndexMod.getStructuralTranscriptIndex().getWorkerInstrumentation().workersStarted,workers);
  assert.deepEqual(db.prepare("SELECT DISTINCT title,goal,archived FROM search_chunks_current WHERE session_id=?").all(id),
    [{title:"Updated title",goal:"Updated goal",archived:1}]);
});

test("revocation after a staged batch denies unpublished text and cannot flip publication", async () => {
  const id = seedSession({title:"Staging revoke",transcript:[{role:"user",text:"staged private canary"}]});
  const row = dbMod.getStore().sessions.find((s) => s.id === id)!;
  let yielded = false;
  const result = await indexerMod.indexSession(id,{force:true,afterStageForTests() {
    yielded = true; row.legacy_private_session_quarantine = true; dbMod.flush();
  }});
  assert.equal(yielded,true);
  assert.equal(result.policySkipped,true);
  assert.deepEqual(searchDbMod.getSearchDb().prepare("SELECT id FROM search_chunks_current WHERE session_id=?").all(id),[]);
});

test("partial coverage is stable but never a successful mutation reconciliation", async () => {
  const id = seedSession({title:"Partial recovery",transcript:[{role:"user",text:"x".repeat(128*1024+1)}]});
  const first = await indexerMod.indexSession(id);
  assert.equal(first.outcome,"partial"); assert.ok(first.error);
  const db = searchDbMod.getSearchDb();
  const state = db.prepare("SELECT successful_revision FROM search_work_state WHERE session_id=?").get(id) as {successful_revision:string|null};
  assert.equal(state.successful_revision,null,"partial is not complete revision evidence");
  const stages = indexerMod.getSearchQueueStatus().publication.stageTransactions;
  const second = await indexerMod.indexSession(id);
  assert.equal(second.outcome,"partial"); assert.ok(second.error);
  assert.equal(indexerMod.getSearchQueueStatus().publication.stageTransactions,stages);
  const recovery = await import("../transcript-recovery-journal.js");
  const row = dbMod.getStore().sessions.find((s) => s.id === id)!;
  const marker = recovery.createEventReconcileMarker(id,row.pi_session_file!);
  try {
    const result = await indexerMod.indexSession(id,{recoveryMarkerId:marker.id});
    assert.ok(result.error,"the mutation caller uses !error as its completion gate");
    assert.equal(result.skipped,true);
    assert.equal(recovery.eventRecoveryMarkerForSession(id)?.id,marker.id);
    assert.deepEqual(db.prepare("SELECT id FROM search_chunks_current WHERE session_id=?").all(id),[]);
  } finally { recovery.clearTranscriptRecoveryMarker(marker.id); }
});

test("a fence cancels old pending intent and the late active result cannot cancel exact recovery", async () => {
  const id = seedSession({title:"Queued mutation recovery",transcript:[{role:"user",text:"old body"}]});
  let release!: () => void; let reached!: () => void;
  const gate = new Promise<void>((r) => { release=r; });
  const paused = new Promise<void>((r) => { reached=r; });
  const active = indexerMod.indexSession(id,{force:true,afterChunkingForTests:async()=>{reached();await gate;}});
  await paused;
  let oldPendingRan = false;
  const pending = indexerMod.indexSession(id,{force:true,afterChunkingForTests:()=>{oldPendingRan=true;}});
  const recovery = await import("../transcript-recovery-journal.js");
  const row = dbMod.getStore().sessions.find((s) => s.id === id)!;
  const marker = recovery.createEventReconcileMarker(id,row.pi_session_file!);
  indexerMod.beginTranscriptMutationSearchFence(id);
  indexerMod.endTranscriptMutationSearchFence(id);
  const winner = indexerMod.indexSession(id,{force:true,recoveryMarkerId:marker.id});
  release();
  try {
    assert.ok((await active).error);
    assert.ok((await pending).error);
    assert.equal(oldPendingRan,false);
    const result = await winner;
    assert.equal(result.error,undefined);assert.equal(result.outcome,"current");assert.equal(result.skipped,false);
    assert.ok(searchDbMod.getSearchDb().prepare("SELECT id FROM search_chunks_current WHERE session_id=?").get(id));
    const stale = await indexerMod.indexSession(id,{force:true,recoveryMarkerId:"wrong-marker"});
    assert.ok(stale.error);
    assert.equal(recovery.eventRecoveryMarkerForSession(id)?.id,marker.id);
  } finally { recovery.clearTranscriptRecoveryMarker(marker.id); }
});

test("malformed tails remain unsupported across retries rather than silently current", async () => {
  const id = seedSession({title:"Malformed tail",transcript:[{role:"user",text:"valid preceding body"}]});
  const row = dbMod.getStore().sessions.find((s) => s.id === id)!;
  fs.appendFileSync(row.pi_session_file!, '{"type":"message","id":');
  const first = await indexerMod.indexSession(id);
  assert.equal(first.outcome,"unsupported");assert.ok(first.error);
  const workers = transcriptIndexMod.getStructuralTranscriptIndex().getWorkerInstrumentation().workersStarted;
  const second = await indexerMod.indexSession(id);
  assert.equal(second.outcome,"unsupported");
  assert.equal(transcriptIndexMod.getStructuralTranscriptIndex().getWorkerInstrumentation().workersStarted,workers);
  assert.equal(indexerMod.getIndexCoverageSnapshot(new Set([id])).counts.unsupported,1);
});

test("exact recovery survives a queued ordinary successor and duplicate exact requests until acknowledgement", async () => {
  const blocker=seedSession({title:"Recovery queue blocker",transcript:[{role:"user",text:"blocker"}]});
  const id=seedSession({title:"Recovery successor",transcript:[{role:"user",text:"retained recovered body"}]});
  let unblock!:()=>void;let blocked!:()=>void;
  const blockGate=new Promise<void>((r)=>{unblock=r;});const blockReached=new Promise<void>((r)=>{blocked=r;});
  const blocking=indexerMod.indexSession(blocker,{force:true,afterChunkingForTests:async()=>{blocked();await blockGate;}});
  await blockReached;
  // This ordinary request is genuinely queued before the durable marker exists.
  const ordinary=indexerMod.indexSession(id);
  const recovery=await import("../transcript-recovery-journal.js");
  const row=dbMod.getStore().sessions.find((candidate)=>candidate.id===id)!;
  const marker=recovery.createEventReconcileMarker(id,row.pi_session_file!);
  let release!:()=>void;let reached!:()=>void;
  const gate=new Promise<void>((r)=>{release=r;});const paused=new Promise<void>((r)=>{reached=r;});
  let extracts=0;
  const first=indexerMod.indexSession(id,{force:true,recoveryMarkerId:marker.id,afterChunkingForTests:async()=>{extracts++;reached();await gate;}});
  unblock();await blocking;await paused;
  const duplicate=indexerMod.indexSession(id,{force:true,recoveryMarkerId:marker.id});
  const deferred=indexerMod.indexSession(id,{force:true});
  const queuedBeforeRelease=indexerMod.getSearchQueueStatus().queued;
  release();
  try {
    const [result,duplicateResult,deferredResult]=await Promise.all([first,duplicate,deferred]);
    assert.ok(deferredResult.error,"ordinary admission during the marker is deferred without purging");
    assert.ok(queuedBeforeRelease>=1);
    assert.equal(result.error,undefined);assert.equal(duplicateResult.error,undefined);
    assert.equal(result.publicationGeneration,duplicateResult.publicationGeneration);
    assert.equal(extracts,1);
    assert.equal(indexerMod.isSearchRecoveryPublicationCurrent(id,marker.id,result),true);
    assert.equal(indexerMod.acknowledgeSearchRecovery(id,marker.id,result),true);
    assert.equal(recovery.eventRecoveryMarkerForSession(id),undefined);
    assert.equal((await ordinary).error,undefined);
    const publication=searchDbMod.getSearchDb().prepare("SELECT generation,valid FROM search_publication WHERE session_id=?").get(id) as {generation:string;valid:number};
    assert.deepEqual(publication,{generation:result.publicationGeneration,valid:1});
  } finally {release();recovery.clearTranscriptRecoveryMarker(marker.id);}
});

test("marker acknowledgement rejects a lost publication even after a successful indexing result", async () => {
  const id=seedSession({title:"Lost recovery witness",transcript:[{role:"user",text:"current recovered body"}]});
  const recovery=await import("../transcript-recovery-journal.js");
  const row=dbMod.getStore().sessions.find((candidate)=>candidate.id===id)!;
  const marker=recovery.createEventReconcileMarker(id,row.pi_session_file!);
  try {
    const result=await indexerMod.indexSession(id,{force:true,recoveryMarkerId:marker.id});
    assert.equal(result.error,undefined);
    searchDbMod.getSearchDb().prepare("UPDATE search_publication SET valid=0 WHERE session_id=?").run(id);
    assert.equal(indexerMod.acknowledgeSearchRecovery(id,marker.id,result),false);
    assert.equal(recovery.eventRecoveryMarkerForSession(id)?.id,marker.id);
  } finally {recovery.clearTranscriptRecoveryMarker(marker.id);}
});

test("repairing oversized metadata retries without a transcript fingerprint change", async () => {
  const id=seedSession({title:"Repair metadata",goal:"x".repeat(129*1024),transcript:[{role:"user",text:"small body"}]});
  const row=dbMod.getStore().sessions.find((candidate)=>candidate.id===id)!;
  const before=fs.statSync(row.pi_session_file!);
  const first=await indexerMod.indexSession(id);
  assert.equal(first.outcome,"unsupported");
  const db=searchDbMod.getSearchDb();
  assert.equal((db.prepare("SELECT error_code FROM search_work_state WHERE session_id=?").get(id) as {error_code:string}).error_code,"metadata_unsupported");
  assert.equal(indexerMod.searchSessionNeedsIndex(id),false,"unchanged oversized metadata is a stable negative");
  row.goal="repaired short goal";dbMod.flush();
  assert.equal(indexerMod.searchSessionNeedsIndex(id),true);
  const repaired=await indexerMod.indexSession(id);
  assert.equal(repaired.error,undefined);assert.equal(repaired.outcome,"current");
  const after=fs.statSync(row.pi_session_file!);
  assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(after.ctimeMs,before.ctimeMs);assert.equal(after.ino,before.ino);
  assert.deepEqual(db.prepare("SELECT DISTINCT goal FROM search_chunks_current WHERE session_id=?").all(id),[{goal:"repaired short goal"}]);
});

test("structural cache invalidation after staging is retryable, not a permanent unsupported revision", async () => {
  const id=seedSession({title:"Transient structural cache",transcript:[{role:"user",text:"canonical retained body"}]});
  let invalidated=false;
  const first=await indexerMod.indexSession(id,{afterStageForTests(){
    if(!invalidated){invalidated=true;transcriptIndexMod.getStructuralTranscriptIndex().purge(id);}
  }});
  assert.equal(first.retryable,true);assert.equal(first.outcome,"stale");
  assert.equal((searchDbMod.getSearchDb().prepare("SELECT error_code FROM search_work_state WHERE session_id=?").get(id) as {error_code:string}).error_code,"structural_stale");
  assert.equal(indexerMod.searchSessionNeedsIndex(id),true);
  const retried=await indexerMod.indexSession(id);
  assert.equal(retried.error,undefined);assert.equal(retried.outcome,"current");
});

test("discovery visits 697 catalog IDs in bounded yielded batches without awaiting extraction", async () => {
  indexerMod.startSearchQueue();
  const ids=Array.from({length:697},(_,i)=>`discovery-synthetic-${i}`);
  const observed=new Set<string>();let calls=0;let catalogs=0;
  let release!:()=>void;const gate=new Promise<void>((resolve)=>{release=resolve;});
  const fake:typeof indexerMod.indexSession=async(sessionId)=>{calls++;await gate;return {sessionId,chunkCount:0,skipped:true};};
  let yielded=false;setImmediate(()=>{yielded=true;});
  try {
    for(let batch=0;batch<Math.ceil(ids.length/watcherMod.SEARCH_DISCOVERY_BATCH_SIZE);batch++) {
      const before=observed.size;
      await watcherMod.runWatcherTickForTests(fake,{resetSweep:batch===0,
        sessionIds:()=>{catalogs++;return ids;},needsIndex:(id)=>{observed.add(id);return true;}});
      assert.ok(observed.size-before<=16);
    }
    assert.equal(observed.size,697);assert.equal(catalogs,1);
    assert.equal(calls,64,"discovery admission memory stays capped even while extraction is blocked");
    assert.equal(yielded,true);
    assert.ok(Math.ceil(697/16)*watcherMod.SEARCH_DISCOVERY_INTERVAL_MS<=5*60_000,
      "nominal discovery sweep is minutes, not hundreds of minutes (excluding I/O time)");
  } finally {release();await watcherMod.stopWatcher();indexerMod.startSearchQueue();}
});

test("cheap discovery skips unchanged bodies and notices metadata without extracting", async () => {
  const id=seedSession({title:"Discovery metadata",transcript:[{role:"user",text:"unchanged body"}]});
  await indexerMod.indexSession(id);
  const stages=indexerMod.getSearchQueueStatus().publication.stageTransactions;
  const workers=transcriptIndexMod.getStructuralTranscriptIndex().getWorkerInstrumentation().workersStarted;
  assert.equal(indexerMod.searchSessionNeedsIndex(id),false);
  const row=dbMod.getStore().sessions.find((candidate)=>candidate.id===id)!;
  row.title="Changed through metadata only";dbMod.flush();
  assert.equal(indexerMod.searchSessionNeedsIndex(id),true);
  assert.equal(indexerMod.getSearchQueueStatus().publication.stageTransactions,stages);
  assert.equal(transcriptIndexMod.getStructuralTranscriptIndex().getWorkerInstrumentation().workersStarted,workers);
});

test("manual corpus producers stop and drain rather than continuing admission after shutdown", async () => {
  for(let i=0;i<3;i++)seedSession({title:`Shutdown batch ${i}`,transcript:[{role:"user",text:"synthetic body"}]});
  let release!:()=>void;let reached!:()=>void;
  const gate=new Promise<void>((resolve)=>{release=resolve;});
  const paused=new Promise<void>((resolve)=>{reached=resolve;});
  let hooks=0;
  const batch=indexerMod.reindexAll({force:true,afterChunkingForTests:async()=>{hooks++;reached();await gate;}});
  await paused;
  const stopping=indexerMod.stopSearchQueue();
  release();await stopping;
  const summary=await batch;
  assert.equal(hooks,1);
  assert.ok(summary.indexed+summary.skipped<summary.total,"manual producer must break, not visit every session after stop");
  indexerMod.startSearchQueue();
});

test("stopped owner rejects every producer before reopening or writing search.db", async () => {
  await indexerMod.stopSearchQueue();searchDbMod.closeSearchDb();
  const dbPath=searchDbMod.getSearchDbPath();const parked=`${dbPath}.stopped-fixture`;
  fs.renameSync(dbPath,parked);fs.mkdirSync(dbPath);
  try {
    const result=await indexerMod.indexSession("stopped-synthetic",{force:true});
    assert.match(result.error!,/owner stopped/);
    assert.equal((await indexerMod.reindexAll({force:true})).errors,1);
    await assert.rejects(indexerMod.removeSession("stopped-synthetic"),/owner stopped/);
    assert.throws(()=>indexerMod.beginTranscriptMutationSearchFence("stopped-synthetic"),/owner stopped/);
    let opens=0;
    assert.deepEqual(indexerMod.purgePolicyDeniedSessions({ensureSearchDb:()=>{opens++;throw Error("must not open");}}),{purged:0,errors:1});
    assert.equal(opens,0);
    assert.equal(indexerMod.searchSessionNeedsIndex("stopped-synthetic"),false);
    assert.throws(()=>indexerMod.getIndexCoverageSnapshot(new Set()),/owner stopped/);
    assert.equal(fs.statSync(dbPath).isDirectory(),true);
  } finally {fs.rmdirSync(dbPath);fs.renameSync(parked,dbPath);indexerMod.startSearchQueue();}
});

// Cleanup hook — done via process exit; we leave synthetic fixtures for inspection.
test("close db handles", async () => {
  await indexerMod.stopSearchQueue();
  searchDbMod.closeSearchDb();
  await transcriptIndexMod.closeStructuralTranscriptIndex();
});
