# Live model switch queued for the next turn — 2026-09-04

## Request

Clemente asked that a Wayang session's model be changeable while the model is
currently generating or emitting output, with the change queued for the next
turn instead of being rejected.

## Prior behavior

`setSessionModel` / `setSessionDefaultModel` called `assertModelSwitchIdle`,
which rejected with 409 ("Live model changes require an idle session") whenever
the live runtime was streaming, had pending steering/follow-up messages, or
owned an active manual-compaction queue. The only supported path was
stop-and-rebuild: `stopRuntimeForModelChange` latched capability denial,
detached the browser lease, revoked host children, destroyed every runtime
surface, and only then persisted the new model; the next use rebuilt from the
unchanged Project privacy/RBAC decision.

## Key pi SDK findings (verified against the vendored 0.84.1-wayang sources)

- `AgentSession.createLoopConfig()` captures `model: this._state.model` once
  per run, and `runAgentLoop` uses `config.model` for every request in that
  run. Calling the public `AgentSession.setModel()` mid-run therefore leaves
  the in-flight turn on the old model; the next run (a queued follow-up or the
  next prompt) picks up the new model. This is exactly the requested
  "queued for next turn" semantics.
- `setModel()` has no streaming guard; it awaits `checkAuth`, then
  synchronously swaps `agent.state.model`, appends a durable `model_change`
  transcript entry, calls `settingsManager.setDefaultModelAndProvider`
  (persisting the session choice into pi settings defaults), re-clamps the
  thinking level, and emits `model_select` to extensions.
- `SettingsManager.save()` re-merges `globalSettings` + `projectSettings` and
  thereby DROPS any `applyOverrides()` values — so any settings write wipes
  previously applied memory-first compaction overrides from the merged view.
  Pi reads compaction settings dynamically per compaction
  (`getCompactionSettings()` at compaction time), so re-applying overrides
  after the write takes effect immediately.
- `SettingsManager` has a public `flush(): Promise<void>` that awaits the
  internal write queue; without it, a fresh `SettingsManager` (for example in
  default-model resolution) could read the transient leaked default.
- `globalSettings` is typed `private` in the SDK .d.ts but is a real public
  runtime field; Wayang reaches it through a narrow structural cast
  (`PiSettingsDefaultInternals`) to snapshot/restore the exact prior global
  default provider/model.

## Implementation

Branch `live-model-switch-queued` (worktree `.worktrees/live-model-switch-queued`),
commit `60ff912` on top of main `a543d29`.

- `backend/src/pi-bridge.ts`
  - New `liveRuntimeBusy(handle)` predicate (streaming, pending message count,
    or owned manual-compaction queue) shared by the live path and the teardown
    invariant guard in `stopRuntimeForModelChange`.
  - New `applyLiveModelSwitch(handle, row, project, model)`: calls the public
    pi `setModel`, then (in `finally`) restores the prior global settings
    defaults and flushes the settings write queue, then re-applies memory-first
    compaction overrides for the new context window and updates `handle.model`.
  - `setSessionModel`: validation order unchanged (existence, resolution,
    auth, memory-first) and now happens before any busy check; same-model +
    same-row is a no-op; a busy healthy runtime switches live and persists the
    row afterwards; idle runtimes keep the full stop-and-rebuild path. Returns
    `applied_live` so callers can surface the queued semantics.
  - `setSessionDefaultModel`: same live path; a busy runtime already on the
    default model only reconciles the stored row to null/null ("follow the
    default").
  - The old `assertModelSwitchIdle` 409 remains only as the invariant guard
    inside `stopRuntimeForModelChange` for busy runtimes that cannot switch
    live (no healthy handle, authority-denied latch).
- `backend/src/routes/ws.ts`: the `/model` command notice appends
  "(takes effect next turn)" when the switch was applied live.
- `frontend/src/panels/ChatPanel.tsx`: the model picker button is no longer
  disabled while `isAgentRunning`; its tooltip explains the queued semantics
  while running. The agent picker still requires an idle session (agent
  switching rebuilds loaders/tools and remains idle-gated).
- `docs/agents-and-project-settings.md`: new "Changing the session model"
  section documenting live/queued behavior, validation, transcript entry,
  settings-default restoration, and the unchanged idle stop-and-rebuild.

## Security review

- Authority neutrality: README states provider/model are fluid runtime choices
  that never confer or narrow authority; a live switch keeps every runtime
  surface (tools, hooks, host bash, browser lease, MCP runtime) exactly as it
  was, so the relaxed path does not widen anything. Idle switches retain the
  stronger fresh-surface rebuild.
- The settings-default restore prevents a per-session model choice from
  leaking into pi project/global defaults (which would otherwise change
  "default" resolution for `setSessionDefaultModel` and new sessions).
- Validation (unknown model, missing auth, memory-first context-window
  requirements) runs before the runtime is touched; rejections leave the live
  model, transcript, and DB row unchanged (regression-tested while streaming).

## Tests

- `pi-bridge.test.ts` "fluid model changes preserve pair authority while
  destroying every old runtime surface": the two former 409 blocks now assert
  live switches (queued follow-up and streaming), including `applied_live`,
  DB row, live `agent.state.model`, `handle.model`, no dispose/detach/host
  revocation, tools intact, durable `model_change` entry, settings defaults
  unchanged, and an unknown-model rejection while streaming that leaves
  everything untouched. The subsequent idle teardown phase (authority latch,
  orphan revocation, dispose-once, lazy-rebuild failure fail-closed, round
  trip, default-model flow) is unchanged and still passes.
- Full backend suite: 1160 tests, 1119 pass, 36 fail, 4 skips — the 36
  failures are pre-existing/environmental and byte-identical (by test name)
  to a stashed clean-worktree run; the change introduces no regressions.
- Backend `tsc -b` build, frontend production build, and frontend tests 9/9
  pass.

## Deferred / follow-ups

- Merge/integration of `live-model-switch-queued` into main (with push) is a
  separate owner decision; the branch is local-only.
- Mobile app has no model picker, so no mobile change was needed.
- The transient pi settings-default leak window (between pi's write and the
  restore) exists only within the now-awaited call path; `flush()` closes it
  before `setSessionModel` returns.
