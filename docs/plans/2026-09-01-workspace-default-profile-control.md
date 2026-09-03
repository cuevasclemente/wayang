# Workspace-default Agent Profile control (issue #45)

**Status:** implementation authorized and in progress

**Date:** 2026-09-01

**Base:** `origin/main` at `a7405c2864d35a75a6287140a308bca03a2b5f4d`
**Worktree:** `fix/workspace-default-profile-control-20260901`

## 1. Goal

Expose the existing transactional `setWorkspaceDefaultAgentProfile()` primitive through every supported owner surface so a migration-seeded profile can become inert without deletion, raw-store editing, or reference replacement.

The concrete Tribe-Mac sequence must become supported:

1. inspect the current workspace default as redacted metadata;
2. set the workspace default from the migration-seeded Wren stable ID to Loom’s enabled stable ID;
3. retain already-moved Project defaults/allowlists unchanged;
4. disable Wren through ordinary profile update;
5. verify active/configuration references separately from preserved historical attribution.

## 2. Hard invariants

- The workspace-default mutation changes exactly `workspaceSettings.default_agent_profile_id`.
- It does **not** change Agent Profile rows, Project defaults, Project allowlists, session attribution, pending-switch rows, scheduled jobs/runs, Protected automation rows, messaging endpoints, capability rows/history, profile instructions, or project files.
- The target must exist and be enabled at validation and durable commit.
- Existing authenticated `/api` authentication and Origin middleware protect the REST route.
- The agent surface remains Standard-interactive-only, source-session-bound, exact-preview-bound, one-question owner-approved, expiring, and replay resistant.
- Reads return stable IDs, safe profile metadata, and bounded reference counts only. They never return profile instructions, Project instructions, transcript text, Protected content, credentials, store paths, or secret values.
- Historical session attribution is reported separately from active runtime use. It is not a disable blocker and is never rewritten by this setter.
- No Tribe-Mac access, raw-store access, profile deletion, service restart, or production mutation belongs to this implementation session.

## 3. API contract

Add an authenticated router mounted after the existing `/api` auth/Origin middleware:

```text
GET /api/workspace-settings
PUT /api/workspace-settings
  { "default_agent_profile_id": "<stable-id>" }
```

Both return:

```json
{
  "default_agent_profile_id": "<stable-id>",
  "default_agent_profile": {
    "id": "<stable-id>",
    "name": "safe label",
    "enabled": true,
    "resource_mode": "standard",
    "memory_access": "read_write",
    "default_provider": null,
    "default_model": null
  }
}
```

The actual safe summary may retain the existing instruction-redacted list projection, but it must never include `instructions`.

Add:

```text
GET /api/agent-profiles/:id/references
```

with bounded counts/booleans for:

- `workspace_default`;
- `project_defaults`;
- `project_allowlists`;
- `historical_sessions`;
- `running_sessions`;
- `pending_switches`;
- `scheduled_jobs`;
- `protected_automation_jobs` and historical runs;
- `messaging_endpoints`.

No referenced IDs, names, paths, prompts, or content are returned. A structured disable conflict should identify only categories that actually block disable (`workspace_default`, Project defaults, pending switches); idle/historical references remain inert after disable, while active streaming conflicts retain the existing runtime-impact response.

## 4. Agent workspace-control contract

Extend `wayang_workspace_read` with:

- `get_workspace_settings`;
- `get_agent_profile_references` with one stable profile ID.

Extend `wayang_workspace_change` with one exact mutation:

```ts
{
  mutation_type: "workspace_default_agent_profile_update",
  mutation: { default_agent_profile_id: string }
}
```

Preview binds:

- source session;
- exact current workspace-default stable ID;
- exact target stable ID;
- target safe label and enabled state;
- expiry and operation digest.

The approval summary explicitly states that existing Projects, sessions, schedules, and historical attribution remain unchanged. No-op target selection is rejected. Commit re-runs validation and the normal server-issued-preview/current-state checks, then calls the same repository primitive as REST/UI.

This mutation has no current-runtime lease because it changes only the fallback used for future/default Project creation and does not change authority for any existing Project/session pair.

## 5. Settings UI

On the existing **Agents** tab:

- add a visible **Workspace default** section above profile editing;
- show only enabled profiles in the selector;
- state that this is the fallback for future/newly registered Projects and does not switch current sessions or rewrite Project/session attribution;
- mark the default profile in the profile list;
- show the selected profile’s redacted reference summary with historical and active use clearly separated;
- when disable fails, display the backend’s safe blocker categories instead of only the previous generic message.

The UI uses stable IDs for every request and never infers identity or authority from a profile name.

## 6. Regression matrix

### Repository/transaction

- enabled target succeeds;
- missing/disabled target fails;
- forced persistence failure leaves the old default durable and in memory;
- same-ID set is idempotent through REST but no-op is rejected for agent approval.

### Nondestructive semantics

Before/after snapshots prove no changes to:

- profile rows;
- Project rows/defaults/allowlists;
- session attribution and pending switches;
- scheduled/protected-automation/messaging rows;
- capability associations/history.

A session historically attributed to the old profile remains attributed to it after workspace-default reassignment. Once no Project default and no pending switch references the old profile, ordinary disable succeeds without deleting or replacing that historical attribution.

### REST

- GET is instruction-redacted;
- PUT rejects unknown fields, missing/non-string IDs, missing profiles, and disabled profiles;
- reference endpoint returns only fixed count/boolean keys;
- app route is mounted after existing authentication and Origin middleware.

### Agent approval

- read actions return redacted metadata/counts;
- preview summary contains no profile instructions;
- exact approved update succeeds;
- no-op, cross-session, fabricated, stale, altered, or state-drifted commits fail through existing approval checks;
- mutation appears in the strict TypeBox schema and canonical digest.

### Frontend/E2E

A route-isolated Playwright regression opens Settings → Agents, observes the migration-seeded default, selects another enabled stable ID, submits exactly that ID, and sees the new default without any delete request.

## 7. Residual Wren-coupling audit

Create a short tracked report classifying every production reference named in issue #45 as one of:

1. **migration-only/stable-ID compatibility** — retained while old stores/sessions exist;
2. **generic runtime compatibility alias** — name remains for source compatibility but grants no identity authority;
3. **explicit optional experiment/integration** — separately configured and not activated by workspace default;
4. **remove/generalize now** — only if a reference incorrectly follows the workspace default or preserves accidental activation.

Do not broaden this urgent setter into an unrelated identity/runtime rewrite. Any retained coupling must be documented; any larger removal becomes a separate reviewed issue.

## 8. Validation

Run from the isolated worktree:

```sh
make doctor
node --import tsx --test \
  backend/src/workspace-api.test.ts \
  backend/src/workspace-transactions.test.ts \
  backend/src/workspace-control.test.ts \
  backend/src/workspace-settings-service.test.ts \
  backend/src/workspace-tools.test.ts
npm --prefix backend run build
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix e2e test -- workspace-default-profile.spec.ts
make check
```

If the broad suite has host-environment failures, compare with the exact base under the same environment; never weaken tests or security controls.

## 9. Integration, rollout, and rollback

1. Commit focused code/tests/docs on the task branch.
2. Review the diff and validation evidence; open/push a PR or publish the exact reviewed commit as Clemente directs.
3. Loom fetches the new exact commit and performs its existing backup-first Tribe-Mac build.
4. Loom temporarily starts Wayang on loopback, uses the supported setter to choose Loom, disables Wren, and verifies reference counts plus the final command-guard smoke.
5. Rollback is binary/source rollback plus the existing owner-private store backup. Merely rolling back the binary does not require rewriting the new workspace default; if semantic rollback is desired, use the same supported setter to restore the former enabled stable ID.

The implementation session does not restart local production Wayang or mutate Tribe-Mac.

## 10. Team roles and ownership

The available runtime has no subagent-spawn tool, so the owning session will execute serially while keeping the boundaries explicit:

- **Store/API owner:** transactional view/setter route and reference projection.
- **Approval owner:** canonical mutation, precondition, strict tool schema, adversarial tests.
- **Frontend owner:** Agents-tab selector, default marker, reference display, route-isolated E2E.
- **Security/integration reviewer:** nondestructive snapshot tests, route ordering, Wren-coupling classification, full-gate comparison.

No implementation role may inspect a real Wayang store, Tribe-Mac state, profile instructions, or credentials.

## 11. Deferred

- Native migration removal of the stable Wren/Neutral schema-compatibility rows.
- Renaming legacy source-level aliases that are already behaviorally generic.
- Redesigning optional Wren-specific comparative audio experiments.
- Replacing historical session attribution.
- Automatic multi-host deployment; that remains the separate reusable deployment-infrastructure task.
