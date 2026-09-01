# Issue #45 — workspace-default Agent Profile control and residual Wren-coupling audit

**Date:** 2026-09-01

**Scope:** supported workspace-default reassignment without profile deletion or attribution replacement
**Security boundary:** source/tests only; no real store, profile instructions, transcripts, Protected data, credentials, Tribe-Mac state, or service mutation was accessed

## Decision

The migration-seeded Wren stable ID remains compatibility data, not a required workspace default. Owners can now inspect and change `workspaceSettings.default_agent_profile_id` through:

- authenticated `GET` / `PUT /api/workspace-settings`;
- Settings → Agents → Workspace default;
- source-session-bound `wayang_workspace_read` and exact-approved `workspace_default_agent_profile_update`.

The setter calls the existing atomic repository primitive and changes exactly one field. It does not replace references. Tests snapshot Agent Profiles, Projects, allowlists, sessions, pending switches, schedules/runs, Protected automation, messaging, and capability rows before and after commit and require them to remain unchanged. Persisted session attribution is separately visible as a redacted count and remains attached to the old stable ID after disable.

A redacted reference view is available through authenticated `GET /api/agent-profiles/:id/references`, the Agents UI, and `get_agent_profile_references`. It separates workspace/Project defaults, explicit allowlists, persisted session attribution, live runtimes, pending switches, scheduled jobs, Protected automation rows/history, and messaging endpoints. Profile-disable conflicts return only actual blocker categories; runtime streaming conflicts retain their existing guarded response.

Fresh schema-8 stores already seed one generated, project-only **Default** profile and do not seed a named Wren identity. The Wren and Neutral fixed IDs are created only by legacy-store normalization or retained from old schemas.

## Residual production-reference classification

The issue named fourteen backend files. Current source was reviewed by exact production references rather than by profile name alone.

### 1. Migration-only and stable-ID compatibility — retain

- `backend/src/db.ts`
  - `legacySeededProfiles()` and schema-0/1 normalization preserve old stable IDs and recreate the former default only while migrating old stores.
  - `emptyStore()` uses a generated generic Default profile.
  - Legacy Project defaults remain Wren only as migrated historical/configuration state and can now be changed through supported controls.
- `backend/src/workspace-types.ts`
  - fixed Wren/Neutral IDs and `builtin_kind` are schema compatibility metadata;
  - names do not confer authority.
- `backend/src/legacy-wren.ts`
  - the compatibility predicate requires the exact fixed ID, exact non-user-settable kind, `enabled === true`, exact session attribution, no pending switch/quarantine/ineligibility, and a Standard Project;
  - changing a workspace default does not satisfy it, and disabling the profile makes it false.
- `backend/src/sandbox-bash.ts`
  - legacy broad filesystem/Unix-socket behavior is selected only through the exact predicate above;
  - a disabled former default cannot receive it.
- `backend/src/agent-runtime.ts` and `backend/src/pi-bridge.ts`
  - exact-Wren checks gate only the separately configured comparative file-audio experiment and the migration compatibility sandbox mode;
  - neither follows a profile name or the workspace-default field.

These references remain while legacy stores and sessions are supported. Removing them requires a separate schema/runtime migration with rollback rehearsal; issue #45 should not silently redefine old-session behavior.

### 2. Generic runtime compatibility aliases — retain temporarily

- `backend/src/wren-host-bash.ts`
  - explicitly deprecated incremental-build aliases over generic `host-execution.ts`;
  - comments and implementation state that they do not preserve Wren identity, UUID, kind, flag, or old authorization semantics.
- `backend/src/agent-switch-authority-lifecycle.ts`
  - accepts the stale wire label `wren_host` only to reject it and require a fresh runtime.
- `backend/src/host-execution.ts`
  - `sandboxed-wren` remains a runtime mode label for the exact compatibility path, not a workspace-default or name-based grant.

Renaming/removing these aliases is source/protocol cleanup, not needed to make the old profile inert.

### 3. Explicit optional experiment — retain behind its existing gates

- `backend/src/config.ts`
- `backend/src/audio-experiment/production.ts`
- `backend/src/audio-experiment/tools.ts`
- `backend/src/audio-experiment/types.ts`

These names describe a disabled-by-default A/B comparative experiment with a deliberately frozen Wren capsule and public condition labels. Production eligibility requires the deployment flag, reviewed composition, an interactive current runtime, the exact enabled migration profile, and a Standard Project. The workspace default alone never activates it. Existing `SECURITY.md` and `docs/configuration.md` describe the separate artifact/provider boundary.

### 4. Misleading generic comment — generalized now

- `backend/src/messaging/connectors/matrix/service.ts`
  - the connector-neutral durable transaction port had a comment saying “Wren must implement” even though no profile identity participates;
  - the comment now names the gateway host and explicitly says Agent Profile names/workspace defaults are irrelevant.

### 5. No remaining issue-#45 activation dependency

No reviewed production reference uses `workspaceSettings.default_agent_profile_id` as a Wren-specific feature gate. Its generic consumers are Project default fallback and disable/reference validation. After supported reassignment and profile disable, the former Wren profile cannot be selected as workspace fallback or create exact-enabled compatibility authority. Inert rollback copies and historical stable-ID attribution may remain without activation.

## Tribe-Mac completion contract

Once the reviewed commit is the exact Loom deployment target, Loom can:

1. start the new build on loopback under its existing backup-first procedure;
2. read redacted workspace settings and confirm the current stable ID;
3. set the workspace default to Loom through the API, UI, or approved agent mutation;
4. confirm Project defaults/allowlists and schedules are already Loom-only as intended;
5. confirm Wren has no workspace/Project default, explicit allowlist, pending switch, running session, schedule, active Protected automation job, or messaging endpoint;
6. disable Wren without deletion;
7. preserve any reported persisted session attribution as inert history rather than rewriting it;
8. run the final Loom and command-guard smoke.

A zero count for persisted session attribution is **not** required and must not be manufactured. Historical attribution and activation-capable references are intentionally reported separately.

## Validation status

Completed in the isolated task worktree:

- `make doctor`: 0 failures, one expected warning because the task worktree has no private `.env`; secret contents were never read or copied.
- focused workspace repository/API/control/service/tool suite: 34/34 passed.
- focused authentication and Origin suite under the repository test-default browser-host selector: 7/7 passed.
- compatibility regressions for pending switches/repository disable messages plus the expanded workspace service: 27/27 passed.
- frontend unit tests: 7/7 passed.
- frontend lint: 0 errors and one unchanged Fast Refresh warning in `SessionResultSnippet.tsx`.
- backend and frontend production builds: passed; the existing frontend bundle-size warning remains.
- new route-isolated workspace-default Settings regression: 1/1 passed.
- all previously existing Settings-open E2E tests affected by the new initial fetch: 9/9 passed.
- script suite: 63/63 passed.
- `git diff --check`: passed.
- broad backend suite: 1,137 passed, 4 failed, 8 skipped. The exact base `a7405c2` reproduces the same four failures under the same host environment: one ambient installed `memory_review_complete` tool exceeds an old exact-tool-set fixture, and three background-search/session pause tests observe the host’s ambient pause state. The two initial feature-caused message-compatibility failures were corrected and their original tests now pass.

No failure is attributable to issue #45 after exact-base comparison. A rollout still requires review/merge, a clean exact commit target, Tribe-Mac’s existing backup-first build, and Loom’s target-local mutation/verification.
