# Protected-artifact hot-path and search startup repair — 2026-08-28

## Incident

Creating a Wayang session from the Memoriki project returned 5xx/timeouts. The backend port remained present but accumulated a listen backlog and stopped serving HTTP. The Node main thread showed intermittent FUSE waits and elevated CPU.

A bounded privileged syscall trace (paths and operation metadata only; no file contents) established that Wayang repeatedly canonicalized protected configuration/browser paths for every registered Project. One historical Project registration is on a mergerfs/FUSE-backed filesystem. `getProtectedArtifactReadRoots()`, `getProtectedArtifactWriteRoots()`, and restricted-root derivation recursively repeated the same all-Project `realpath` work for direct path tools, sandbox policy, and transcript/search authorization, starving the event loop.

The first recovery restart exposed a separate latent deployment problem: the `better-sqlite3` native binding had been removed/replaced while the prior process still held the deleted binary mapped. After restart, search DB initialization failed. `purgePolicyDeniedSessions()` retried and logged the same missing-binding error once per denied session before the HTTP listener could bind. Rebuilding the pinned dependency in the canonical backend restored the correct Node 26 ABI artifact; source now also contains that failure to one attempt.

## Implemented repair

- Added one immutable protected-artifact root snapshot containing non-transcript, session-root, known-transcript, read/write, restricted-agent, Project secret, and Project browser roots.
- Added a cheap durable store-publication generation so the lexical manifest is rebuilt only after a published store change, not per transcript/path check.
- Derived one manifest fingerprint from current Project/session/config path inputs and canonicalized each unique input once per snapshot.
- Added targeted unreferenced filesystem watchers for relevant directory entries. Store writes and ordinary Project edits do not invalidate the snapshot.
- Kept unwatchable roots fail-closed and fresh with compact no-follow identity probes for only the exact protected entries covered by a failed watcher. Changed probes rebuild the snapshot; uninspectable probes become turn-scoped.
- Kept any symlink-derived canonical snapshot turn-scoped even when watches appear available, covering nested symlink-chain retargeting that a lexical-parent watcher cannot prove unchanged.
- Consolidated direct tool, sandbox, and transcript authorization call sites onto one coherent snapshot.
- Made search policy purge validate search DB availability once before iterating sessions.

No store schema, Project registration, transcript, browser profile, credential, or private file content was changed by the source repair.

## Validation before integration

- `make doctor`: 0 failures (expected isolated-worktree configuration/build warnings before install).
- `make install`: completed from committed lockfiles.
- Focused protected-artifact tests: 5/5, including FUSE-like watch failure with unchanged/changed identity probes.
- Focused agent-runtime tests: 23/23.
- Focused search indexer tests: 25/25.
- Focused session catalog/session tests: 38/38.
- Focused sandbox tests, including actual nested sandbox execution: 7/7.
- Focused DB workspace/single-writer plus protected-artifact tests: 19/19 after the final symlink-turn scope change.
- Backend TypeScript build: pass.
- `make check`: backend 1,114 pass / 0 fail / 6 skip; frontend 4/4; scripts 63/63; backend/frontend production builds pass. One pre-existing frontend fast-refresh warning and existing Vite chunk-size warnings remain.

## Production rollout and validation

Canonical main fast-forwarded to `b232054`, the backend/frontend production builds completed, and the pinned `better-sqlite3` binding loaded successfully under Node 26 before restart.

Production results:

- pre-fix restart: approximately 16 minutes before the listener callback; ordinary Projects and search-health requests timed out at 10 seconds;
- first cached-root deployment: port usable in 13.1 seconds; search/project/session-route responses returned HTTP 200/200/400 rather than 5xx, but one mergerfs Project could not install an `fs.watch`, so concurrent search still caused per-turn root rebuilds;
- final identity-probe deployment: port usable in 13.4 seconds and listener callback at 29 seconds while startup services completed;
- warm Projects: HTTP 200 in about 1 ms;
- synthetic malformed session-create validation: expected HTTP 400 in about 7 ms;
- real Memoriki session smoke: HTTP 201 followed by reversible archive HTTP 204, 5.1 seconds combined; the archived row is titled `Wayang repair validation (archived)`;
- synthetic no-result search: HTTP 200 in about 1.1 seconds;
- post-fix syscall trace during search: eight `statx` calls and zero `readlink`/all-Project canonicalization storm;
- service journal after final restart: no SQLite binding, policy-purge, catalog, or search errors.

Five concurrent search requests still serialize at roughly 1.1 seconds each and can delay health by about 5.9 seconds. The post-fix trace shows this is no longer protected-root filesystem work; it is the existing synchronous search/SQLite query path over the large index. It no longer produces the reported 500 and is a separate future search-latency optimization, not a rollback blocker for this incident.

## Rollback

The change is binary-only and migration-free. Rollback is a source/binary rollback and restart; private data restoration is not required.
