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
const sessionsMod = await import("../sessions.js");
const searchDbMod = await import("./db.js");
const indexerMod = await import("./indexer.js");
const searchMod = await import("./search.js");

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
  const cwd = `/tmp/proj-${id}`;
  const file = writeFixture(id, cwd, opts.transcript);
  const now = Date.now();
  store.sessions.push({
    id,
    pi_session_file: file,
    title: opts.title,
    cwd,
    provider: "openrouter",
    model: "test-model",
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

test("search returns empty for short queries without throwing", () => {
  const out = searchMod.runSearch("a");
  assert.deepEqual(out.results, []);
});

// Cleanup hook — done via process exit; we leave the temp dir for inspection if needed.
test("close db handles", () => {
  searchDbMod.closeSearchDb();
});
