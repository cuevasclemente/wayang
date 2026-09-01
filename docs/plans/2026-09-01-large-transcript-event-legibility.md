# Large transcript event legibility

**Date:** 2026-09-01

**Status:** implementation authorized

**Branch:** `fix/large-event-session-legibility-20260901`

**Worktree:** `/home/clemente/src/wayang-worktrees/large-event-session-legibility`

**Explicit base:** `c7ae0950d395c25035e3a82e57b023654df05c14`

## Problem

The negotiated transcript window has correct row and byte ceilings, but its oversized-row fallback replaces the entire canonical event with a generic custom message. A user event containing an embedded image can therefore lose its role, prompt text, timestamp, and attachment context. If that is the only event in a new session, the UI is bounded but unintelligible. The bounded `session_read` tool likewise fails when its first selected JSONL line exceeds its result budget.

## Goal and success criteria

Keep disk, memory, wire, and DOM work bounded while preserving the meaning of large events.

1. A large image-bearing user event renders as a user event with its readable text and an explicit media-omission note, never the generic whole-event placeholder.
2. Large assistant, tool-result, and custom events retain their role/type, useful bounded text, stable event ID, parent ID, timestamp, and relevant small metadata.
3. Embedded binary/base64 data and oversized nested fields never cross the transcript-window budget.
4. Cold reverse reads and indexed around/forward reads produce equivalent semantic projections.
5. Truly large physical rows use bounded prefix/suffix inspection and never require whole-row allocation merely to produce a projection.
6. `session_read` returns an explicit bounded projection for an oversized selected line rather than making the session unreadable.
7. Existing privacy, no-follow, fingerprint, revision, cursor, 200-row, 512-KiB wire, 384-KiB indexed-read, and 256-KiB `session_read` scan ceilings remain intact.

## Design

### Shared semantic projection

Add a transcript-pagination helper that projects a parsed serialized event into a small, role-preserving representation. It will:

- retain stable envelope fields and small scalar metadata;
- retain bounded head/tail text previews;
- replace image/base64 blocks with textual omission metadata;
- retain tool names/error state while bounding arguments/results/details;
- mark the result with machine-readable projection metadata including original encoded bytes;
- enforce its own small final byte ceiling and fall back to a typed role-preserving summary if necessary.

### Physical-row projection

For indexed rows too large for the aggregate source-read budget, read only fixed-size prefix and suffix samples from the already-authorized descriptor. Extract the trusted structural envelope from the index and bounded role/text/tool metadata from complete JSON string tokens in the samples. The structural index, not sampled content, remains authoritative for ID, parent, type, and source length.

The cold reverse reader already reads rows up to its 16-MiB scan ceiling. Its existing over-16-MiB envelope fallback will be upgraded to the same role-preserving sampled projection.

### Cross-session reader

When a selected JSONL line exceeds the 48-KiB return ceiling, emit one explicit `wayang_session_read_projection_v1` JSON line derived from bounded bytes, with canonical line number/byte size and semantic preview. Count all inspected bytes against the existing total scan ceiling. Continue only from the next physical line; never present the projection as canonical full content.

## Validation

- Focused backend tests for image-bearing user, assistant text, tool result, indexed oversized row, physical oversized row, and `session_read` projection.
- Assert no embedded image data appears in projected output.
- Assert exact message/window byte ceilings and stable IDs/cursors.
- Backend build and focused test run, then `make check` if focused gates pass.
- Synthetic fixtures only.

## Risks and mitigations

- **Sample ambiguity:** IDs and topology come only from the structural index or validated envelope, never inferred from arbitrary sampled payload text.
- **Misleading truncation:** every projection is explicitly marked and includes an omission notice and original encoded byte count.
- **Secret amplification:** projections reveal no more semantic text than the authorized transcript path already may reveal, and remove binary payloads; all existing authorization and final reauthorization remain.
- **Budget regression:** projection size has a compiled cap and tests assert aggregate protocol limits.

## Rollback

Revert the focused commit. Canonical Pi JSONL and the rebuildable structural index schema are unchanged.
