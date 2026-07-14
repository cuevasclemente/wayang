# Session History Search

Wayang maintains a local keyword index over past pi sessions. Keyword search and its UI are included in v0.1; semantic/hybrid search is not.

## How it works

- **Index store**: `<dataDir>/search.db`, sibling of `store.json`.
  - `chunks` — one row per chunk of session text, plus stamped session metadata.
  - `chunks_fts` — SQLite FTS5 mirror (BM25 + snippet).
  - `chunk_vectors` — empty until M3 (semantic search) lands.
  - `session_index_state` — per-session bookkeeping (mtime, size, chunk_count).
- **Chunker**: streams pi JSONL, keeps only `message.role ∈ {user, assistant}`
  text content, greedy-packs into ≤ 2000-char chunks with 200-char overlap.
  Tool inputs/outputs and (by default) `thinking` blocks are skipped. Every
  session also gets a synthetic `role='meta'` chunk so metadata-only sessions
  are still findable.
- **Indexer**: lazy + idempotent. Compares the session's pi JSONL mtime/size
  against `session_index_state`; reindexes only what changed.
- **Watcher**: kicks off a full backfill ~2 s after boot, then polls every
  30 s for changed sessions.

## API

```
GET  /api/sessions/search?q=…&cwd=…&archived=…&since=…&until=…&model=…
                          &has_goal=…&has_error=…&limit=30
GET  /api/sessions/search/health
POST /api/sessions/search/reindex      body: { session_id?: string }
```

`/api/sessions/search` returns BM25-ranked chunks aggregated by session, with
HTML snippets (allowlist: `<mark>`, `<br>`). When the boot backfill is still
running, the response carries `degraded: "indexing_in_progress"`.

## Frontend

The `SessionsPanel` filter input runs server-side search when the query is at
least 2 chars long (with a 250 ms debounce). A collapsible "Filters" strip
exposes project, date range, model, has-goal, has-error, and the "Include
archived" toggle. Archived sessions are hidden by default.

Clicking a result opens the session and scrolls the transcript to the matched
message via the `data-message-id` anchor set on each rendered message.

## Manual reindex

The UI normally keeps the index current. A local administrator can request a rebuild through `POST /api/sessions/search/reindex`, with optional JSON body `{ "session_id": "<uuid>" }`; omit the body to reindex everything. When built-in authentication is enabled, use the authenticated same-origin UI rather than copying session cookies into a command line.

## Deferred semantic search

Semantic/hybrid search and an external embedding provider are not part of v0.1. The default remains local keyword-only search, so no transcript text is sent to an embedding service.

## Tests

- Backend unit/integration: `backend/src/search/*.test.ts`
  (`npm test` in `backend/`).
- Playwright e2e: `e2e/tests/session-search.spec.ts`
  (`npx playwright test session-search` in `e2e/`).
