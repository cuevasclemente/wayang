# Session title repair on browser interaction — 2026-08-27

## Goal

Repair older or existing Wayang/Pi sessions that remain unnamed, including automatic title attempts that failed before the Wayang mirror persisted, when the human resumes the conversation. Human- or agent-authored Pi names and deliberate clears remain authoritative.

## Implementation

- Added an interaction-scoped retry path around the existing standard three-exchange title generator.
- Triggered repair only after an ordinary browser turn settles; passive session selection remains title-inert.
- Deferred transcript parsing and provider work past turn acknowledgement with `setImmediate` so title repair cannot delay the source interaction.
- Retained the existing Project/Profile/privacy checks, bounded first-three-exchange disclosure, provider preparation, physical revalidation, and Pi name CAS.
- Coalesced in-flight requests by the stable bounded projection digest so a newly completed exchange cannot issue a duplicate provider request.
- Repaired a canonical physical Pi title into Wayang without another provider request after a prior mirror failure.
- Treated every physical `session_info` revision as authoritative: nonblank authored names are mirrored only through existing replaceability rules, and a deliberate clear removes a stale provisional display while suppressing automation.

## Validation

- Focused title-service tests: 10 passed.
- Focused Pi interaction-path tests: 2 passed.
- Full backend tests: 1040 passed, 0 failed, 6 skipped.
- Backend TypeScript build passed.
- `git diff --check` passed.
- Independent terminal review: GO after resolving latency, duplicate-provider, and deliberate-clear findings.

## Deployment note

The code requires integration into `main`, a production build, and a Wayang service restart before it affects live sessions.
