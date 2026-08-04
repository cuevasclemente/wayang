import test from "node:test";
import assert from "node:assert/strict";
import {
  browserTurnContentHash,
  issueBrowserTurnProvenance,
  resolveBrowserTurnPiUserEntry,
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
  assert.notEqual(turn.token, "exact browser content");
  assert.match(turn.token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(turn.contentSha256, browserTurnContentHash("exact browser content"));
  assert.match(turn.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(turn), true);
  assert.throws(
    () => issueBrowserTurnProvenance({ ...binding, acceptedEntryCount: -1 }, "content"),
    /invalid Pi transcript entry boundary/,
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
