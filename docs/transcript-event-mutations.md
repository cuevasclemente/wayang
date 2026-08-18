# Transcript event editing and deletion

Wayang can edit or delete persisted events in a Pi session transcript. This is an owner-level, PIN-gated operation over the canonical Pi JSONL—not a display-only overlay.

## Using it

- Each persisted chat row has **Manage event** or **Manage N events** controls.
- The chat toolbar's **Events** inspector exposes hidden event types and off-branch history.
- Ordinary text messages use a text editor. **Advanced JSON** edits the bounded event payload for structured records.
- Every edit and deletion requires the existing 8-digit command-guard identity PIN. Attempts share Wayang's persistent cooldown authority; a recent attempt may require waiting before another mutation.
- Mutation is unavailable while the session is starting, streaming, compacting, resending, queued, awaiting human input, messaging-bound, or otherwise being mutated.

The immutable event envelope is controlled by Wayang. The session header, event ID, parent ID, and event type cannot be changed through an edit. Deletion replaces the event with a content-free tombstone at the same tree position.

## Canonical behavior

After a successful mutation:

- future agent context is rebuilt from the rewritten Pi transcript;
- every connected Wayang client receives an invalidation and reloads authoritative history;
- local keyword search is purged before rewrite and rebuilt only after session metadata reconciliation;
- edited/deleted markers are rendered without retaining the previous payload;
- all compaction and branch-summary events are conservatively invalidated when their exact source dependency cannot be proven;
- an already-open cooperative Pi runtime is fenced by the session mutation epoch and must reopen before appending.

Structured events are intentionally editable. Changing a tool call, tool result, model change, extension event, label, or summary can produce unusual history. Wayang validates the minimum Pi schema and warns about semantic or external consequences, but does not silently mutate related tool events.

## Retention and limits

Wayang does **not** create an undo copy or revision history of replaced payloads. Its crash-recovery journal contains only operation kind, session ID, canonical transcript path, marker ID, and timestamp.

This is not secure media erasure. It does not remove:

- copies or paraphrases stored in other transcript events;
- provider-side retention;
- filesystem snapshots, backups, swap, or forensic remnants;
- existing TTS broker jobs or unattributed ephemeral audio cache files;
- commands, file changes, browser actions, approvals, messages, trades, or other external side effects that already happened.

Deletion means that the selected event's stored payload is removed from canonical future context and normal search after successful reconciliation. Independent copies remain independent data and must be reviewed separately.

## Failure and recovery

Pi performs target and derived-summary replacement in one lock-protected, revision-checked atomic rewrite. A content-free durable recovery marker is written before event mutation. It is cleared only after metadata and search reconciliation succeed.

Whole-session deletion atomically removes the Wayang row and records durable cleanup authority before unlinking the transcript. Startup processes outstanding recovery markers before session catalog or search watchers can import/index data.

If reconciliation cannot complete, Wayang returns an attention error, invalidates connected clients, and keeps search denied rather than reporting false success or republishing stale metadata.
