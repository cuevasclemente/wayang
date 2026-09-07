/** Actual async API with synthetic owning transcripts, store, publications and mutations. */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionRow } from "../db.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-async-search-"));
const cwd = path.join(root, "project");
const piRoot = path.join(root, "pi", "sessions");
fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(piRoot, { recursive: true });
process.env.HOME = root;
process.env.WAYANG_DATA_DIR = path.join(root, "data");
process.env.PI_CODING_AGENT_DIR = path.join(root, "pi");
process.env.PI_CODING_AGENT_SESSION_DIR = piRoot;
process.env.WAYANG_SEARCH_BACKGROUND_INDEXING = "0";
const storeMod = await import("../db.js");
const projectsMod = await import("../projects.js");
const policyFilter = await import("./policy-filter.js");
const searchDb = await import("./db.js");
const publication = await import("./publication.js");
const revision = await import("./revision.js");
const search = await import("./search.js");
const workers = await import("./query-worker-client.js");
const preparation = await import("./query-prepare.js");
const parser = await import("./query-parser.js");
storeMod.init();
let sequence = 0;

function fixture(needle?: string) {
  const id = `async-session-${++sequence}`;
  const term = needle ?? `asyncneedle${sequence}`;
  const { project } = projectsMod.ensureProjectForCwd(cwd);
  const file = path.join(piRoot, `${id}.jsonl`);
  fs.writeFileSync(file, [
    { type: "session", version: 3, id, cwd: project.cwd },
    { type: "message", id: "exact", parentId: null, message: { role: "user", content: [{ type: "text", text: term }] } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const row: SessionRow = { id, pi_session_file: file, title: "Synthetic async", title_source: "explicit",
    cwd: project.cwd, project_id: project.id, provider: "synthetic", model: "test-model",
    agent_profile_id: project.default_agent_profile_id, pending_agent_switch: null,
    legacy_private_session_quarantine: false, legacy_capability_ineligible: false,
    created_at: 1, last_active: 1, archived: 0, archived_at: null, goal: null, goal_status: null,
    scheduled_job_id: null, scheduled_run_id: null, error: null };
  storeMod.getStore().sessions.push(row); storeMod.flush();
  const observed = policyFilter.getSessionIndexAuthorization(row);
  assert.ok(observed?.transcript);
  const db = searchDb.getSearchDb();
  publication.publishMetadata(db, row);
  const generation = `published-${id}`;
  db.prepare(`INSERT INTO chunks(session_id,cwd,title,created_at,last_active,chunk_index,role,text,
    message_id,transcript_epoch,active_branch,generation) VALUES(?,'','',1,1,0,'user',?,'exact','epoch-1',1,?)`)
    .run(id, term, generation);
  publication.publishGeneration(db, row, generation, () => {}, { filePath: file, fingerprint: observed.transcript.fingerprint,
    extractionVersion: revision.SEARCH_EXTRACTION_VERSION, transcriptEpoch: "epoch-1" });
  function exclude() { row.legacy_private_session_quarantine = true; storeMod.flush(); }
  return { id, row, term, db, exclude };
}

test("async API matches synchronous results and exact anchors on a stable snapshot", async () => {
  const f = fixture();
  try {
    const expected = search.runSearch(f.term);
    const actual = await search.runSearchAsync(f.term);
    assert.deepEqual(actual.results, expected.results);
    assert.deepEqual(actual.facets, expected.facets);
    assert.equal(actual.results[0].best_message_id, "exact");
  } finally { f.exclude(); }
});

for (const mutation of ["quarantine", "delete", "detach", "append", "metadata-filter", "generation"] as const) {
  test(`async API cannot release stale body/facets after ${mutation}`, async () => {
    const f = fixture();
    try {
      const pending = search.runSearchAsync(f.term);
      // This executes after prepare/fork and before any child reply can release.
      if (mutation === "quarantine") f.row.legacy_private_session_quarantine = true;
      if (mutation === "delete") {
        const rows = storeMod.getStore().sessions;
        rows.splice(rows.findIndex(row => row.id === f.id), 1);
      }
      if (mutation === "detach") f.row.pi_session_file = null;
      if (mutation === "append") fs.appendFileSync(f.row.pi_session_file!, JSON.stringify({
        type: "message", id: "sibling", parentId: null,
        message: { role: "assistant", content: [{ type: "text", text: "replacement branch" }] },
      }) + "\n");
      if (mutation === "metadata-filter") {
        f.row.archived = 1; f.row.title = "Changed during query";
        publication.publishMetadata(f.db, f.row);
      }
      if (mutation === "generation") f.db.prepare("UPDATE search_publication SET generation='different-generation' WHERE session_id=?").run(f.id);
      storeMod.flush();
      const result = await pending;
      assert.deepEqual(result.results, []);
      assert.deepEqual(result.facets, { cwds: [], models: [] });
    } finally { f.exclude(); }
  });
}

test("retry excludes missing or stale metadata instead of accepting it or failing globally", async () => {
  for (const remove of [true, false]) {
    const f = fixture();
    try {
      const pending = search.runSearchAsync(f.term);
      if (remove) f.db.prepare("DELETE FROM search_session_metadata WHERE session_id=?").run(f.id);
      else { f.row.archived = 1; storeMod.flush(); } // intentionally leave the DB projection stale
      const out = await pending;
      assert.deepEqual(out.results, []);
      assert.deepEqual(out.facets, { cwds: [], models: [] });
      assert.equal(out.metadata_revision_rejected, 1);
      assert.ok(out.degraded);
    } finally { f.exclude(); }
  }
});

for (const staleField of ["title", "archive", "goal", "model", "error", "missing"] as const) {
  test(`paused indexing: stale ${staleField} metadata cannot poison another session or leak matches`, async () => {
    const current = fixture();
    const stale = fixture(current.term);
    try {
      stale.row.title = "oldtitlecanary";
      stale.row.goal = "oldgoalcanary";
      publication.publishMetadata(stale.db, stale.row);
      if (staleField === "title") stale.row.title = "replacement title";
      if (staleField === "archive") stale.row.archived = 1;
      if (staleField === "goal") stale.row.goal = "replacement goal";
      if (staleField === "model") stale.row.model = "replacement-model";
      if (staleField === "error") stale.row.error = "synthetic failure";
      if (staleField === "missing") stale.db.prepare("DELETE FROM search_session_metadata WHERE session_id=?").run(stale.id);
      storeMod.flush(); // Deliberately no watcher/metadata refresh.
      const out = await search.runSearchAsync(current.term);
      assert.deepEqual(out.results.map(row => row.session_id), [current.id]);
      assert.equal(out.facets.cwds[0].count, 1);
      assert.equal(out.metadata_revision_rejected, 1);
      assert.ok(out.degraded);
      const oldMetadata = await search.runSearchAsync("oldtitlecanary oldgoalcanary", { archived: "any" });
      assert.deepEqual(oldMetadata.results, []);
      assert.deepEqual(oldMetadata.facets, { cwds: [], models: [] });
      assert.equal(oldMetadata.metadata_revision_rejected, 1);

      // Further edits to an already excluded session cannot continuously restart
      // unrelated queries; its authority/exclusion state has not become broader.
      const parsed = parser.parseSearchQuery(current.term);
      const before = preparation.prepareSearchQuery(parsed, {});
      stale.row.title = "another excluded title";
      storeMod.flush();
      const after = preparation.prepareSearchQuery(parsed, {});
      assert.equal(after.releaseSnapshot, before.releaseSnapshot);
      assert.deepEqual(after.eligibleSessionIds.sort(), [current.id, stale.id].sort());
      assert.deepEqual(after.request.metadataSessionIds, [current.id]);
    } finally { current.exclude(); stale.exclude(); }
  });
}

test("last-active-only drift keeps indexed recency and ignores unrelated runtime fields", async () => {
  const f = fixture();
  try {
    const parsed = parser.parseSearchQuery(f.term);
    const before = preparation.prepareSearchQuery(parsed, {});
    const pending = search.runSearchAsync(f.term);
    f.row.last_active = 999;
    f.row.catalog_mutation_version = 42;
    f.row.goal_status = "completed";
    storeMod.flush();
    const after = preparation.prepareSearchQuery(parsed, {});
    assert.equal(after.releaseSnapshot, before.releaseSnapshot);
    const out = await pending;
    assert.equal(out.results[0].session_id, f.id);
    assert.equal(out.results[0].last_active, 1, "use last-indexed recency until metadata refresh");
    assert.equal(out.metadata_revision_rejected, 0);
    assert.deepEqual((await search.runSearchAsync(f.term, { since: 2 })).results, []);
    assert.equal((await search.runSearchAsync(f.term, { since: 1, until: 1 })).results[0].session_id, f.id);
  } finally { f.exclude(); }
});

test("a newly eligible session invalidates the whole snapshot, including facets", async () => {
  const first = fixture();
  let second: ReturnType<typeof fixture> | undefined;
  try {
    const pending = search.runSearchAsync(first.term);
    second = fixture(first.term);
    const out = await pending;
    assert.deepEqual(out.results.map(row => row.session_id).sort(), [first.id, second.id].sort());
    assert.equal(out.facets.cwds[0].count, 2);
  } finally { first.exclude(); second?.exclude(); }
});

test("async cancellation fails safely without releasing a response", async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    const pending = search.runSearchAsync(f.term, {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof search.SearchQueryError && error.code === "search_cancelled");
  } finally { f.exclude(); }
});

test.after(async () => {
  await workers.stopSearchQueryWorker();
  searchDb.closeSearchDb();
});
