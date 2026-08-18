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
process.env.WAYANG_DATA_DIR = tmpRoot;

// Import after env is set so getConfig() reads the temp dir.
const dbMod = await import("../db.js");
const projectsMod = await import("../projects.js");
const sessionsMod = await import("../sessions.js");
const agentProfilesMod = await import("../agent-profiles.js");
const searchRouteMod = await import("../routes/search.js");
const searchDbMod = await import("./db.js");
const indexerMod = await import("./indexer.js");
const policyFilterMod = await import("./policy-filter.js");
const searchMod = await import("./search.js");
const watcherMod = await import("./watcher.js");

dbMod.init();

function writeFixture(sessionId: string, cwd: string, transcript: Array<{ role: "user" | "assistant"; text: string; id?: string }>): string {
  const dir = path.join(tmpRoot, "sessions", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session.jsonl");
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: "session", version: 3, id: sessionId, cwd }));
  for (let i = 0; i < transcript.length; i++) {
    const t = transcript[i];
    lines.push(
      JSON.stringify({
        type: "message",
        id: t.id ?? `m${i}`,
        message: {
          role: t.role,
          content: [{ type: "text", text: t.text }],
        },
      }),
    );
  }
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return file;
}

function seedSession(opts: {
  title: string;
  goal?: string;
  archived?: boolean;
  transcript: Array<{ role: "user" | "assistant"; text: string; id?: string }>;
}): string {
  const store = dbMod.getStore();
  const id = `sess-${store.sessions.length + 1}`;
  const cwd = path.join(tmpRoot, `proj-${id}`);
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

  const second = await indexerMod.indexSession(id);
  assert.equal(second.skipped, true);
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

test("search returns empty for short queries without throwing", () => {
  const out = searchMod.runSearch("a");
  assert.deepEqual(out.results, []);
});

// Cleanup hook — done via process exit; we leave the temp dir for inspection if needed.
test("close db handles", () => {
  searchDbMod.closeSearchDb();
});
