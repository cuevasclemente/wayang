# Session transcript pagination

Wayang’s web chat loads long transcripts as bounded windows instead of transferring and rendering an entire session at once. A Pi session remains one continuous, branch-aware conversation; pagination does not create subsessions or alter canonical Pi JSONL.

## User behavior

- Opening a session normally loads the newest window and starts at the latest message.
- Scrolling near the top prefetches older windows. **Load older** is also available at an unloaded edge.
- Search results request a window centered on the exact matched active-branch message.
- Search views provide **Jump to latest** and **Back to match** without loading every intervening message.
- Compaction summaries remain ordinary transcript landmarks. Compaction chapter navigation is not part of this release.
- Live output remains at the transcript tail. When viewing an older/search window, Wayang reports newer activity without moving the current viewport.

The initial window is limited to 200 persisted events and 512 KiB of serialized transcript content. Individual oversized events render as bounded placeholders.

## Protocol compatibility

Pagination is additive and explicitly negotiated as `window-v1` over the existing chat WebSocket. The web client opts in. Clients that do not negotiate it continue receiving the legacy complete `history` snapshot, preserving compatibility with existing companion clients.

Partial windows use a distinct `transcript_window` message; Wayang never places partial history under the legacy `history` discriminator. Opaque page cursors are bound to the exact session, browser selection, transcript epoch, direction, and server lifetime.

## Storage and indexing

Canonical transcript content remains in Pi’s JSONL under `~/.pi/agent/sessions/`. Wayang maintains `<dataDir>/transcript-index.db`, a private, rebuildable structural index containing event topology, active-branch order, source offsets, and revision metadata—not general message text.

The common latest/older path can read JSONL backward directly and does not wait for a complete structural build. Search-centered and forward paging use the revision-checked structural index. Index workers and publication are concurrency-, time-, memory-, queue-, and batch-bounded.

Modern stopped-session TODO state is derived in a separate bounded worker after the first transcript window is sent. A stale or unauthorized result is withheld rather than mixed with a newer transcript revision. Read-only paged opens deliberately do not run full historical automatic-title catch-up; normal runtime/title flows remain available.

## Revision and mutation behavior

- Ordinary descendant appends preserve valid older-page navigation when safe.
- Branch changes, resend topology changes, canonical edits/deletions, path replacement, or incompatible rewrites create a new transcript epoch.
- Stale page responses never merge with current content. Terminal cursor/revision errors trigger one fresh bounded reopen.
- Canonical transcript mutation clears stale windows immediately and rebuilds derived search/topology state before fresh content is accepted.
- Search anchors are exact message IDs and are validated against the current active branch. Missing or off-branch matches are reported rather than silently merged into normal chat.

## Compiled limits

These are defensive implementation limits, not environment variables:

- 200 persisted events per window;
- 512 KiB total serialized window content;
- 384 KiB aggregate indexed source-read budget;
- two concurrent structural-index workers and two concurrent TODO workers;
- 25,000 topology entries for exact indexed around/forward navigation.

A session beyond the topology limit still supports bounded latest/backward loading, but an old search anchor may open latest with the match pending instead of building an unbounded index. A single cold physical JSONL row over 64 MiB requires an already-current structural index; otherwise Wayang returns a typed bounded failure rather than scanning arbitrary disk.

## Recovery and rollback

`transcript-index.db` is derived state. Stop Wayang before removing it; the service rebuilds it as needed without modifying canonical transcripts. Do not remove `store.json` or Pi session JSONL as a troubleshooting step.

The server retains legacy full-history support. Disabling the web client’s pagination negotiation returns that client to the previous complete-history path without a transcript migration.

## Validation

Focused coverage lives in:

- `backend/src/transcript-pagination/*.test.ts`
- `backend/src/routes/ws-pagination.test.ts`
- `e2e/tests/transcript-pagination.spec.ts`
- `e2e/tests/transcript-window-controller.spec.ts`
- `e2e/tests/session-latency.spec.ts`
