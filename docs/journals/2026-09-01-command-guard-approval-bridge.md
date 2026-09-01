# Command guard approval bridge — 2026-09-01

## Scope

Clemente approved a full-stack Wayang path for human approval when mypi's command-guard verdict model fails. This complements mypi commit `1078847`; no identity-PIN behavior, protected-session boundary, or guard reactivation behavior was changed.

## Implementation

Commit `b318304` (`feat(guard): command-approval web bridge for guard model fallback`) adds:

- `PiCommandGuardApprovalBridge`, with boolean approve/deny results and null timeout/cancellation;
- exact-session, exact-selection WebSocket delivery with deduplication and pending replay;
- fail-closed response validation under the existing mutation lock;
- session teardown and capability-revocation cleanup;
- a ChatPanel approval prompt showing command and failure reason;
- explicit Approve/Deny controls, selection-change cleanup, and deny-on-stack behavior.

## Validation

Before integration:

- new approval-bridge tests: 7/7;
- backend + frontend production build: pass;
- full backend comparison: feature branch 1143 tests / 1101 pass / 36 fail versus base `fe2ecfc` 1136 / 1094 / 36. The same 36 host-environment startup failures existed at base; the patch added seven passing tests and no failures.

Deployment preflight on merged main:

- `make doctor`: 0 failures, 0 warnings;
- focused approval-bridge suite: 7/7;
- `make build`: pass (existing bundle-size warning only).

## Integration and service deployment

- `main` fast-forwarded from `fe2ecfc` to `b318304` and was pushed to GitHub over HTTPS.
- Production assets were rebuilt in `/home/clemente/src/wayang`.
- The live runtime is `/etc/systemd/system/wayang.service`, user `clemente`, working directory `/home/clemente/src/wayang/backend`, with `KillMode=control-group`.
- Because restarting the service terminates the live agent process, restart is scheduled only after all journal and source work is durable.

## Rollback

Revert the published Wayang commit and rebuild production assets, restore the matching prior mypi extension backup, then restart `wayang.service`. Do not rewrite published history.

## Remaining verification

After restart:

1. `wayang.service` is active and its HTTP health surface responds;
2. a new interactive session loads the hardened command guard;
3. a guard-model failure delivers a prompt only to the owning session/selection;
4. deny, timeout, disconnect, and duplicate prompt behavior remain fail-closed.
