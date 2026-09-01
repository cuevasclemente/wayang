# Browser workbench visual declutter

Date: 2026-09-01
Status: implemented, validated, and integrated on local `main`; frontend assets are live without a service restart

## Problem

The Browser pane accumulated one full-width row for nearly every browser capability and state: profile selection, agent-tool diagnostics, transport controls, profile-wide disclosure, tabs, download publication, control mode, privacy details, handoff status, paste notices, and viewer connection state. Much of this was normal-state or explanatory copy rather than an immediate decision. In Profile-wide Full browser mode, the repeated bands could leave too little height for the actual browser to be usable.

## Product hierarchy

The browser viewport is now the dominant surface. The UI follows three levels:

1. Immediate actions and current mode stay in a compact two-row command bar: start or pause/resume, credentials, viewer selection, concise control state, and URL navigation.
2. Contextual warnings remain visible only when they change what the owner should do: agent paused/credential protection, unavailable agent tools, or profile-wide Full browser exposure.
3. Routine diagnostics, exact transport metadata, download publication details, full safety text, status fields, restart, reset, stop, and direct paste are available through `Privacy and browser details`, the compact unavailable-tools disclosure, or `More`.

This preserves the existing security/control semantics. It changes presentation only; no backend route, browser authority, credential gate, download rule, or viewer transport behavior changed.

## Implementation

- `frontend/src/components/browser/BrowserToolbar.tsx`
  - Replaced the wrapping three-band toolbar with a compact command row plus URL row.
  - Kept primary human/agent handoff and credential controls visible.
  - Moved stop/restart/reset/direct-paste actions under `More`.
  - Kept viewer choices in a single horizontally bounded row rather than allowing narrow panels to grow into a tall button wall.
  - Removed the redundant viewer-selection notice; the selected radio state already communicates the result.
- `frontend/src/panels/BrowserPanel.tsx`
  - Condensed named-profile selection to one line with a shared-login-state badge.
  - Collapsed successful agent-tool diagnostics and download publication copy into browser details.
  - Collapsed unavailable-tool remediation behind its one-line actionable warning.
  - Removed the normal shared-control banner and the second duplicate Resume-agent handoff band.
  - Retained one concise state notice only for paused or credential-restricted modes.
  - Condensed the profile-wide VNC warning while preserving its full disclosure in details.
  - Added stable workbench/viewport test targets.
- `e2e/tests/browser-workbench.spec.ts` and `e2e/tests/protected-browser.spec.ts`
  - Updated action discovery expectations for `More` and collapsed diagnostics.
  - Added explicit density assertions: the viewport occupies more than 70% of a narrow ordinary workbench and more than 65% of a named Profile-wide Full browser workbench with a tab strip.
  - Asserted that routine details/download copy start collapsed and paused mode exposes exactly one Resume-agent control.

## Validation

Passed:

- browser/protected focused Playwright suite: 12/12;
- narrow ordinary workbench density: viewport ratio > 0.70 at 800×700;
- named Profile-wide Full browser density: viewport ratio > 0.65 at 1600×900;
- full `make check` under documented test-default feature selectors:
  - backend 1,135 passed / 0 failed / 8 skipped;
  - frontend 7 passed / 0 failed;
  - scripts 63 passed / 0 failed;
  - frontend lint 0 errors and one pre-existing Fast Refresh warning;
  - backend and frontend production builds passed;
- `git diff --check` passed.

The first unqualified `make check` inherited production feature flags and reproduced the known host-environment baseline (36 backend failures, including named-profile startup composition and memory-first tool-set differences). Re-running with browser-host, canonical warmer, file-audio, and memory-first gates at documented test defaults and search/catalog background services enabled passed completely. No private configuration values were read or printed.

No browser profile contents, cookies, credentials, production session data, service configuration, or live browser pages were inspected or changed.

## Integration

After the concurrent large-transcript-event fix reached canonical `main`, this commit was rebased onto that head, the focused 12-test browser/protected suite passed again, and `main` fast-forwarded to `28c62a1`. The production frontend was rebuilt in place and the running loopback service served the new `index-B3CxBoOd.js` asset immediately; no process restart was needed because backend code did not change. Repository publication remains pending because the command guard denied the unapproved push to `origin/main`.
