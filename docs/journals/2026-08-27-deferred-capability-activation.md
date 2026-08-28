# Deferred capability activation

**Date:** 2026-08-27  
**Integrated:** `main` at `82da1a2`  
**Plan:** `docs/plans/2026-08-27-deferred-capability-activation.md`

## Problem

Capability association review rejected a Project–Agent pair whenever any affected runtime was streaming, queued, starting, or mutation-locked. The Settings UI collapsed the resulting HTTP 409 into “Capability state changed while creating the review,” even though no durable capability state had changed.

The owner clarified the required lifecycle: capability authority remains attached to the immutable Project–Agent pair; current and already-queued work should finish under the old captured runtime authority; the durable grant should become available immediately to newly constructed runtimes; later work on an old handle should use a coherent fresh runtime.

## Implementation

- Capability previews now accept bounded idle, streaming, queued, starting, and mutation-locked runtime status as review information. Runtime status/list drift does not invalidate the authority-state review. More than 64 affected runtimes returns the distinct `runtime_limit` contract.
- Activation synchronously advances a separate process-local activation generation immediately before the durable association/audit commit. Runtime construction begun before that latch cannot publish a mixed old/new authority set.
- Published old handles become refresh-pending without reusing destructive revocation behavior. Current and already-accepted queued work retains its captured tools, resources, execution mode, browser leases, and output flow.
- New top-level work is rejected on a refresh-pending handle. Explicit accepted-work leases cover browser, scheduled, messaging, resend, interview-continuation, model/export/reload, and manual-compaction paths.
- Retirement waits for streaming, SDK queues, accepted-work leases, browser provenance, mutation locks, manual compaction, and source-marker persistence. Transient source-marker failures receive bounded retries.
- Manual-compaction FIFO records accepted before activation drain as old-runtime continuations; later admissions are rejected. First-accepted-message title generation remains intact after conflict resolution.
- Archived sessions are rejected during and immediately before runtime publication. Late old-handle teardown uses identity-exact map cleanup, and human-input bridges are cancelled synchronously on revocation.
- Legacy-Wren Standard-resource witnesses preserve accepted old-runtime work across an exact absent/inactive-to-active durable transition while revocation, later revision drift, eligibility loss, Project drift, and runtime-generation drift remain denied.
- Revocation remains durable-denial-first and immediate.

## Validation

- Focused combined backend gates passed, including final post-rebase activation, compaction, title, Standard-resource, approval, bridge, and human-gate suites (`134/134` and `78/78` at major integration gates; final focused suites also passed).
- Relevant Playwright suites passed `17/17` for workspace capabilities and compaction FIFO.
- Backend and frontend production builds passed before and after integration.
- Full backend gate: `1072 passed / 1 failed / 6 skipped`; the sole questionnaire timing failure was already observed on the preceding compaction release and passed immediately when rerun alone.
- Frontend tests passed `4/4`; lint completed with one pre-existing Fast Refresh warning and no errors.
- Script suite: `62 passed / 1 failed`; the credential-helper synthetic socket test is blocked/failing in the current guarded environment and is unrelated to these paths.
- Multiple independent security/concurrency reviews were run through integration; final post-rebase release review returned **GO** with no High/Medium finding.

## Deployment

Production assets were built from `82da1a2`, `wayang.service` was restarted, and post-restart smoke verified:

- service active;
- `/healthz` returned `{"status":"ok"}`;
- production served the newly built frontend assets.

No capability association was created or revoked by the implementation or smoke test. The owner can now retry the intended association through Settings; entering the existing identity PIN remains the human approval action.
