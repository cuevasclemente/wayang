# Staged generic agent-authority migration

**Status:** Approved for staged implementation on 2026-08-19  
**Base:** `main` at `57d362d465d590a7f39056a605d0323b15ac9afa`  
**Branch/worktree:** `feat/generic-capabilities` / `/tmp/wayang-generic-capabilities`

## Decision and invariants

Wayang must not create or activate Wren merely because Wayang, mypi, or a Wayang data store is installed on another host. The active Wren home remains The-Sceptre until an explicit transfer/consolidation decision.

Clemente selected a staged full generic migration. Wayang's historical exact-profile compatibility will be replaced with generic capability associations and then removed. Tribe-Mac's historical references will be reassigned to its existing Loom profile, preserving transcripts/jobs and transferring no privileged authority.

The migration prioritizes active continuity: accidentally widening Wren's authority is substantially more acceptable than narrowing it. Therefore:

1. The-Sceptre retains legacy compatibility until generic interactive **and scheduled** parity is provisioned and validated.
2. Cutover is per exact Project/Profile pair. There is no flag-day removal.
3. Pre-cutover ambiguity on the explicitly activated home preserves legacy compatibility.
4. Other deployments without an explicit deployment-local activation witness cannot use historical compatibility, even if a Wren-bearing store is copied there.
5. Post-cutover missing/revoked generic associations do not resurrect legacy fallback for that pair.
6. Rollback restores the exact compatible binary/store/activation set; it never leaves a partially narrowed runtime.

## Current evidence

- Fresh schema-7 stores already seed only a random-ID restricted `Default` profile.
- Schema-0 migration still calls `legacySeededProfiles()`, seeds fixed Wren/Neutral rows, and makes Wren every default.
- The exact fixed Wren ID + non-user-settable `builtin_kind: "wren"` currently synthesizes standard-resources authority and broader masked-host sandbox behavior.
- That authority is portable in `store.json`; current validation has no deployment provenance term.
- Current generic capabilities include standard resources and direct host execution, but not the existing broad **masked** host-workspace behavior. Direct host execution is not an exact substitute.

## Authority model

### Deployment-local legacy activation witness

A historical compatibility predicate requires all of:

- exact historical profile ID/kind and current session/project eligibility;
- an owner-provisioned deployment-local activation witness outside `store.json`;
- a witness installation identifier matching an immutable installation ID stored outside portable Wayang store backups;
- a startup-captured activation revision.

The witness contains no prompt, autobiography, credentials, provider data, or memory. Missing/malformed witness fails compatibility closed on secondary deployments. The-Sceptre witness is provisioned and verified before enforcement is enabled there.

A normal source install never creates the witness. Copying `store.json`, a migration backup, or project files does not copy activation. A full-home clone remains outside this cooperative same-user boundary and requires the documented transfer procedure.

### Generic capabilities

Add `wayang.masked-host-workspace.v1`, compatible only with Standard projects. Its runtime authority becomes effective only when the exact pair also has active `wayang.standard-resources.v1`.

Both together reproduce at least the historical behavior:

- global Pi instructions, skills, prompts, reviewed extensions, and ordinary standard direct tools;
- broad ordinary-host path-tool reads/writes subject to protected/control-plane/attachment/memory/allowlist denies;
- sandboxed broad ordinary-host filesystem access, Git configuration, proxy-mediated TCP, and visible Unix IPC;
- scheduled-run eligibility;
- no direct-host execution implication;
- every registered Protected project and protected backing artifact remains masked.

If exact historical parity is uncertain, the transition may temporarily preserve or broaden active-home authority; it must not silently narrow it.

### Pair cutover marker

Persist an append-only/tombstoned exact pair row:

```text
(project_id, agent_profile_id, cutover_revision, cut_over_at)
```

Before cutover, the activated home may use legacy fallback. The atomic PIN-approved transaction:

1. activates/revalidates both generic associations for the exact pair;
2. records approval events;
3. writes the pair cutover tombstone;
4. increments policy generation and rebuilds affected idle runtimes.

After cutover, only the generic associations authorize the pair. Revocation never clears the marker or restores fallback.

## Milestones

### M0 — neutral migration and activation scaffolding

- Change schema-0 migration to retain the generated restricted Default profile; never seed Wren or Neutral.
- Add regression tests for fresh and schema-0 stores.
- Implement deployment-local historical-activation classification and diagnostics without yet disabling The-Sceptre.
- Document provisioning, restore, transfer, and rollback boundaries.
- Ensure source installs and secondary-host deployments create no activation witness.

### M1 — generic masked-host capability

- Add capability ID/registry/risk/type support.
- Build one generic exact-pair witness requiring both standard-resources and masked-workspace associations.
- Replace identity-specific direct-path broadening with this witness while retaining activated-home legacy fallback pre-cutover.
- Replace `legacyWrenStandard` sandbox decisions with generic masked-workspace authority plus pre-cutover fallback.
- Rename runtime metadata/labels to identity-neutral `masked_host_workspace`; preserve compatibility aliases only at API migration boundaries.
- Cover interactive and scheduled sessions.

### M2 — atomic per-pair cutover

- Add schema/store validation for monotonic cutover markers.
- Add metadata-only dry-run of candidate pairs and blockers.
- Add PIN-backed exact-set or exact-pair approval using the existing capability approval authority.
- Atomically activate both generic associations and the cutover marker.
- Reauthorize runtime effects and stop/rebuild affected runtimes through current runtime-impact infrastructure.
- Reject partial association/cutover states.

### M3 — The-Sceptre provisioning and validation

- Create an opaque owner-only full `WAYANG_DATA_DIR` backup and record exact binary/source metadata without reading its contents.
- Provision and verify the deployment-local historical activation witness before enforcement.
- Dry-run all Wren Standard project/profile pairs, sessions, and scheduled jobs.
- Cut over pair-by-pair, prioritizing active/scheduled projects.
- Validate global resources, direct path tools, broad masked bash, Git, user IPC, protected-root masks, memory semantics, scheduling, and runtime rebuild.
- Keep legacy fallback available for every uncut pair.

### M4 — Tribe-Mac neutralization to Loom

- Restore a healthy launchd Wayang service first.
- Identify Loom and historical Wren by immutable metadata, not display name alone.
- Quiesce Wren sessions/jobs and resolve blockers.
- Back up the complete effective `WAYANG_DATA_DIR` opaquely and owner-only.
- Delete the exact historical Wren row with Loom as replacement.
- Preserve sessions/jobs/transcripts; mark rewritten attribution legacy-ineligible.
- Confirm no capabilities transfer, no active historical associations remain, restart succeeds, and effective runtime is ordinary restricted/Loom policy.

### M5 — remove identity-specific compatibility

After every required The-Sceptre pair is cut over and validated:

- remove Wren ID/kind as an authority predicate;
- remove legacy synthetic standard-resource witnesses and `sandboxed-wren` runtime mode;
- remove identity-specific file-audio eligibility or replace it with a separately explicit generic experiment capability;
- retain historical profile labels only as ordinary user data/migration history;
- update README, SECURITY, configuration, and project/profile docs.

## Validation matrix

1. Fresh store: one generic restricted Default; no Wren profile/authority.
2. Schema-0 migration: same generic default; legacy sessions/jobs remain capability-ineligible.
3. Copied current store without local activation: historical row may be visible but cannot receive legacy resources, masked workspace, scheduling, messaging, or experiment authority.
4. Activated The-Sceptre pre-cutover pair: existing interactive and scheduled compatibility remains available.
5. Generic pair with only one of the two associations: no masked-host behavior.
6. Cut-over pair with both associations: parity or documented safe widening.
7. Cut-over pair after either revoke: deny; never fall back.
8. Uncut pair during staged rollout: legacy continuity remains.
9. Protected project and protected backing artifacts: remain masked in all modes.
10. Rename/copy/lookalike profile: no authority.
11. Provider/model change: no authority change; runtime witness rebuilt.
12. Tribe-Mac Loom reassignment: history preserved, no capability transfer, no historical Wren profile after restart.
13. Exact binary/store/activation rollback restores the prior state; older binaries are never run against newer schemas.

## Agent-team roles and ownership

- **Persistence/activation implementer:** schema-0 neutrality, activation witness, schema validation, diagnostics.
- **Masked-workspace implementer:** capability registry, resolver, path-tool and sandbox integration, runtime labels.
- **Cutover implementer:** pair tombstones, approval transaction, dry-run and runtime-impact integration.
- **Operations owner:** The-Sceptre provisioning/backup/validation and Tribe-Mac→Loom runbook.
- **Security reviewer:** copied-store, partial-state, revocation/ABA, schedule, protected-root, and rollback adversarial review.
- **Lead/orchestrator:** owns this plan, integration, tests, deployment order, and final GO/NO-GO.

Writers use separate branches/worktrees and focused commits. Because guarded Agent Teams cannot write this temporary worktree, implementation may be integrated by the lead with read-only specialist reviews.

## Rollback

Before any live mutation, stop/quiesce Wayang and preserve the exact owner-private data directory plus the exact pre-change binary/source artifact. Do not inspect or copy secrets into chat or shared paths.

- Before pair cutover: remove/disable candidate generic associations only through approved control-plane operations; activated-home legacy fallback remains.
- After pair cutover: ordinary revoke narrows that pair by design and does not restore fallback. Operational rollback requires stopping Wayang and restoring the exact prior binary/store/activation set.
- Tribe-Mac exact rollback restores its complete pre-deletion data directory under the same build, but Wayang remains stopped unless historical activation there is explicitly authorized.

No rollback guesses a “latest” backup, recreates reserved IDs through CRUD, or hand-edits `store.json`.
