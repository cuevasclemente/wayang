# Protected-artifact authorization hot-path repair

Date: 2026-08-28
Status: Approved for implementation
Base: `ff8b15e`
Branch: `fix/protected-artifact-hotpath-20260828`

## Incident summary

Wayang stopped accepting HTTP work while creating sessions and serving search. Runtime tracing showed the Node main thread repeatedly canonicalizing registered-project `.env`, `.env.backup`, and `.pi/browser-workbench` paths. One historical Project registration resides on a mergerfs/FUSE-backed path, so synchronous `realpath`/`readlink` work monopolized the event loop. The listen backlog filled and clients observed timeouts and 5xx responses.

The production restart also exposed a separate deployment fault: `better-sqlite3` had no native binding for the active Node 26 ABI. Search startup retried that same dependency failure once per policy-denied session, producing a long synchronous error fan-out before the HTTP listener could bind. Rebuilding the pinned dependency in the correct checkout repairs the artifact, but source should still bound this failure to one search-startup error.

## Security invariants

The repair must not weaken these existing boundaries:

1. Registered Project `.env` and `.env.backup` aliases and canonical targets remain universally unreadable and unwritable.
2. Registered Project browser-workbench aliases and canonical targets remain universally denied.
3. Wayang data, global Pi credentials/configuration, the command-guard identity PIN, Pi session roots, known transcript paths, launcher configuration, and pseudo-control roots retain their current lexical and canonical denials.
4. Symlink creation or retargeting invalidates a reusable snapshot before a later cooperative authorization decision. A same-UID process racing after the final check remains outside Wayang's documented isolation boundary.
5. Store/config changes cannot reuse a snapshot derived from older Project/session inputs.
6. If filesystem change observation is unavailable, a snapshot may be reused only within the current event-loop turn; the next turn must rebuild it. This preserves fresh fail-closed behavior without multiplying canonicalization inside one synchronous authorization phase.
7. Search/native dependency failure must not be retried or logged once per session.

## Design

### 1. Immutable protected-artifact root snapshot

Add an internal `ProtectedArtifactRootSnapshot` containing the already deduplicated arrays for:

- non-transcript universal read denies;
- Pi session storage roots;
- known transcript paths;
- complete read/write denies;
- restricted-agent denies.

Build all derived arrays in one pass. Existing getter functions become projections of this single snapshot instead of recursively rebuilding overlapping root sets.

### 2. Manifest-key invalidation

Derive a cheap, I/O-free manifest key from every lexical input that affects the snapshot:

- current data/config/agent/session directories;
- Wayang checkout secret aliases;
- all registered Project CWDs;
- all known durable Pi transcript paths.

Each getter recomputes only this lexical key. A changed key closes snapshot watchers and forces a rebuild before returning authority.

### 3. Filesystem-change invalidation

Install unreferenced `fs.watch` observers on the minimum existing parent directories that can change canonical targets: registered Project roots, session roots, Pi/config roots, the checkout root, and Wayang data root. Any event invalidates the snapshot synchronously.

If one or more required roots cannot be watched, schedule snapshot invalidation with `setImmediate`. All nested getters and repeated checks in the current synchronous phase share one exact snapshot; after the event loop yields, the next authorization rebuilds. This is especially important for FUSE-like filesystems that may not support reliable watch setup.

Provide a bounded test-only reset/observer seam; no production caller can mark an unsafe snapshot valid.

### 4. Call-site consolidation

- `agent-runtime.ts`: obtain one snapshot for each direct path decision and reuse it for read/write/restricted checks.
- `sandbox-bash.ts`: obtain one snapshot per policy build and reuse it for read, write, and restricted roots.
- `standard-transcript-authorization.ts`: obtain one snapshot per authorization call and reuse it for session-root and universal-deny checks, including before/after canonical transcript validation.

This changes the worst hot path from repeated nested all-Project canonicalization to one canonicalization per reusable snapshot.

### 5. Search dependency failure containment

Make policy purge acquire/validate the search DB once before iterating sessions. If initialization fails, report one bounded startup error and return one error count without attempting per-session deletes. Successful behavior and per-session purge isolation remain unchanged.

## Tests

Focused synthetic tests will cover:

1. overlapping getters share one canonicalization pass;
2. unchanged manifest reuses the snapshot;
3. Project/session manifest mutation rebuilds it;
4. watched `.env` and browser-root symlink retargeting invalidates and recomputes canonical targets;
5. watch-unavailable mode reuses only within one event-loop turn and rebuilds after `setImmediate`;
6. repeated transcript authorization does not scale canonicalization with transcript count inside a phase;
7. direct path and bash policies retain every existing universal denial;
8. a missing/unloadable search DB is attempted once, not once per session;
9. existing search, transcript, sandbox, workspace, and runtime suites remain green.

No test uses production homes, private Project paths, credentials, or transcripts.

## Validation and rollout

1. `make doctor`
2. focused backend tests for protected artifacts, agent runtime, sandbox bash, transcript authorization/catalog, and search indexer/watcher
3. backend build and typecheck
4. `make check`
5. production build in canonical checkout
6. verify pinned `better-sqlite3` loads under the service Node ABI before restart
7. restart Wayang once
8. measure time to port 8787 listen, `/healthz`, session creation, search health/query, backlog, CPU, and recent journal errors
9. run a tool authorization workload and confirm no repeated all-Project `readlink` storm

## Rollback

The code change does not migrate the store or alter private data. Rollback is a binary/source checkout rollback plus rebuild/restart. If snapshot validity becomes uncertain, invalidate it or stop the affected path/search operation; never bypass a deny root.

## Team roles

- **Lead/integrator:** Wren — design, implementation, production diagnosis, integration, and rollout.
- **Security reviewer:** independently inspect symlink invalidation, unwatchable-root behavior, fail-closed fallback, and transcript/body-read barriers.
- **Performance/concurrency reviewer:** inspect event-loop behavior, watcher lifecycle, cache invalidation races, and bounded failure fan-out.
- **Validation role:** run focused/full gates and production latency/search/session smoke tests without inspecting private content.

These roles may be executed sequentially if no independent agent session is available; review findings remain explicit before main integration.
