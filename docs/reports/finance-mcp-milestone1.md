# Finance MCP onboarding Milestone 1 report

Date: 2026-07-26–27
Decision: **GO — control-plane-only Milestone 1 deployed and validated**

## Scope

Implemented only the Finance proposal/catalog/PIN-approval control plane. This milestone did not acquire or execute Monarch/PocketSmith/financial-provider code, accept financial-provider credentials, run staging, activate a financial provider, call any financial-data provider, read financial data, or mutate provider metadata.

## Implemented

- Dedicated private SQLite catalog under `WAYANG_DATA_DIR/finance-mcp-catalog` with strict private path/file checks, schema fingerprinting, SQLite integrity checks, coherent contiguous proposal/audit ledger validation, transactional revisions, and separate reserved lifecycle tables.
- Strict bounded non-executable proposal parser and immutable empty source-controlled reviewed-provider registry.
- Lazy catalog service: ordinary/ineligible sessions create no catalog state; exact list/preview/submit/status/withdraw projections only.
- Source-bound `mcp_catalog` for the exact interactive Finance profile, sole Protected Finance project, `openai-codex/gpt-5.6-sol`, legacy private Finance grant, live runtime generation, and fresh persisted browser user turn.
- Exact definition/wrapper identity across Pi tool-registry refresh; counterfeit definitions/wrappers denied.
- Backend-only canonical manifest and approval renderer with strict plain-data snapshots, NFC/safe-integer rules, invisible/control/bidi rejection, and complete authority lines/digests.
- High-risk PIN authority with exact connection-owner/session binding, newest-tab replacement, cancellation on switch/close, durable cooldown reservation, private no-follow files, timing-safe PIN comparison, one-use expiry/replay checks, an inter-process exclusive lock, and a synchronous-only backend recorder boundary.
- Separate catalog approval WebSocket protocol and transient accessible frontend dialog with exact request/session/socket/selection/transport acknowledgement binding. PIN is never stored in chat, browser storage, URLs, logs, argv, environment, or provider context.
- Production reviewed-provider registry and recorder both fail closed; provider effects remain unavailable.

## Validation

- Catalog/runtime/approval/WebSocket focused suite: 106/106 before the final acknowledgement correction.
- Final approval and route suite: 44/44; final WebSocket acknowledgement retest passed.
- Independent adversarial reviews iterated through canonicalization, ledger, projections, wrapper refresh, lifecycle provenance, renderer integration, Unicode, inter-process locking, synchronous commit, and acknowledgement binding. Final verdict: GO for Milestone 1 control-plane-only code.
- Exact Finance `AGENTS.md` disclosure was approved and committed through the workspace authority flow.
- Wren host-authority work remained opt-in and did not widen Finance: normal-host integration proved the real Protected/restricted sandbox path, including concurrent Wren/Finance isolation controls.
- `make doctor`: 0 failures, 0 warnings.
- `make check`: backend 403/403 with no failures or skips; script tests 23/23; backend/frontend builds passed; frontend lint had 0 errors and one unrelated pre-existing Fast Refresh warning.
- `make test-e2e`: 34/34, including catalog approval and authoritative host/sandbox/unavailable UI projection.
- Fresh source-bound Finance metadata smoke:
  - runtime displayed sandboxed bash;
  - `mcp_catalog {"operation":"list"}` succeeded exactly once;
  - proposal count was 0;
  - the schema exposed exactly `list`, `preview_proposal`, `submit_proposal`, `proposal_status`, `withdraw_proposal`, and `preview_stage`.
- No MCP provider/data tool, bash command, browser action, workspace mutation, credential path, staging action, activation, or financial record was used in the final smoke.

## Milestone closure

All Milestone 1 implementation, instruction, deployment, normal-host, and source-bound metadata gates are complete. The empty reviewed-provider registry remains the production trust root, so real provider staging/activation is still unavailable and requires a separately reviewed later milestone.

## Explicitly still unavailable

Monarch code or artifacts, credentials, staging jobs, immutable releases, activation grants, provider runtime/broker calls, financial-data access, category/tag/note writes, restoration receipts, and PocketSmith activation.
