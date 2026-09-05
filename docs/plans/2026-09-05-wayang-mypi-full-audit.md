# Wayang + myPi audit and remediation

## Authorization and scope

Owner requested a full codebase audit and authorized implementing evidenced fixes in isolated worktrees, emphasizing recent failures, performance, semantic correctness, general implementation, overengineering, and proportionate security for a single trusted user behind forward auth/VPN. No production restart, private-data migration/purge, credential access, remote publication, or deployment is implied.

Open design questions (nonblocking for independent review): which existing intentional boundaries may be redesigned, and whether user-visible feature removal should be implemented or recommended. Provisional baseline preserves remote access/origin controls, secrets, deliberate Protected separation, and explicit human approval boundaries. Challenge redundant enforcement and false containment claims, not merely all security code.

## Evidence and bases

- Wayang: clean main `b6a022528199c42695689af94212b45f9808ec95`; audit branch `audit/full-codebase-20260905`, worktree `/home/clemente/src/wayang-worktrees/full-audit-20260905`.
- myPi root is clean but on older `feature/runtime-extensions` at `ae842a8`, not current main. Audit implementation base is the reviewed deployed release `3c3c8f4` (`ops/tribe-guard-release-20260904`), a small guard-fix delta over main `493e5e1`; branch `audit/full-codebase-20260905`, worktree `/home/clemente/src/mypi-worktrees/full-audit-20260905`. Do not overwrite the root branch or unrelated skills.
- Wayang `make doctor`: zero failures/warnings; canonical checkout unchanged.
- Prior knowledge and Git independently identify the unmerged approved deterministic-automation retirement branch `feat/protected-automations-collapse-20260829` (`0acb557`). Audit its current integration viability instead of recreating 17k lines of teardown.
- Delegation restored after compatibility correction and owner `/reload`; real read smoke and six audit streams completed. Parallel work exposed child-read stale-policy gaps and producer debounce starvation; bounded child retry is installed, producer correction is source-only. No direct-process workaround.
- Final findings/coverage/validation/activation report: `docs/audits/2026-09-05-wayang-mypi-audit.md`.

## Method and acceptance bar

1. Inventory components and recent failure-fix history, then establish synthetic baseline gates.
2. Track coverage explicitly; a broad audit is not proof of absence of defects. Distinguish confirmed reproductions, source-supported risks, hypotheses, and design recommendations.
3. For each finding: severity, exact location, expected/actual behavior, reproduction/evidence, realistic trust model, minimal remedy, test, compatibility and rollback.
4. Prefer deleting redundant state or using an existing abstraction over adding another monitor, policy engine, cache, service, or wrapper. Require evidence before performance work; preserve bounded I/O where it protects availability.
5. Implement focused changes with regression tests and review each diff. Cross-cutting/user-visible changes wait only for consequential design input.
6. Run focused gates then integrated backend/frontend/script/extension gates and relevant synthetic E2E. Compare failures to the exact base rather than weakening tests. Never use real transcripts, browser profiles, credentials, or production stores as fixtures.
7. Publish a prioritized findings/coverage report with exact validation and unresolved questions. Journal progress and durable lessons. Leave clean commits for integration; no automatic production restart/push.

## Audit streams / team ownership

Once Agent Teams is available, spawn fresh-context read-only evaluators; implementation writers get separate worktrees from explicit audit commits and bounded files. Lead owns plan, integration, test execution (children may lack bash), and final synthesis. Children report concise future-value wiki handoffs, not write memory independently.

| Role | Scope | Priority evidence |
|---|---|---|
| Lifecycle evaluator | pi-bridge, ws, queues, runtime locks/impact, live model switch | abort/compaction phantom running, missing/late user echoes, shutdown hooks, next-turn switch |
| Frontend evaluator | ChatPanel, transcript controller, reconnect/delivery, artifacts/browser panels, mobile compatibility | stale responses, duplicate state, render cost, cancellation semantics |
| Storage/performance evaluator | db, catalog, search, transcript index/pagination/recovery, artifacts | synchronous full-store writes and projection fanout, FUSE hot-path repair, large-event meaning, worker bounds |
| Trust/simplification evaluator | auth/origins, project policy, runtime authority, approvals, apps/browser, Protected automation retirement | single-user controls versus same-UID claims; global denials; duplicated projections/state |
| Scheduler/integration evaluator | scheduled runs, messaging, interviews/approvals, TTS/title/warmup | completion/cancellation/restart semantics; unattended work cannot wait forever |
| myPi evaluator | guard, teams, hooks/todo/coordination/memory/skills/providers, install/release scripts | source/runtime divergence, unused tests, process cleanup, repeated scans, false-positive guard recovery |

## Milestones

- [x] Read repository guidance and initial prior decisions; inspect clean bases and doctor.
- [x] Create dedicated audit worktrees and this plan.
- [x] Resolve team-tool availability and distribute evaluation.
- [x] Complete baseline validation and explicit component coverage/gaps map.
- [x] Reproduce and prioritize high-impact findings; label remaining source-supported risks separately.
- [x] Review unmerged approved simplification and record separate integration/purge authority boundary.
- [x] Implement bounded corrections in isolated writer worktrees and independently review critical fixes.
- [x] Run integrated validation; retain the reproduced baseline E2E failure and type-coverage qualifications.
- [x] Write findings report and development journals.
- [x] Complete final wiki handoff; release lead advisory claims during closeout.

## Risks and rollback

- Main/myPi deployed release/root checkout differ; do not mistake an unmerged fix for a fresh defect or silently consolidate branches.
- Large stateful modules (ChatPanel ~8k lines; pi-bridge ~6k) amplify regression risk. Favor targeted state invariants over a speculative rewrite.
- Security subsystem retirement includes destructive private-store startup migration: code review/testing does not authorize running it against live data.
- Worktree dependencies must match lockfiles; no secret-bearing configuration copies. Test children and E2E use synthetic homes/data/env.
- Rollback focused code via inverse commits; preserve old implementation/base evidence. No removal of task worktrees until clean/integrated or explicitly abandoned.
