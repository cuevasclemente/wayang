# Downstream Pi proposal: race-safe session metadata and durable publication

**Status:** discussion draft; not an upstream acceptance claim

## Motivation

Embedded hosts and extensions need mechanism-level session primitives without requiring Pi to adopt any automatic naming policy. The concrete failures are stale automatic names overwriting human intent, transformed input obscuring what the human submitted, durable registries publishing a session path before its JSONL exists, and append/migration races losing or splitting history.

## Minimal generally useful API

1. **Session-name provenance and compare-and-set**
   - Add optional `origin: "human" | "automatic"` to `session_info`; missing legacy origin remains human/unknown.
   - Expose `getSessionNameState()`, unconditional `appendSessionInfo()`, and exact-revision `appendSessionInfoIfCurrent()`.
   - Compare both normalized name and metadata entry ID so clears and same-value human rewrites invalidate stale automatic work.
   - Keep `session_info` side metadata: it never advances the conversation leaf or becomes a branch target.

2. **Immutable original input**
   - Add readonly `InputEvent.originalText`, captured before the first input transform.
   - Preserve progressive `event.text` transforms while every handler observes the same original value.

3. **Exact optional new-session IDs**
   - Allow a validated caller-supplied session ID through manager, runtime, extension, and RPC creation paths.
   - Keep generated IDs as the default; collisions and invalid IDs fail rather than silently substituting another identity.

4. **Explicit materialization**
   - Expose `SessionManager.materialize()` for hosts that must publish a complete no-clobber JSONL before recording its path.
   - Preserve Pi's deferred-save default for callers that do not request it.

5. **Physical JSONL transactions**
   - Canonicalize symlink aliases and fail closed on hard-linked sessions when pathname locks cannot establish one physical identity.
   - Perform expensive transcript/name scans through stable descriptor/path revision snapshots outside the commit lock.
   - Under a short shared lock, verify device/inode/size/mtime/ctime and then append one fsynced record or atomically replace a prepared migration.
   - Retry bounded revision races; fail closed on malformed partial tails or persistent contention.
   - Reconcile interrupted materialization only when generated aliases and the destination prove the same inode and expected content.
   - Leave manager memory unchanged when persistence fails.

## Downstream policy remains downstream

The API should not choose a title generator, provider, model, timing threshold, prompt, disclosure policy, retry schedule, or UI. A downstream automatic namer may observe state, generate asynchronously, and call the CAS method; `{ written: false }` is normal contention. Human rename paths use unconditional human-origin writes.

## Compatibility and migration

- The metadata and input fields are additive; existing JSONL requires no format bump.
- Existing callers retain generated IDs and deferred persistence.
- Legacy sessions continue through ordered in-memory migration; forks must migrate snapshots before stamping a current-version header while leaving source bytes unchanged.
- Consumers must tolerate new fail-closed errors for malformed, dangling, hard-linked, or unexpectedly replaced session files.
- Canonical opening may return a physical target path rather than the supplied alias.

## Proposed review decomposition

1. Physical JSONL snapshot/transaction foundation and cross-process race tests.
2. Session-name provenance and exact-revision CAS.
3. Immutable `InputEvent.originalText`.
4. Optional exact session identity across manager/runtime/RPC.
5. Atomic materialization and crash reconciliation.
6. Integration hardening for migration, fork, aliases, malformed tails, and platform behavior.

`originalText` can be reviewed independently. Session-name CAS should not be presented as cross-process race-safe without the physical transaction foundation.
