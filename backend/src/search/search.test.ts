/** Pure SQL tests: in-memory synthetic data only; no config/store/transcript imports. */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { parseSearchQuery, SearchQueryError, type ParsedSearchQuery } from "./query-parser.js";
import { queryKeywordSessions, sanitizeSnippet, MARK_OPEN, MARK_CLOSE } from "./query-sql.js";
import type { SearchFilters } from "./types.js";
import type { SearchBodyAuthorization } from "./query-authorization.js";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY, session_id TEXT, cwd TEXT DEFAULT '/synthetic',
      title TEXT DEFAULT 'Fixture', goal TEXT, model TEXT DEFAULT 'test-model',
      last_active INTEGER DEFAULT 1, archived INTEGER DEFAULT 0, has_error INTEGER DEFAULT 0,
      role TEXT DEFAULT 'user', text TEXT, message_id TEXT DEFAULT 'exact-message',
      transcript_epoch TEXT DEFAULT 'synthetic-epoch', active_branch INTEGER DEFAULT 1,
      published INTEGER DEFAULT 1, generation TEXT DEFAULT 'synthetic-generation'
    );
    CREATE INDEX chunks_session ON chunks(session_id);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, title, goal, content='chunks', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text, title, goal) VALUES(new.id, new.text, new.title, COALESCE(new.goal, ''));
    END;
    CREATE VIEW search_chunks_current AS SELECT * FROM chunks WHERE published = 1;
  `);
  const allowed = new Set<string>();
  function add(session: string, text: string, extra: Record<string, string | number | null> = {}) {
    allowed.add(session);
    const fields = { session_id: session, text, ...extra };
    const keys = Object.keys(fields);
    db.prepare(`INSERT INTO chunks (${keys.join(',')}) VALUES (${keys.map(key => '@' + key).join(',')})`).run(fields);
  }
  function searchParsed(parsed: ParsedSearchQuery, filters: SearchFilters = {}, ids = [...allowed], cwds = ["/synthetic"],
    bodies: readonly SearchBodyAuthorization[] = ids.map(sessionId => ({ sessionId,
      generation: "synthetic-generation", transcriptEpoch: "synthetic-epoch" }))) {
    return queryKeywordSessions(db, parsed, ids, cwds, filters, bodies);
  }
  function search(query: string, filters: SearchFilters = {}, ids = [...allowed], cwds = ["/synthetic"],
    bodies?: readonly SearchBodyAuthorization[]) {
    return searchParsed(parseSearchQuery(query), filters, ids, cwds, bodies);
  }
  return { db, add, search, searchParsed };
}

test("any-unit admission; whole-session distinct coverage beats repetition and recency", () => {
  const f = fixture();
  try {
    f.add("all", "alpha", { last_active: 1, message_id: "a" });
    f.add("all", "beta", { last_active: 1, message_id: "b" });
    f.add("all", "gamma", { last_active: 1, message_id: "c" });
    f.add("some", "alpha beta", { last_active: 10 });
    for (let i = 0; i < 250; i++) f.add("one", "alpha alpha alpha", { last_active: 100 });
    f.add("none", "unrelated");
    const out = f.search("alpha beta gamma alpha");
    assert.deepEqual(out.rows.map(r => [r.session_id, r.coverage]), [["all", 3], ["some", 2], ["one", 1]]);
    assert.equal(out.facets.cwds[0].count, 3);
    assert.ok(["a", "b", "c"].includes(out.rows[0].message_id!));
    assert.equal(out.rows[0].transcript_epoch, "synthetic-epoch");
    assert.equal(out.rows[0].active_branch, 1);
  } finally { f.db.close(); }
});

test("phrases are optional units with consecutive ordered tokens and no implicit prefixes", () => {
  const f = fixture();
  try {
    f.add("phrase", "ALPHA, beta");
    f.add("word", "gamma");
    f.add("both", "alpha beta");
    f.add("both", "gamma");
    f.add("reverse", "beta alpha");
    f.add("gap", "alpha middle beta");
    f.add("prefix", "alphabet betamax");
    f.add("separate", "alpha", { message_id: "left" });
    f.add("separate", "beta", { message_id: "right" });
    assert.deepEqual(f.search('"alpha beta" gamma').rows.map(r => r.session_id).sort(), ["both", "phrase", "word"]);
    assert.equal(f.search('"alpha beta" gamma').rows[0].session_id, "both");
    assert.equal(f.search('"alpha beta"').rows.length, 2);
    assert.equal(f.search('"gamma" "alpha beta"').rows.length, 3);
    assert.equal(f.search("alph betam").rows.length, 0);
    assert.equal(f.search("alpha").rows.some(r => r.session_id === "prefix"), false);
  } finally { f.db.close(); }
});

test("literal operators, punctuation and normalized Unicode cannot inject MATCH syntax", () => {
  const f = fixture();
  try {
    f.add("operator", "OR NOT NEAR");
    f.add("ordinary", "elsewhere");
    f.add("unicode", "café 東京");
    f.add("punctuation", "title foo");
    assert.deepEqual(f.search("OR").rows.map(r => r.session_id), ["operator"]);
    assert.deepEqual(f.search("cafe\u0301 CAFÉ").rows.map(r => [r.session_id, r.coverage]), [["unicode", 1]]);
    assert.deepEqual(f.search("東京").rows.map(r => r.session_id), ["unicode"]);
    assert.deepEqual(f.search("title:foo").rows.map(r => r.session_id), ["punctuation"]);
  } finally { f.db.close(); }
});

test("more than 200 best chunk hits cannot crowd out sessions; facets precede result limit", () => {
  const f = fixture();
  try {
    f.db.transaction(() => {
      for (let i = 0; i < 350; i++) f.add("heavy", "common common common");
      for (let i = 0; i < 80; i++) f.add(`small-${i}`, "common plus filler");
    })();
    assert.equal(f.search("common", { limit: 100 }).rows.length, 81);
    const limited = f.search("common", { limit: 3 });
    assert.equal(limited.rows.length, 3);
    assert.deepEqual(limited.facets.cwds, [{ value: "/synthetic", count: 81 }]);
    assert.deepEqual(limited.facets.models, [{ value: "test-model", count: 81 }]);
  } finally { f.db.close(); }
});

test("session limiting precedes anchor selection without changing full-session ranks or facets", () => {
  const f = fixture();
  try {
    f.add("winner", "alpha", { message_id: "first-not-best" });
    f.add("winner", "alpha beta", { message_id: "best-two-units" });
    f.add("winner", "gamma", { message_id: "third-unit" });
    for (let index = 0; index < 80; index++) f.add(`other-${index}`, "alpha beta");
    const limited = f.search("alpha beta gamma", { limit: 1 });
    const full = f.search("alpha beta gamma", { limit: 100 });
    assert.deepEqual(limited.rows, full.rows.slice(0, 1));
    assert.deepEqual(limited.facets, full.facets);
    assert.equal(limited.facets.cwds[0].count, 81);
    assert.equal(limited.rows[0].coverage, 3);
    assert.equal(limited.rows[0].message_id, "best-two-units",
      "the metadata representative must never replace the best message anchor");
    assert.equal(limited.rows[0].transcript_epoch, "synthetic-epoch");
    const html = sanitizeSnippet(limited.rows[0].snippet);
    assert.match(html, /<mark>alpha<\/mark>/);
    assert.match(html, /<mark>beta<\/mark>/);
  } finally { f.db.close(); }
});

test("unpublished FTS rows cannot appear but may change BM25 tie-breaking", () => {
  const f = fixture();
  try {
    f.add("a", "alpha");
    f.add("b", "beta");
    for (let index = 0; index < 40; index++) f.add(`unrelated-${index}`, "filler");
    const before = f.search("alpha beta");
    assert.deepEqual(before.rows.map(row => row.session_id), ["a", "b"]);
    f.db.transaction(() => {
      for (let index = 0; index < 200; index++) f.add("unpublished", "alpha", { published: 0 });
    })();
    const after = f.search("alpha beta");
    assert.deepEqual(after.rows.map(row => row.session_id), ["b", "a"],
      "shared FTS document frequency includes unpublished rows even though admission excludes them");
    assert.ok(after.rows.every(row => row.coverage === 1));
    assert.deepEqual(after.facets, before.facets);
    assert.equal(after.rows.some(row => row.session_id === "unpublished"), false);
  } finally { f.db.close(); }
});

test("lexical relevance precedes recency, then stable binary session ID breaks ties", () => {
  const f = fixture();
  try {
    f.add("old-relevant", "alpha alpha alpha", { last_active: 0 });
    f.add("new-dilute", "alpha " + "filler ".repeat(100), { last_active: 999 });
    assert.equal(f.search("alpha").rows[0].session_id, "old-relevant");
    f.add("z", "tie", { last_active: 2 });
    f.add("b", "tie", { last_active: 3 });
    f.add("a", "tie", { last_active: 3 });
    assert.deepEqual(f.search("tie").rows.map(r => r.session_id), ["a", "b", "z"]);
    assert.deepEqual(f.search("tie").rows, f.search("tie").rows);
  } finally { f.db.close(); }
});

test("current-view publication, active branch and both authorization gates precede facets/limits", () => {
  const f = fixture();
  try {
    f.add("visible", "canary");
    f.add("denied", "canary", { model: "denied-model" });
    f.add("wrong-project", "canary", { cwd: "/denied" });
    f.add("staging", "canary", { published: 0 });
    f.add("offbranch", "canary", { active_branch: 0 });
    f.add("tool", "canary", { role: "toolResult" });
    f.add("thinking", "canary", { role: "thinking" });
    const out = f.search("canary", {}, ["visible", "wrong-project", "staging", "offbranch", "tool", "thinking"]);
    assert.deepEqual(out.rows.map(r => r.session_id), ["visible"]);
    assert.deepEqual(out.facets.models, [{ value: "test-model", count: 1 }]);
    assert.deepEqual(out.facets.cwds, [{ value: "/synthetic", count: 1 }]);
    assert.equal(f.search("canary", {}, []).rows.length, 0);
    assert.equal(f.search("canary", {}, ["visible"], []).rows.length, 0);
  } finally { f.db.close(); }
});

test("revision-bound body witnesses gate all hits, facets, coverage and limits but retain metadata", () => {
  const f = fixture();
  try {
    f.add("stale", "bodycanary alpha beta", { model: "stale-model" });
    f.add("stale", "metadataonly", { role: "meta", active_branch: 0, message_id: null });
    f.add("valid", "bodycanary alpha");
    const bodies = [{ sessionId: "valid", generation: "synthetic-generation", transcriptEpoch: "synthetic-epoch" }];
    const out = f.search("bodycanary alpha beta", { limit: 1 }, ["stale", "valid"], ["/synthetic"], bodies);
    assert.deepEqual(out.rows.map(r => [r.session_id, r.coverage]), [["valid", 2]]);
    assert.deepEqual(out.facets.models, [{ value: "test-model", count: 1 }]);
    assert.deepEqual(out.facets.cwds, [{ value: "/synthetic", count: 1 }]);
    assert.equal(f.search("metadataonly", {}, ["stale"], ["/synthetic"], []).rows[0].session_id, "stale");
    assert.equal(f.search("bodycanary", {}, ["stale"], ["/synthetic"], []).rows.length, 0);
    for (const witness of [
      { sessionId: "stale", generation: "wrong-generation", transcriptEpoch: "synthetic-epoch" },
      { sessionId: "stale", generation: "synthetic-generation", transcriptEpoch: "wrong-epoch" },
    ]) assert.equal(f.search("bodycanary", {}, ["stale"], ["/synthetic"], [witness]).rows.length, 0);
    // The lower-level API cannot accidentally upgrade metadata IDs into body grants.
    const missing = queryKeywordSessions(f.db, parseSearchQuery("bodycanary"), ["stale"], ["/synthetic"]);
    assert.deepEqual(missing, { rows: [], facets: { cwds: [], models: [] } });
  } finally { f.db.close(); }
});

test("FTS-equivalent accent and Unicode-punctuation units cannot inflate session coverage", () => {
  const f = fixture();
  try {
    f.add("cafe-only", "café cafe cafe", { last_active: 999 });
    f.add("two-units", "cafe beta", { last_active: 1 });
    assert.deepEqual(f.search("cafe café beta").rows.map(r => [r.session_id, r.coverage]), [["two-units", 2], ["cafe-only", 1]]);
    f.add("phrase", "alpha beta");
    assert.deepEqual(f.search('"alpha—beta" "alpha beta"').rows.map(r => [r.session_id, r.coverage]), [["phrase", 1]]);
  } finally { f.db.close(); }
});

test("all existing filters and text-only metadata matching are preserved", () => {
  const f = fixture();
  try {
    f.add("current", "needle", { title: "staletitle", goal: "stalegoal", last_active: 20 });
    f.add("current", "freshmetadata", { role: "meta", active_branch: 0, message_id: null, last_active: 20 });
    f.add("archive", "needle", { archived: 1, has_error: 1, model: "other", goal: "goal", last_active: 40 });
    assert.equal(f.search("staletitle stalegoal").rows.length, 0);
    assert.equal(f.search("freshmetadata").rows[0].message_id, null);
    assert.deepEqual(f.search("needle").rows.map(r => r.session_id), ["current"]);
    assert.equal(f.search("needle", { archived: "any" }).rows.length, 2);
    assert.deepEqual(f.search("needle", {
      archived: "true", cwd: "/synthetic", model: "other", has_goal: true,
      has_error: true, since: 40, until: 40,
    }).rows.map(r => r.session_id), ["archive"]);
    assert.equal(f.search("needle", { has_goal: false }).rows.length, 0);
    assert.equal(f.search("needle", { has_error: false }).rows.length, 1);
    assert.equal(f.search("needle", { since: 21 }).rows.length, 0);
    assert.equal(f.search("needle", { until: 19 }).rows.length, 0);
    assert.equal(f.search("needle", { cwd: "/elsewhere" }).rows.length, 0);
    assert.equal(f.search("needle", { model: "absent" }).rows.length, 0);
  } finally { f.db.close(); }
});

test("view metadata overlays stamped legacy metadata for result presentation and filters", () => {
  const f = fixture();
  try {
    f.add("changed", "needle", { title: "old", archived: 0, model: "old-model", last_active: 1 });
    f.db.exec(`DROP VIEW search_chunks_current;
      CREATE VIEW search_chunks_current AS SELECT id, session_id, cwd, 'fresh' AS title,
        'new-goal' AS goal, 'new-model' AS model, 99 AS last_active, 1 AS archived,
        has_error, role, text, message_id, transcript_epoch, active_branch, generation FROM chunks WHERE published = 1`);
    assert.equal(f.search("needle").rows.length, 0);
    const out = f.search("needle", { archived: "true", model: "new-model", since: 99, has_goal: true });
    assert.equal(out.rows[0].title, "fresh");
    assert.deepEqual(out.facets.models, [{ value: "new-model", count: 1 }]);
  } finally { f.db.close(); }
});

test("snippets remain escaped HTML and contain the chosen exact message's match", () => {
  const f = fixture();
  try {
    f.add("safe", '<script>alert(1)</script> needle & "quotes"\nline', { message_id: "anchor-exact" });
    const row = f.search("needle").rows[0];
    const html = sanitizeSnippet(row.snippet);
    assert.equal(row.message_id, "anchor-exact");
    assert.match(html, /<mark>needle<\/mark>/);
    assert.ok(!html.includes("<script>"));
    assert.match(html, /&lt;script&gt;/);
    assert.equal(sanitizeSnippet(`${MARK_OPEN}x${MARK_CLOSE}\n&<>"'`), '<mark>x</mark><br>&amp;&lt;&gt;&quot;&#39;');
  } finally { f.db.close(); }
});

test("SQL/view failure is a typed safe error, never empty successful results", () => {
  const f = fixture();
  try {
    f.add("fixture", "privatequerycanary");
    f.db.exec("DROP VIEW search_chunks_current");
    assert.throws(() => f.search("privatequerycanary"), (error: unknown) => {
      assert.ok(error instanceof SearchQueryError);
      assert.equal(error.code, "search_unavailable");
      assert.equal(error.message, "Search is temporarily unavailable.");
      assert.equal(error.cause, undefined);
      return true;
    });
  } finally { f.db.close(); }
});

test("synthetic common-term baseline: 2 and 16 distinct units on the same 10,000-row corpus", (t) => {
  const f = fixture();
  try {
    const terms = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi".split(" ");
    const text = `${terms.join(" ")} ${"filler ".repeat(30)}`;
    f.db.transaction(() => {
      for (let s = 0; s < 500; s++) {
        for (let c = 0; c < 20; c++) f.add(`session-${s}`, text);
      }
    })();
    const roundMs = (duration: number) => Math.round(duration * 10) / 10;
    for (const unitCount of [2, 16]) {
      const query = terms.slice(0, unitCount).join(" ");
      const parseStart = performance.now();
      const parsed = parseSearchQuery(query);
      const parseOnceMs = roundMs(performance.now() - parseStart);
      assert.equal(parsed.units.length, unitCount);
      // Both modes use the identical database, filters, witnesses and query.
      // "preparsed" excludes parser work; "included" reparses on every call.
      // These timings exclude fixture setup and real filesystem authorization.
      for (const parseMode of ["preparsed", "included"] as const) {
        const measurements: number[] = [];
        for (let run = 0; run < 4; run++) {
          const start = performance.now();
          const out = parseMode === "preparsed"
            ? f.searchParsed(parsed, { limit: 30 }) : f.search(query, { limit: 30 });
          measurements.push(roundMs(performance.now() - start));
          assert.equal(out.rows.length, 30);
          assert.ok(out.rows.every(row => row.coverage === unitCount));
          assert.equal(out.facets.cwds[0].count, 500);
          assert.deepEqual(out.rows.map(row => row.session_id),
            Array.from({ length: 500 }, (_, index) => `session-${index}`).sort().slice(0, 30));
        }
        t.diagnostic(JSON.stringify({ synthetic_chunks: 10000, sessions: 500,
          distinct_common_units: unitCount, parse_mode: parseMode, parse_once_ms: parseOnceMs,
          query_ms: measurements }));
      }
    }
  } finally { f.db.close(); }
});

test("complete message documents match phrases across old chunk boundaries and long source separators", () => {
  const f = fixture();
  try {
    // The new producer publishes a complete message document (no role prefix).
    // This phrase begins at character 1995 and spans the old 2000-character
    // boundary plus a separator longer than the old 200-character overlap.
    const prefix = "filler ".repeat(285);
    const text = `${prefix}alpha${" ".repeat(5000)}beta gamma delta epsilon`;
    assert.ok(Buffer.byteLength(text, "utf8") < 128 * 1024);
    f.add("boundary", text, { message_id: "same-exact-message" });
    const out = f.search('"alpha beta gamma delta epsilon"');
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].message_id, "same-exact-message");
    assert.equal(out.rows[0].coverage, 1);
    assert.equal(f.search("user").rows.length, 0, "no synthetic role prefix is searchable");

    // Exercise the admitted phrase-length ceiling against the same complete
    // document representation, not a character-overlap approximation.
    const longest = `${"a ".repeat(63)}ab`;
    assert.equal(longest.length, 128);
    f.add("maximum", `${prefix}${longest}`, { message_id: "maximum-phrase-message" });
    const maximum = f.search(`"${longest}"`);
    assert.equal(maximum.rows.length, 1);
    assert.equal(maximum.rows[0].message_id, "maximum-phrase-message");
  } finally { f.db.close(); }
});
