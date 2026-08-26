# Search Backfill Policy-Projection Recovery

Status: approved for implementation on 2026-08-26
Branch: `fix/search-backfill-projection-20260826`
Base: `origin/main` at `03928f8e2804f6667d15bf5689b5af69a1d874bd`

## Goal and success criteria

Restore Wayang HTTP/authentication responsiveness during search backfill without weakening the fail-closed Standard-transcript authorization boundary.

Success means:

1. Search indexing still establishes a current complete Dream policy projection before transcript metadata/body access.
2. An unchanged store and policy generation do not rebuild or fsync the projection once per indexed session.
3. A changed store identity/fingerprint or policy generation forces a fresh durable projection before indexing proceeds.
4. Focused authorization/indexer tests and backend build pass.
5. After deployment, `GET /api/auth/status` and `/healthz` respond promptly while boot backfill runs.

## Incident evidence

- The deployed service accepted TCP on `127.0.0.1:8787` but returned zero HTTP bytes, leaving the UI at authentication bootstrap.
- The old backend consumed about eight CPU-hours over about nine hours, peaked at 6.4 GiB memory and 4.1 GiB swap, and required the systemd stop timeout's SIGKILL escalation.
- A fresh backend reproduced the stall. It rewrote about 8.6 MiB/s while the main event loop alternated between FUSE/page waits and CPU work.
- The canonical corpus currently contains 1,627 JSONL files totaling 3.62 GiB; the policy projection contains about 1,676 session decisions and is about 555 KiB.
- `indexSessionAttempt()` calls `writeDreamPolicyProjection()` before every session attempt. That function rebuilds every session decision, serializes the complete projection, fsyncs it, renames it, and fsyncs the directory. Boot `reindexAll()` therefore performs approximately quadratic metadata work and blocks the HTTP event loop.

## Design

### Freshness-cached projection publication

Add `ensureDreamPolicyProjection()` in `backend/src/search/policy-projection.ts`.

It will reuse the last successfully published in-process projection only when all of these still match:

- projection destination/data directory;
- `store.json` size;
- `store.json` mtime;
- `store.json` ctime;
- `store.json` inode;
- current policy generation.

Otherwise it delegates to the existing durable `writeDreamPolicyProjection()` path. The write path updates the in-process cache only after the atomic rename and directory durability work succeed.

This preserves the per-attempt freshness check. It is preferable to publishing only once at the beginning of a long batch because session ownership/path or policy can change while a large batch is running.

### Indexer and watcher integration

- Replace the unconditional write in `indexSessionAttempt()` with `ensureDreamPolicyProjection()`.
- Re-publish on a CAS retry automatically because every attempt calls ensure-current.
- Replace the immediate watcher hook's unconditional write with ensure-current (or rely on the indexer ensure) so a changed store still refreshes while unchanged state does not duplicate work.
- Keep `startDreamPolicyProjection()` and explicit policy-change refreshes on the durable force-write path.
- Do not alter exact transcript authorization, policy-generation CAS checks, mutation fences, query-time filtering, or transcript fingerprints.

## Tests

Use only synthetic temporary Wayang/Pi roots.

Focused regressions:

1. Publish a projection, index multiple sessions with an unchanged store, and assert the projection inode/source fingerprint remains unchanged. Under the current implementation, atomic rewrite changes the inode and this test fails.
2. Mutate/persist the synthetic store, index again, and assert ensure-current publishes a new projection that contains the new synthetic Standard-session decision.
3. Preserve existing denial, collision, header mismatch, metadata CAS, mutation-fence, and policy-change tests.

Validation commands:

- focused backend test for search/indexer and policy projection;
- backend TypeScript build;
- broader backend tests if focused checks pass;
- production backend/frontend build from the reviewed worktree.

## Deployment

1. Commit the focused change in the isolated worktree.
2. Review the exact diff and test evidence.
3. Fast-forward or cherry-pick the reviewed commit into canonical `main` only if the canonical tree remains clean and at the expected base.
4. Build canonical production assets.
5. Restart only `wayang.service` with human-approved privileged execution.
6. Verify service state, startup logs, `/healthz`, `/api/auth/status`, process CPU/I/O, and projection mtime stability while backfill runs.

## Rollback

- Revert the focused commit and rebuild if authorization tests fail or deployment regresses.
- The change does not migrate or delete `store.json`, transcripts, search databases, or policy projections.
- A stale/missing cache never authorizes anything: ensure-current falls back to the existing durable full writer, and downstream exact transcript authorization remains unchanged.

## Risks

- **False cache hit:** mitigated by destination plus inode/size/mtime/ctime and policy-generation comparison. Atomic store replacement changes inode/ctime even when size is unchanged.
- **Long-batch mutation:** mitigated by retaining ensure-current on every index attempt, including CAS retries.
- **Cross-test/config reuse:** cache identity includes the current projection destination.
- **Event-loop cost remains:** one cheap store stat and generation read per attempt remains; transcript parsing/indexing is unchanged and may still be substantial, but the pathological full-projection rebuild/fsync is removed.

## Deferred scope

- Moving all search indexing off the main event loop.
- Redesigning the JSON metadata store.
- Changing transcript-pagination structural indexing.
- Search schema changes or forced corpus rebuild.
- Adding a service-level watchdog or frontend auth timeout; both are useful follow-ups but not needed for this recovery.

## Roles and coordination

- **Lead/implementation (Wren):** plan, code, integration, focused validation, deployment.
- **Security reviewer subagent:** independently inspect freshness/race behavior and ensure no authorization boundary was weakened; no code ownership.
- **Test reviewer subagent:** inspect regression coverage and failure-mode fidelity; no code ownership.
- Canonical main and service restart remain lead-owned; no subagent may edit or deploy.
