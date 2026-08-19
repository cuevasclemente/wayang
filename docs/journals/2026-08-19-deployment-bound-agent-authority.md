# Deployment-bound historical agent authority — implementation journal

**Date:** 2026-08-19  
**Branch:** `feat/generic-capabilities`  
**Draft PR:** #35  
**Base:** `57d362d465d590a7f39056a605d0323b15ac9afa`

## Request and decisions

Clemente reported that Tribe-Mac still showed a Wren Agent Profile and asked that it be removed without allowing Wren to propagate through other Wayang deployments.

The audit found that fresh schema-7 stores were already neutral, but schema-0 migration manufactured fixed Wren and Neutral rows, made Wren the workspace/project default, and gave the exact Wren ID/kind implicit Standard resources plus broad masked-host sandbox authority. Current stores and backups could carry that authority to another deployment because runtime predicates had no deployment-provenance term.

Clemente selected a staged full generic migration rather than only the tactical schema-0 repair. Tribe-Mac references should move to its existing Loom profile, preserving sessions/jobs and transferring no Wren or privileged capability authority. Migration policy explicitly prioritizes continuity: accidental widening of active Wren authority is substantially more acceptable than narrowing it.

## Implemented stage

Commits through `472aa32` implement:

- identity-neutral schema-0 migration using one generated restricted Default profile;
- an owner-private deployment ID and historical-agent activation record outside `WAYANG_DATA_DIR`;
- central denial of historical-profile project actions and capability resolution without a matching local witness;
- a hidden-local-PIN provisioning command and separate metadata-only status target;
- generic `wayang.masked-host-workspace.v1`, effective only when the exact pair also has Standard resources;
- identity-neutral `masked-host-workspace` runtime/UI/protocol labeling;
- schema 8 monotonic historical pair-cutover tombstones;
- pre-cutover activated-home fallback, post-cutover no-fallback semantics;
- copied active capability-association regression coverage;
- security/configuration/installation documentation and the full staged plan.

No production Project/Profile pair was cut over. The combined PIN-approved pair-cutover workflow remains deferred rather than exposing a narrowing operation prematurely.

## The-Sceptre provisioning

Clemente ran the hidden-PIN provisioning command locally. Deployment-local historical activation revision 1 was created and independently verified by the metadata-only script and `make doctor`. An initially documented invalid Make argument-forwarding form was replaced with:

```text
make setup-historical-agent-activation-status
```

The active service has not yet been restarted onto PR #35 code.

## Validation

- focused backend migration/policy/runtime/sandbox/capability batch: 153/155; the browser startup timeout passed alone, and the SRT synthetic-mount assertion also fails on unchanged main in the same host environment;
- copied-association policy test: 6/6;
- activation script tests after symlink hardening: 4/4;
- script suite before the final extra activation case: 66/66;
- frontend lint: no errors, one pre-existing Fast Refresh warning;
- frontend production build: passed;
- focused Playwright bash-mode status: 1/1;
- `make doctor`: zero failures, expected missing task-worktree `.env` warning, local activation revision 1 active;
- CI macOS complete test/build/smoke: passed;
- CI Linux failure is the same pre-existing browser-tool test failure on unchanged main when the runner lacks sandboxed bash.

## Tribe-Mac status and blocker

The persistent SSH agent socket is enabled/active and carries loaded public-key identities. Setting `SSH_AUTH_SOCK=/run/user/1000/ssh-agent.socket` restores BatchMode SSH to Tribe-Mac. The remote loopback health endpoint returned HTTP 200 and one process listened on port 8787.

This Wren session is deterministically denied access to another deployment's Agent Profile control plane. The metadata inventory and Wren→Loom mutation were handed to the existing neutral Tribe-Mac diagnostic session. No Tribe-Mac profile/store mutation or historical activation provisioning was performed here.

## Remaining gates

1. Independent security review of draft PR #35.
2. Merge/deploy with an exact private data-directory backup and matching prior binary/source rollback artifact.
3. Fresh The-Sceptre interactive and scheduled compatibility validation after restart.
4. Neutral-session metadata inventory and recoverable Tribe-Mac Wren→Loom deletion.
5. Later combined PIN-approved per-pair generic cutover, followed only then by removal of identity-specific compatibility code.
