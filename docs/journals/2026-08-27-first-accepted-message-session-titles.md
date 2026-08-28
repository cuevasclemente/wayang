# First accepted-message session titles — 2026-08-27

## Decision

After observing a newly created session remain untitled during a long first response, Clemente selected automatic title generation immediately after the first browser message is accepted rather than after one or three completed interactions.

## Implementation

- Starts the existing fixed Terra title provider on a deferred task once the exact first browser user entry is physically persisted in Pi; assistant settlement is not required.
- Uses only bounded raw first-message text captured before Wayang decoration for the immediate request.
- Requires exact process-local accepted-turn evidence or an exact marker from a freshly reopened physical transcript before disclosure and commit.
- Rejects unpersisted, rejected, cancelled-before-start, attachment-only, later-user, non-browser, scheduled, connector, resend, and interview-continuation provenance.
- Reauthorizes Project/Profile/privacy policy before disclosure and commit; manual names and deliberate clears still win through the physical Pi CAS.
- Coalesces accepted and settled triggers per interaction. A later distinct browser interaction may retry a failed attempt using the physical first one to three completed exchanges, but cannot substitute later text for an unmarked first user.
- Removes witness-free `agent_settled` title catch-up.
- Updates `.env.example` and `docs/configuration.md` so enabling the title flags explicitly consents to immediate first-message disclosure.

## Validation

- Focused policy and title-service tests: 25 passed.
- Focused Pi bridge timing/rejection/repair tests: 4 passed.
- Backend TypeScript build passed.
- Independent privacy/concurrency and documentation release gates: GO after resolving three rounds of provenance, cancellation, physical-marker, and consent-documentation findings.

## Deployment note

Integration, full backend validation, production build, restart, and live verification remain required before the behavior is active.
