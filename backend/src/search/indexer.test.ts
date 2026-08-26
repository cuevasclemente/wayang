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
  title: string;
  goal?: string;
  archived?: boolean;
  cwd?: string;
  transcript: Array<{ role: "user" | "assistant"; text: string; id?: string }>;
}): string {
  const store = dbMod.getStore();
  const id = `sess-${store.sessions.length + 1}`;
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

test("full unchanged reindex reuses one exact durable projection", async () => {
  seedSession({
    title: "Projection batch reuse one",
    transcript: [{ role: "user", text: "synthetic projection batch one" }],
  });
  seedSession({
    title: "Projection batch reuse two",
    transcript: [{ role: "assistant", text: "synthetic projection batch two" }],
  });
  policyProjectionMod.writeDreamPolicyProjection();
  const projectionPath = policyProjectionMod.getDreamPolicyProjectionPath();
  const before = fs.statSync(projectionPath);
  const summary = await indexerMod.reindexAll();
  assert.ok(summary.total >= 2);
  assert.equal(summary.errors, 0);
  assert.equal(fs.statSync(projectionPath).ino, before.ino,
    "an unchanged full-corpus pass must not replace the durable projection");
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
  const rows = db.prepare("SELECT DISTINCT goal, title FROM chunks WHERE session_id = ?").all(id) as Array<{ goal: string | null; title: string }>;
  assert.deepEqual(rows, [{ goal: newGoal, title: "Metadata CAS fixture" }]);
  assert.equal(searchMod.runSearch("platypus").results.some((row) => row.session_id === id), true);
  assert.equal(searchMod.runSearch("old metadata projection").results.some((row) => row.session_id === id), false);
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

  // Restore access, start the watcher, then tighten again. The central policy
  // notification must synchronously purge the now-disallowed standard session.
  projectsMod.updateProject(project.id, {
    default_agent_profile_id: originalProfileId,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null },
  });
  assert.ok(searchMod.runSearch("quokka allowlist").results.some((result) => result.session_id === id));
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

// Cleanup hook — done via process exit; we leave the temp dir for inspection if needed.
test("close db handles", async () => {
  searchDbMod.closeSearchDb();
  await transcriptIndexMod.closeStructuralTranscriptIndex();
});
