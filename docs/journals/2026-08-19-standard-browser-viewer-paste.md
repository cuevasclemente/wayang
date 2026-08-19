# Standard Browser Viewer Paste Regression

Date: 2026-08-19
Branch: `fix/standard-viewer-paste`
Base: `57d362d`

## Problem

The named Standard Browser Profile migration disabled the legacy Browser-panel `Paste…` action because it posts clipboard text to the generic `/api/browser/paste-text` route. Named profiles deliberately reject that HTTP path and require human input to use the exact authenticated viewer transport. The Standard CDP viewer supported pointer and keyboard messages, but no paste message, leaving human-controlled login fields without a practical paste path. `Legacy shared` is represented as a named profile, so Tribe-Mac exposed this gap.

## Implementation

- Added an exact Standard viewer `{ "type": "paste", "text": string }` message.
- Validate nonempty text with limits of 4,096 UTF-16 code units and 16,384 UTF-8 bytes; reject NULs, unpaired surrogates, unknown fields, binary messages, and malformed JSON through the existing fail-closed input path.
- Dispatch accepted text through `Input.insertText` only after exact viewer authorization, reauthorize after CDP dispatch, and schedule the existing top-level document attestation lane.
- Record only the `paste` input category in operational observations; never include pasted text.
- Reuse the uncontrolled direct-paste capture in the named-profile Fast-page viewer. Clipboard text goes directly over the authenticated WebSocket and is not retained in React state, browser storage, an HTTP request, or an agent parameter.
- Added an accessible label to the shared capture textarea and made its limit/connection messages transport-neutral.
- Kept the named-profile legacy HTTP paste route disabled. Full-browser/VNC behavior is unchanged.

## Validation

Passing:

- `backend/src/browser/standard-viewer.test.ts`: 10/10
- `e2e/tests/browser-workbench.spec.ts`: 7/7
- Focused protected-automation preparation viewer E2E: 1/1
- Backend TypeScript build
- Frontend production build
- Frontend lint: 0 errors, one pre-existing Fast Refresh warning in `SessionResultSnippet.tsx`
- Independent security-focused diff review: no blockers; one wording issue corrected
- `git diff --check`

The repository-wide `make check` did not complete within the 15-minute sandbox allowance. Before timeout, the changed Standard viewer tests passed; unrelated host-dependent failures occurred in real ffmpeg sandboxing, production Chromium composition, Bubblewrap feasibility, and the protected-automation Linux feasibility gate. Running `make test-scripts` separately reproduced the known fake-Bitwarden baseline of 62/63 (`browser-credentials-unlock.test.mjs`), unrelated to this change.

## Deployment

The fix is not active until the reviewed commit is integrated, Tribe-Mac is updated to that exact commit, backend/frontend assets are rebuilt, and the Tribe-Mac Wayang process is restarted. After deployment, pause the agent, select **Fast page**, click **Paste text**, and paste into the capture target. The value should enter the currently focused browser field.
