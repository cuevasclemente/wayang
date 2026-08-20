# Standard viewer input coalescing

Date: 2026-08-20
Issue: #37

The Standard CDP viewer now uses a bounded input scheduler instead of retaining one promise-chain item per incoming event.

## Invariants

- A stalled dispatch retains at most one pending `mouse_move` and one pending aggregated `wheel` event in each segment between discrete barriers.
- New moves replace pending coordinates. Wheel deltas sum with finite, safe-integer saturation and use the newest coordinates.
- Mouse down/up, key down/up, paste, frame ACK, and viewer close remain ordered barriers; coalescing never crosses them.
- The existing 64-item limit counts in-flight discrete inputs, so continuous pointer traffic cannot exhaust it and more than 64 blocked discrete events still seal the viewer with `input_queue_full`.
- Sealing rejects both the active dispatch promise and all queued/coalesced callers immediately; late CDP completion cannot report accepted input after `viewer_close`.
- Wheel deltas accept only finite JSON numbers (with an omitted axis treated as zero) and aggregate with safe-integer saturation.

## Validation

- Focused Standard viewer tests: 15/15 passed, including stalled active-input close settlement.
- Full local release gate before the close-race follow-up: 926 tests with 919 passed, 0 failed, 7 skipped; 63/63 script tests passed; frontend lint had only the pre-existing Fast Refresh warning; backend/frontend builds passed.
- Backend TypeScript build after the close-race follow-up: passed.

GitHub CI remains required after rebasing onto current `main`.
