import test from "node:test";
import assert from "node:assert/strict";
import {
  browserTurnContentHash,
  interactiveTurnSourceDetails,
  issueBrowserTurnProvenance,
  MAX_INTERACTIVE_TURN_RAW_TEXT_CODE_POINTS,
  resolveBrowserTurnLedger,
  resolveBrowserTurnPiUserEntry,
  truncateUnicodeCodePoints,
} from "./interactive-turn-provenance.js";

const binding = {
  sourceSessionId: "session",
  runtimeGeneration: "generation",
  agentProfileId: "profile",
  projectId: "project",
  projectCwd: "/synthetic/project",
  provider: "provider",
  model: "model",
  acceptedEntryCount: 1,
};

test("interactive turn provenance binds exact content and an immutable transcript boundary", () => {
  const turn = issueBrowserTurnProvenance(binding, "exact browser content", 1_000);

  assert.equal(turn.piUserEntryId, null);
  assert.equal(turn.acceptedAt, 1_000);
  assert.equal(turn.clientMessageId, turn.token);
  assert.equal(turn.rawUserText, "exact browser content");
  assert.equal(turn.provisionalTitleText, "exact browser content");
  assert.equal(turn.provisionalTitleAccepted, false);
  assert.equal(turn.settlementReady, false);
  assert.notEqual(turn.token, "exact browser content");
  assert.match(turn.token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(turn.contentSha256, browserTurnContentHash("exact browser content"));
  assert.match(turn.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(turn), true);
  assert.throws(
    () => issueBrowserTurnProvenance({ ...binding, acceptedEntryCount: -1 }, "content"),
    /invalid Pi transcript entry boundary/,
  );
  assert.throws(
    () => issueBrowserTurnProvenance(binding, "content", 1_000, { clientMessageId: "bad id" }),
    /invalid browser client message ID/,
  );
});

test("interactive turn provenance resolves exactly one new matching current-branch Pi user entry", () => {
  const turn = issueBrowserTurnProvenance(binding, "exact browser content", 1_000);
  const entries = [
    { id: "old", type: "message", message: { role: "user", content: "exact browser content" } },
    { id: "assistant", type: "message", message: { role: "assistant", content: "exact browser content" } },
    { id: "pi-user-entry", type: "message", message: { role: "user", content: [{ type: "text", text: "exact browser content" }] } },
  ];

  const resolved = resolveBrowserTurnPiUserEntry(turn, entries, new Set(["old", "assistant", "pi-user-entry"]));
  assert.equal(resolved?.piUserEntryId, "pi-user-entry");
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(resolveBrowserTurnPiUserEntry(resolved!, entries, new Set(["old"])), null, "off-branch entries are stale");
  assert.equal(
    resolveBrowserTurnPiUserEntry(turn, [...entries, { ...entries[2], id: "duplicate" }]),
    null,
    "ambiguous new matches fail closed",
  );
  assert.equal(
    resolveBrowserTurnPiUserEntry(resolved!, [{ ...entries[2], message: { role: "user", content: "tampered" } }]),
    null,
    "resolved content remains bound to its hash",
  );
});

test("interactive source marker persists only bounded nonblank raw browser text", () => {
  const raw = `${"😀".repeat(MAX_INTERACTIVE_TURN_RAW_TEXT_CODE_POINTS)}ignored`;
  const turn = issueBrowserTurnProvenance(binding, "decorated Pi content", 1_000, {
    rawUserText: raw,
    clientMessageId: "browser-message-1",
  });
  assert.equal(Array.from(turn.rawUserText).length, MAX_INTERACTIVE_TURN_RAW_TEXT_CODE_POINTS);
  assert.equal(turn.rawUserText.endsWith("ignored"), false);
  const resolved = { ...turn, piUserEntryId: "pi-user-entry" };
  assert.deepEqual(interactiveTurnSourceDetails(resolved), {
    user_entry_id: "pi-user-entry",
    raw_user_text: "😀".repeat(MAX_INTERACTIVE_TURN_RAW_TEXT_CODE_POINTS),
    accepted_at: 1_000,
    client_message_id: "browser-message-1",
  });
  assert.equal(interactiveTurnSourceDetails({ ...resolved, rawUserText: " \n\t " }), null);
  assert.equal(interactiveTurnSourceDetails({ ...resolved, sourceMarkerEligible: false }), null);
  assert.equal(interactiveTurnSourceDetails(turn), null);
  assert.equal(truncateUnicodeCodePoints("a😀b", 2), "a😀");
});

test("per-turn ledger binds queued repeated text to distinct Pi user entries in acceptance order", () => {
  const first = issueBrowserTurnProvenance(binding, "repeated queued content", 1_000, { clientMessageId: "queued-1" });
  const second = issueBrowserTurnProvenance(binding, "repeated queued content", 1_001, { clientMessageId: "queued-2" });
  const entries = [
    { id: "old", type: "message", message: { role: "user", content: "older" } },
    { id: "pi-user-1", type: "message", message: { role: "user", content: "repeated queued content" } },
    { id: "assistant-1", type: "message", message: { role: "assistant", content: "one" } },
    { id: "pi-user-2", type: "message", message: { role: "user", content: "repeated queued content" } },
  ];
  const ledger = new Map([[first.token, first], [second.token, second]]);
  const resolved = resolveBrowserTurnLedger(ledger, entries, new Set(entries.map((entry) => entry.id)));
  assert.equal(resolved.get(first.token)?.piUserEntryId, "pi-user-1");
  assert.equal(resolved.get(second.token)?.piUserEntryId, "pi-user-2");
});
