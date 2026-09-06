/** Pure SQL tests: in-memory synthetic data only; no config/store/transcript imports. */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { parseSearchQuery, SearchQueryError } from "./query-parser.js";
import { queryKeywordSessions, sanitizeSnippet, MARK_OPEN, MARK_CLOSE } from "./query-sql.js";
import type { SearchFilters } from "./types.js";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY, session_id TEXT, cwd TEXT DEFAULT '/synthetic',
      title TEXT DEFAULT 'Fixture', goal TEXT, model TEXT DEFAULT 'test-model',
      last_active INTEGER DEFAULT 1, archived INTEGER DEFAULT 0, has_error INTEGER DEFAULT 0,
      role TEXT DEFAULT 'user', text TEXT, message_id TEXT DEFAULT 'exact-message',
      transcript_epoch TEXT DEFAULT 'synthetic-epoch', active_branch INTEGER DEFAULT 1,
      published INTEGER DEFAULT 1
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
  function search(query: string, filters: SearchFilters = {}, ids = [...allowed], cwds = ["/synthetic"]) {
    return queryKeywordSessions(db, parseSearchQuery(query), ids, cwds, filters);
  }
  return { db, add, search };
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
        has_error, role, text, message_id, transcript_epoch, active_branch FROM chunks WHERE published = 1`);
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

test("synthetic common-term baseline: bounded output over 10,000 matching chunks", (t) => {
  const f = fixture();
  try {
    f.db.transaction(() => {
      for (let s = 0; s < 500; s++) {
        for (let c = 0; c < 20; c++) f.add(`session-${s}`, `common alpha ${"filler ".repeat(30)}${c % 2 ? "beta" : "gamma"}`);
      }
    })();
    const measurements: number[] = [];
    for (let run = 0; run < 4; run++) {
      const start = performance.now();
      const out = f.search("common alpha beta gamma", { limit: 30 });
      measurements.push(Math.round((performance.now() - start) * 10) / 10);
      assert.equal(out.rows.length, 30);
      assert.ok(out.rows.every(row => row.coverage === 4));
      assert.equal(out.facets.cwds[0].count, 500);
    }
    t.diagnostic(JSON.stringify({ synthetic_chunks: 10000, sessions: 500, query_ms: measurements }));
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
