import test from "node:test";
import assert from "node:assert/strict";
import {
  DELETED_EVENT_TOMBSTONE,
  INVALIDATED_DERIVED_EVENT_TOMBSTONE,
  MAX_TRANSCRIPT_EVENT_BYTES,
  TranscriptMutationError,
  TranscriptMutationService,
  validateTranscriptMutationPinAttempt,
  type CanonicalEntry,
  type CanonicalEntryReplacement,
  type CanonicalTranscriptPort,
  type TranscriptMutationDependencies,
} from "./transcript-mutations.js";
import type { SettingsPinAttemptPort } from "./workspace-capability-approval/types.js";

function message(id: string, parentId: string | null, text: string, role = "user"): CanonicalEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-18T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }] },
  };
}

class FakeTranscript implements CanonicalTranscriptPort {
  readonly replacementSets: CanonicalEntryReplacement[][] = [];
  getEntryCalls = 0;
  getEntriesCalls = 0;
  failId: string | null = null;

  constructor(
    readonly entries: CanonicalEntry[],
    private readonly activeIds: string[],
    private readonly events: string[],
  ) {}

  getHeader() { return { type: "session", version: 3, id: "session-1", cwd: "/synthetic" }; }
  getEntry(id: string) {
    this.getEntryCalls++;
    const entry = this.entries.find((candidate) => candidate.id === id);
    return entry ? structuredClone(entry) : undefined;
  }
  getEntries() { this.getEntriesCalls++; return structuredClone(this.entries); }
  getBranch() { return this.activeIds.map((id) => structuredClone(this.entries.find((entry) => entry.id === id)!)); }
  replaceEntriesIfCurrent(replacements: readonly CanonicalEntryReplacement[]): void {
    this.events.push(`replace-set:${replacements.map(({ expectedEntry }) => expectedEntry.id).join(",")}`);
    if (this.failId && replacements.some(({ expectedEntry }) => expectedEntry.id === this.failId)) {
      throw new TranscriptMutationError("Transcript events changed before mutation", 409, "cas_conflict");
    }
    for (const { expectedEntry } of replacements) {
      const index = this.entries.findIndex((entry) => entry.id === expectedEntry.id);
      assert.ok(index >= 0);
      assert.deepEqual(this.entries[index], expectedEntry, "fake enforces exact expected-entry CAS");
    }
    this.replacementSets.push(structuredClone([...replacements]));
    for (const { expectedEntry, replacementEntry } of replacements) {
      const index = this.entries.findIndex((entry) => entry.id === expectedEntry.id);
      this.entries[index] = structuredClone(replacementEntry);
    }
  }
}

function fixture(entries: CanonicalEntry[], activeIds = entries.map((entry) => entry.id)) {
  const events: string[] = [];
  const transcript = new FakeTranscript(structuredClone(entries), activeIds, events);
  let runtime = {
    runtime_status: "stopped" as "active" | "starting" | "stopped",
    streaming: false,
    compacting: false,
    queued: false,
    humanGate: false,
  };
  let messagingBound = false;
  let durableHumanGate = false;
  let pinOk = true;
  let afterDispose: (() => void) | undefined;
  let afterPurge: (() => void) | undefined;
  const dependencies: TranscriptMutationDependencies = {
    getSession: (id) => id === "session-1" ? ({ id, pi_session_file: "/synthetic/session.jsonl", cwd: "/synthetic" } as any) : undefined,
    validatePin: async () => ({ ok: pinOk, pinConfigured: true, ...(pinOk ? {} : { error: "Incorrect command guard identity PIN." }) }),
    acquireRuntimeLock: () => { events.push("lock"); return true; },
    releaseRuntimeLock: () => { events.push("unlock"); },
    inspectRuntime: () => ({ ...runtime }),
    isMessagingBound: () => messagingBound,
    hasPendingSessionMutation: () => false,
    hasDurableHumanGate: () => durableHumanGate,
    async disposeIdleRuntime() {
      events.push("dispose");
      runtime = { ...runtime, runtime_status: "stopped" };
      afterDispose?.();
      return true;
    },
    openTranscript: () => transcript,
    async purgeSearch() { events.push("purge-search"); afterPurge?.(); },
    releaseSearchFence() { events.push("release-search-fence"); },
    invalidateSnapshots() { events.push("invalidate-snapshot"); },
    async reconcileMetadata() { events.push("reconcile-metadata"); },
    async forceReindex() { events.push("force-reindex"); },
  };
  return {
    service: new TranscriptMutationService(dependencies),
    transcript,
    events,
    setRuntime(value: Partial<typeof runtime>) { runtime = { ...runtime, ...value }; },
    setMessagingBound(value: boolean) { messagingBound = value; },
    setDurableHumanGate(value: boolean) { durableHumanGate = value; },
    setPinOk(value: boolean) { pinOk = value; },
    setAfterDispose(callback: () => void) { afterDispose = callback; },
    setAfterPurge(callback: () => void) { afterPurge = callback; },
  };
}

const OLD_SECRET = "removed synthetic private canary";

test("listing paginates every topology entry and marks active-branch membership", () => {
  const root = message("root", null, "root");
  const active = message("active", "root", "active");
  const alternate = message("alternate", "root", "alternate");
  const f = fixture([root, active, alternate], [root.id, active.id]);

  const first = f.service.listEvents("session-1", { offset: 0, limit: 2 });
  assert.equal(first.header_immutable, true);
  assert.equal(first.total_events, 3);
  assert.equal(first.next_offset, 2);
  assert.deepEqual(first.events.map((event) => [event.entry.id, event.active_branch]), [
    ["root", true],
    ["active", true],
  ]);
  assert.deepEqual(first.branches, [
    { tip_entry_id: "active", active: true },
    { tip_entry_id: "alternate", active: false },
  ]);
  assert.deepEqual(
    f.service.listEvents("session-1", { offset: 2, limit: 2 }).events.map((event) => event.entry.id),
    ["alternate"],
  );
});

test("collection can omit payload while exact lookup always returns the full canonical event", () => {
  const root = message("root", null, "private full payload");
  const child = message("child", "root", "child payload", "assistant");
  const f = fixture([root, child]);

  const projected = f.service.listEvents("session-1", { includePayload: false });
  assert.deepEqual(projected.events[0], {
    entry: {
      type: "message",
      id: "root",
      parentId: null,
    },
    active_branch: true,
    semantic_warnings: [],
  });
  assert.equal(JSON.stringify(projected.events).includes("private full payload"), false);

  const scansBeforeExact = f.transcript.getEntriesCalls;
  const exact = f.service.getEvent("session-1", "root");
  assert.equal(f.transcript.getEntryCalls, 1);
  assert.equal(f.transcript.getEntriesCalls, scansBeforeExact, "exact lookup must not scan collection pages");
  assert.deepEqual(exact.entry, root);
  assert.equal((exact.entry.message as any).content[0].text, "private full payload");
  assert.throws(
    () => f.service.getEvent("session-1", "missing"),
    (error: any) => error instanceof TranscriptMutationError
      && error.statusCode === 404 && error.code === "event_not_found",
  );
});

test("edit atomically invalidates all summaries including sibling branches, then reconciles and force reindexes", async () => {
  const target = message("target", null, OLD_SECRET);
  const compaction: CanonicalEntry = {
    type: "compaction", id: "compact", parentId: "target", summary: `summary of ${OLD_SECRET}`,
  };
  const summary: CanonicalEntry = {
    type: "branch_summary", id: "summary", parentId: "compact", summary: `branch ${OLD_SECRET}`,
  };
  const sibling = message("sibling", null, "inactive sibling branch");
  const siblingSummary: CanonicalEntry = {
    type: "branch_summary", id: "sibling-summary", parentId: "sibling", summary: `sibling branch ${OLD_SECRET}`,
  };
  const later = message("later", "summary", "unrelated retained future content", "assistant");
  const f = fixture(
    [target, compaction, summary, sibling, siblingSummary, later],
    ["target", "compact", "summary", "later"],
  );
  const replacement = message("target", null, "replacement public text");

  const result = await f.service.mutateEvent("session-1", "target", "edit", {
    pin: "opaque-test-pin",
    expectedEntry: target,
    replacementEntry: replacement,
  });

  assert.deepEqual(f.events, [
    "lock",
    "dispose",
    "purge-search",
    "replace-set:target,compact,summary,sibling-summary",
    "invalidate-snapshot",
    "reconcile-metadata",
    "release-search-fence",
    "force-reindex",
    "unlock",
  ]);
  assert.deepEqual(result.invalidated_entry_ids, ["compact", "summary", "sibling-summary"]);
  assert.equal(result.revision_retained, false);
  const editedTarget = f.transcript.entries.find((entry) => entry.id === "target")!;
  assert.equal(editedTarget.message && ((editedTarget.message as any).content[0].text), "replacement public text");
  assert.deepEqual(editedTarget.wayangMutation, result.replacement.wayangMutation);
  assert.equal((editedTarget.wayangMutation as any).version, 1);
  assert.equal((editedTarget.wayangMutation as any).kind, "edited");
  assert.equal(new Date((editedTarget.wayangMutation as any).at).toISOString(), (editedTarget.wayangMutation as any).at);
  assert.equal(Object.hasOwn(replacement, "wayangMutation"), false, "trusted marker is added to a clone, not caller input");
  for (const id of ["compact", "summary", "sibling-summary"]) {
    const invalidated = f.transcript.entries.find((entry) => entry.id === id)!;
    assert.equal(invalidated.type, "custom");
    assert.equal(invalidated.customType, INVALIDATED_DERIVED_EVENT_TOMBSTONE);
    assert.deepEqual(invalidated.data, { version: 1 });
  }
  assert.equal(JSON.stringify(f.transcript.entries).includes(OLD_SECRET), false, "no old target or derived summary text remains");
  assert.equal(JSON.stringify(result).includes(OLD_SECRET), false, "mutation response carries no retained revision");
});

test("delete creates a content-free same-topology tombstone without retaining old content", async () => {
  const target = message("target", "parent", OLD_SECRET);
  const f = fixture([message("parent", null, "parent"), target]);
  const result = await f.service.mutateEvent("session-1", "target", "delete", {
    pin: "opaque-test-pin",
    expectedEntry: target,
  });

  const tombstone = f.transcript.entries.find((entry) => entry.id === "target")!;
  assert.deepEqual(tombstone, {
    type: "custom",
    id: "target",
    parentId: "parent",
    timestamp: target.timestamp,
    customType: DELETED_EVENT_TOMBSTONE,
    data: { version: 1 },
  });
  assert.equal(JSON.stringify(tombstone).includes(OLD_SECRET), false);
  assert.equal(JSON.stringify(result).includes(OLD_SECRET), false);
  assert.equal(result.revision_retained, false);
});

test("exact expected-entry mismatch returns a CAS conflict before canonical rewrite", async () => {
  const current = message("target", null, "current concurrent text");
  const stale = message("target", null, "stale expected text");
  const f = fixture([current]);

  await assert.rejects(
    f.service.mutateEvent("session-1", "target", "delete", { pin: "opaque", expectedEntry: stale }),
    (error: any) => error instanceof TranscriptMutationError && error.statusCode === 409 && error.code === "cas_conflict",
  );
  assert.deepEqual(f.events, ["lock", "dispose", "unlock"]);
  assert.deepEqual(f.transcript.entries, [current]);
});

test("CAS conflict after stale-search purge reconciles and reindexes the canonical winner", async () => {
  const target = message("target", null, OLD_SECRET);
  const f = fixture([target]);
  f.transcript.failId = "target";

  await assert.rejects(
    f.service.mutateEvent("session-1", "target", "delete", { pin: "opaque", expectedEntry: target }),
    (error: any) => error instanceof TranscriptMutationError && error.code === "cas_conflict",
  );
  assert.deepEqual(f.events, [
    "lock",
    "dispose",
    "purge-search",
    "replace-set:target",
    "release-search-fence",
    "force-reindex",
    "unlock",
  ]);
});

test("multi-entry CAS conflict leaves target and every summary unchanged", async () => {
  const target = message("target", null, "current canonical text");
  const compaction: CanonicalEntry = { type: "compaction", id: "compact", parentId: "target", summary: "compact summary" };
  const summary: CanonicalEntry = { type: "branch_summary", id: "summary", parentId: "compact", summary: "branch summary" };
  const f = fixture([target, compaction, summary]);
  f.transcript.failId = "compact";

  await assert.rejects(
    f.service.mutateEvent("session-1", "target", "delete", { pin: "opaque", expectedEntry: target }),
    (error: any) => error instanceof TranscriptMutationError && error.code === "cas_conflict",
  );
  assert.deepEqual(f.events, [
    "lock",
    "dispose",
    "purge-search",
    "replace-set:target,compact,summary",
    "release-search-fence",
    "force-reindex",
    "unlock",
  ]);
  assert.deepEqual(f.transcript.entries, [target, compaction, summary]);
});

test("post-disposal authoritative recheck rejects a newly starting runtime before file/search access", async () => {
  const target = message("target", null, "current canonical text");
  const f = fixture([target]);
  f.setRuntime({ runtime_status: "active" });
  f.setAfterDispose(() => f.setRuntime({ runtime_status: "starting" }));

  await assert.rejects(
    f.service.mutateEvent("session-1", "target", "delete", { pin: "opaque", expectedEntry: target }),
    (error: any) => error instanceof TranscriptMutationError && error.code === "runtime_busy",
  );
  assert.deepEqual(f.events, ["lock", "dispose", "unlock"]);
  assert.deepEqual(f.transcript.entries, [target]);
});

test("post-disposal authoritative recheck rejects newly opened human and messaging gates", async (t) => {
  const target = message("target", null, "current canonical text");
  await t.test("human", async () => {
    const f = fixture([target]);
    f.setAfterDispose(() => f.setDurableHumanGate(true));
    await assert.rejects(
      f.service.mutateEvent("session-1", "target", "delete", { pin: "opaque", expectedEntry: target }),
      (error: any) => error instanceof TranscriptMutationError && error.code === "human_gate_open",
    );
    assert.deepEqual(f.events, ["lock", "dispose", "unlock"]);
  });
  await t.test("messaging", async () => {
    const f = fixture([target]);
    f.setAfterDispose(() => f.setMessagingBound(true));
    await assert.rejects(
      f.service.mutateEvent("session-1", "target", "delete", { pin: "opaque", expectedEntry: target }),
      (error: any) => error instanceof TranscriptMutationError && error.code === "messaging_bound",
    );
    assert.deepEqual(f.events, ["lock", "dispose", "unlock"]);
  });
});

test("post-purge gate recheck prevents a yielded messaging bind from racing the atomic CAS", async () => {
  const target = message("target", null, "current canonical text");
  const f = fixture([target]);
  f.setAfterPurge(() => f.setMessagingBound(true));

  await assert.rejects(
    f.service.mutateEvent("session-1", "target", "delete", { pin: "opaque", expectedEntry: target }),
    (error: any) => error instanceof TranscriptMutationError && error.code === "messaging_bound",
  );
  assert.deepEqual(f.events, [
    "lock",
    "dispose",
    "purge-search",
    "release-search-fence",
    "force-reindex",
    "unlock",
  ]);
  assert.deepEqual(f.transcript.entries, [target]);
});

test("one-shot transcript PIN uses the shared digest-bound persistent attempt contract", async () => {
  let reservation: Parameters<SettingsPinAttemptPort["reserve"]>[0] | undefined;
  const attempts: SettingsPinAttemptPort = {
    async reserve(input) {
      reservation = { ...input };
      return { status: "reserved" };
    },
    async verifyAndConsume(input) {
      assert.ok(reservation);
      assert.equal(input.realm, reservation.realm);
      assert.equal(input.requestId, reservation.requestId);
      assert.equal(input.reservationId, reservation.reservationId);
      assert.equal(input.pin, "87654321");
      return { status: "verified" };
    },
    async cancelAndConsume() {},
  };
  const operation = { sessionId: "session-1", eventId: "target", replacement: { text: "new" } };
  const result = await validateTranscriptMutationPinAttempt(attempts, "87654321", operation);
  assert.deepEqual(result, { ok: true, pinConfigured: true });
  assert.match(reservation?.operationDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(reservation).includes("new"), false, "durable attempt state receives only the operation digest");
});

test("shared transcript PIN cooldown fails closed without verification", async () => {
  let verified = false;
  const attempts: SettingsPinAttemptPort = {
    async reserve() { return { status: "cooldown", retryAt: 123_456 }; },
    async verifyAndConsume() { verified = true; return { status: "verified" }; },
    async cancelAndConsume() {},
  };
  const result = await validateTranscriptMutationPinAttempt(attempts, "87654321", { operation: "synthetic" });
  assert.deepEqual(result, {
    ok: false,
    pinConfigured: true,
    error: "Command guard identity PIN cooldown is active.",
    statusCode: 429,
    code: "pin_cooldown",
    retryAt: 123_456,
  });
  assert.equal(verified, false);
});

test("PIN, streaming, compaction, human, and messaging gates fail before purge or rewrite", async (t) => {
  const target = message("target", null, OLD_SECRET);
  const cases: Array<{ name: string; configure: (f: ReturnType<typeof fixture>) => void; expectedCode: string; expectedPrefix: string[] }> = [
    { name: "pin", configure: (f) => f.setPinOk(false), expectedCode: "pin_rejected", expectedPrefix: ["lock", "unlock"] },
    { name: "streaming", configure: (f) => f.setRuntime({ runtime_status: "active", streaming: true }), expectedCode: "runtime_busy", expectedPrefix: ["lock", "unlock"] },
    { name: "compacting", configure: (f) => f.setRuntime({ runtime_status: "active", compacting: true }), expectedCode: "runtime_busy", expectedPrefix: ["lock", "unlock"] },
    { name: "live human gate", configure: (f) => f.setRuntime({ runtime_status: "active", humanGate: true }), expectedCode: "human_gate_open", expectedPrefix: ["lock", "unlock"] },
    { name: "durable human gate", configure: (f) => f.setDurableHumanGate(true), expectedCode: "human_gate_open", expectedPrefix: ["lock", "unlock"] },
    { name: "messaging", configure: (f) => f.setMessagingBound(true), expectedCode: "messaging_bound", expectedPrefix: ["lock", "unlock"] },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const f = fixture([target]);
      item.configure(f);
      await assert.rejects(
        f.service.mutateEvent("session-1", "target", "delete", { pin: "never-echoed", expectedEntry: target }),
        (error: any) => error instanceof TranscriptMutationError && error.code === item.expectedCode,
      );
      assert.deepEqual(f.events, item.expectedPrefix);
      assert.equal(f.events.includes("purge-search"), false);
      assert.deepEqual(f.transcript.entries, [target]);
    });
  }
});

test("structured tool events are warned about and never silently bundled", async () => {
  const call: CanonicalEntry = {
    type: "message",
    id: "assistant-call",
    parentId: null,
    timestamp: "2026-08-18T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/synthetic" } }],
    },
  };
  const resultEvent: CanonicalEntry = {
    type: "message",
    id: "tool-result",
    parentId: "assistant-call",
    timestamp: "2026-08-18T00:00:01.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "synthetic result" }],
    },
  };
  const f = fixture([call, resultEvent]);
  const listed = f.service.listEvents("session-1");
  assert.match(listed.events[0]!.semantic_warnings.join(" "), /not bundled/i);
  assert.match(listed.events[1]!.semantic_warnings.join(" "), /independent events/i);

  const replacement = structuredClone(call);
  (replacement.message as any).content[0].arguments.path = "/replacement";
  const result = await f.service.mutateEvent("session-1", call.id, "edit", {
    pin: "opaque",
    expectedEntry: call,
    replacementEntry: replacement,
  });
  assert.deepEqual(f.transcript.entries.find((entry) => entry.id === resultEvent.id), resultEvent);
  assert.match(result.semantic_warnings.join(" "), /not bundled/i);
});

test("edit rejects topology/type/role changes and oversized or bundled replacement arrays", async () => {
  const target = message("target", null, "before");
  const f = fixture([target]);
  for (const replacement of [
    { ...target, id: "other" },
    { ...target, type: "custom" },
    { ...target, message: { role: "assistant", content: "changed" } },
    { ...target, wayangMutation: { kind: "forged" } },
    { ...target, message: { role: "user", content: "x".repeat(MAX_TRANSCRIPT_EVENT_BYTES + 1) } },
    [message("target", null, "one"), message("other", "target", "two")],
  ]) {
    await assert.rejects(
      f.service.mutateEvent("session-1", "target", "edit", { pin: "opaque", expectedEntry: target, replacementEntry: replacement }),
      (error: any) => error instanceof TranscriptMutationError && [400, 413].includes(error.statusCode),
    );
  }
  assert.deepEqual(f.events, []);
});
