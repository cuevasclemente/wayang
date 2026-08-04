# Finance Monarch MCP — Milestones B/C/D synthetic gate

Date: 2026-07-28

## Authority status

This report records synthetic architecture evidence only. It does not authorize source acquisition, staging, compilation of upstream Monarch, credentials, login, activation, provider calls, or Finance data. The reviewed-provider registry remains empty and the package candidate remains stage-ineligible.

## Exact review roots

- Frozen containment topology: `backend/src/restricted-mcp/milestone0/`
- Catalog schema/lifecycle/approval: `backend/src/restricted-mcp/catalog/`
- Descriptor-bound installer: `backend/src/restricted-mcp/installer/`
- Typed provider runtime/broker: `backend/src/restricted-mcp/provider-runtime/`
- Cross-milestone CAS test: `backend/src/restricted-mcp/monarch-integration.synthetic.test.ts`
- Stage-ineligible package candidate: `backend/src/restricted-mcp/provider-packages/monarch-readonly-v1/`
- Package audit: `docs/reports/finance-monarch-package-audit.md`
- Governing rollout: `docs/plans/finance-monarch-readonly-rollout.md`
- Frozen P report: `docs/reports/finance-monarch-milestone-p.md`

## Implemented synthetic contracts

### B — installer

- Linux descriptor helper uses held directory FDs, `openat2` beneath/no-symlink/no-magic-link resolution, descriptor identity checks, and no-replace publication.
- Exact normalized manifests bind root, directories, files, modes, sizes, and hashes.
- Post-build output is independently descriptor-observed and revalidated; source/build input is not promoted as the runtime artifact.
- A native cross-process lease excludes reconcile/materialize/worker/promote races.
- Production helper/worker factories are deliberately unavailable: synthetic structural wrappers cannot establish production authority.
- Private frozen-P construction remains unwired and fail-closed pending a separately reviewed application integration.

### C — runtime/broker

- C consumes D's exact policy bytes and binds their SHA-256 digests; first-read approval must bind the exact D `query-allowlist.json` digest.
- Exact 15 MCP tools, eight GraphQL operations, raw bounded provider JSON/decimal lexemes, Gregorian dates, canonical integer monetary output, response schemas, output schemas, bounds, and zero-action `progress_vs_goals` are enforced.
- The approved `financial_overview` plan now states the executable nested variables, UTC-derived month and 12-month ranges, query identities, 500-row pagination, page indexes, call bounds, stop authority, and zero retries. C materializes the executable calls from that structure and rejects any drift.
- The child receives no credential reference/value/query/endpoint authority and uses inherited anonymous one-way pipes: child FD3 write-only and FD4 read-only. Final socket denial remains in force.
- Backend broker consumes the opaque invocation lease, permits one in-flight child frame, makes terminal/error state sticky, reauthorizes every provider step/page and final delivery, propagates cancellation/deadline/generation, and reconstructs one exact canonical MCP text item from typed broker results.
- Durable stage, terms, activation, and first-read evidence is exact-bound. First-read CAS transitions `first_read_authorized → first_read_dispatched` before first transmission and `first_read_dispatched → enabled` only after bounded output construction and cleanup.
- Credential replacement invalidates active old-generation leases. Invoke/close/restart/deactivate are serialized; deactivation denies authority before cleanup and persists cleanup failure while retaining cleanup capability.
- Direct Node synthetic spawn is test-only; production requires frozen-P launcher/cgroup evidence and remains fail-closed while D is unreviewed.

### D — package policy candidate

- Exact read-only tool/query/input/output/broker policy is statically validated.
- Locally computed candidate digests are distinct from independent review.
- All source, patch, toolchain, closure, binary, reproducibility, terms, and B/C integration gates remain false.
- Placeholder/non-applicable patches are rejected for staging.

## Validation evidence

```text
Catalog approval/lifecycle suite: 84 pass, 0 fail, 0 skip
Runtime/broker plus two-store composition: 33 pass, 0 fail, 0 skip
Schema-v2 durable first-read composition: included, 1 pass
Installer focused suite: 17 pass, 0 fail, 0 skip
Focused A/B/C/D total: 134 pass, 0 fail, 0 skip
Milestone-P host containment: 13 pass, 0 fail
Milestone-P FD3/FD4 RPC: 9 pass, 0 fail
Combined systemd/cgroup/RPC: 1 pass, 0 fail; FEASIBLE-NOT-AUTHORIZED label retained
Backend TypeScript build: pass
Frontend production build: pass
Focused catalog approval Playwright: 9 pass, 0 fail
Package review validator: exit 0
Package stage validator: exit 2 (expected fail-closed)
git diff --check over B/C/D and governing reports: pass
```

The focused evidence covers catalog types/store, protocol/rendering, lifecycle service/runtime, installer, provider runtime, and the durable two-store CAS integration. Normal-host containment commands use the documented empty environment and explicit `synthetic-only` confirmations.

## Independent gate

- Independent combined integration review: `GO-SYNTHETIC-FREEZE`.
- Independent adversarial security review initially returned `REVISE` because the durable plan digest could outlive drift in the actually executable provider calls.
- After binding the exact D policy bytes and making C materialize and verify the approved executable plan, the final adversarial security review returned `GO-SYNTHETIC-FREEZE` with no blocking findings.

## Remaining blockers

1. Frozen-P private production adapters are not wired into the application/runtime service; all public production factories remain unavailable.
2. Exact upstream archive/commit/tree and applicable patches have not been acquired or verified.
3. Toolchain/vendor/license/SBOM/reproducible binary identities do not exist.
4. Independent query/source/patch review and current terms/unofficial-API review have not occurred.
5. D intentionally remains stage-ineligible with 53 explicit evidence gaps.
6. No stage, credential, activation, or first real read PIN has been requested.
7. A post-freeze threat model permits only a no-op inert application boundary until independently reviewed immutable D/P evidence and concrete private capability brands exist; that no-op abstraction was intentionally not added.

## Gate

**GO-SYNTHETIC-FREEZE** for A/B/C/D/P architecture contracts only.

**Staging: NOT AUTHORIZED. Production: NOT AUTHORIZED.** No source acquisition, login, credentials, activation, provider call, or Finance data is authorized by this report.
