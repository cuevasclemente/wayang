import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { close, failNextCommitStoreMutationPersistenceForTests, flush, getStore, init } from "./db.js";
import { createSession, getSessionById, setProvisionalSessionTitle, updatePiSessionFile } from "./sessions.js";
import {
  issueBrowserTurnProvenance,
  WAYANG_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE,
  type BrowserTurnProvenance,
} from "./interactive-turn-provenance.js";
import {
  scheduleWayangAutoTitle,
  scheduleWayangAutoTitleFromActivation,
  scheduleWayangAutoTitleOnAcceptedTurn,
  scheduleWayangAutoTitleOnInteraction,
  setAutoTitleProviderForTests,
  type TitleProvider,
} from "./session-title-service.js";
import { getSessionFileSnapshot, invalidateSessionFileSnapshot } from "./pi-bridge.js";

interface Fixture {
  root: string;
  cwd: string;
  rowId: string;
  manager: SessionManager;
  cleanup(): void;
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-auto-title-"));
  const cwd = path.join(root, "project");
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(cwd, { recursive: true });
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  const previousEnabled = process.env.WAYANG_AUTO_SESSION_TITLE;
  const previousProtected = process.env.WAYANG_AUTO_SESSION_TITLE_PROTECTED;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  process.env.WAYANG_AUTO_SESSION_TITLE = "on";
  delete process.env.WAYANG_AUTO_SESSION_TITLE_PROTECTED;
  init();
  const row = createSession(cwd);
  const manager = SessionManager.create(cwd, sessionDir, { id: row.id });
  return {
    root,
    cwd,
    rowId: row.id,
    manager,
    cleanup() {
      setAutoTitleProviderForTests(null);
      close();
      if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
      else process.env.WAYANG_DATA_DIR = previousDataDir;
      if (previousEnabled === undefined) delete process.env.WAYANG_AUTO_SESSION_TITLE;
      else process.env.WAYANG_AUTO_SESSION_TITLE = previousEnabled;
      if (previousProtected === undefined) delete process.env.WAYANG_AUTO_SESSION_TITLE_PROTECTED;
      else process.env.WAYANG_AUTO_SESSION_TITLE_PROTECTED = previousProtected;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function appendExchange(manager: SessionManager, index: number): void {
  const userEntryId = manager.appendMessage({ role: "user", content: `decorated ${index}`, timestamp: Date.now() } as any);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `assistant ${index}` }],
    provider: "synthetic",
    model: "synthetic",
    stopReason: "stop",
    timestamp: Date.now(),
  } as any);
  manager.appendCustomEntry(WAYANG_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE, {
    user_entry_id: userEntryId,
    raw_user_text: `raw ${index}`,
    accepted_at: index,
    client_message_id: `message-${index}`,
  });
}

function persistFile(f: Fixture): void {
  f.manager.materialize();
  const sessionFile = f.manager.getSessionFile();
  assert.ok(sessionFile);
  updatePiSessionFile(f.rowId, sessionFile);
}

function acceptedTurn(
  f: Fixture,
  rawUserText = "raw first accepted message",
  clientMessageId = "accepted-title-message",
  decoratedContent = "decorated accepted message",
): BrowserTurnProvenance {
  const row = getSessionById(f.rowId)!;
  const issued = issueBrowserTurnProvenance({
    sourceSessionId: row.id,
    runtimeGeneration: "accepted-title-runtime",
    agentProfileId: row.agent_profile_id!,
    projectId: row.project_id!,
    projectCwd: row.cwd,
    provider: "synthetic-provider",
    model: "synthetic-model",
    acceptedEntryCount: f.manager.getEntries().length,
  }, decoratedContent, Date.now(), {
    rawUserText,
    clientMessageId,
    sourceMarkerEligible: true,
  });
  const piUserEntryId = f.manager.appendMessage({
    role: "user",
    content: decoratedContent,
    timestamp: Date.now(),
  } as any);
  return Object.freeze({ ...issued, piUserEntryId });
}

class FakeProvider implements TitleProvider {
  prepareCalls = 0;
  dispatchCalls = 0;
  inputs: string[] = [];
  constructor(private readonly response: () => string | Promise<string>) {}
  async prepare() {
    this.prepareCalls++;
    return {
      dispatch: async (input: string) => {
        this.dispatchCalls++;
        this.inputs.push(input);
        return this.response();
      },
    };
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Wayang titles after the first completed marked exchange", async () => {
  const f = fixture();
  try {
    const fake = new FakeProvider(() => "First exchange summary");
    setAutoTitleProviderForTests(fake);
    appendExchange(f.manager, 1);
    persistFile(f);
    const work = scheduleWayangAutoTitle(f.rowId);
    assert.ok(work);
    await work;
    assert.equal(fake.dispatchCalls, 1);
    assert.match(fake.inputs[0]!, /raw 1/);
    assert.doesNotMatch(fake.inputs[0]!, /decorated/);
    const physical = SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd);
    assert.equal(physical.getSessionName(), "First exchange summary");
    assert.equal(physical.getSessionNameState().entryId !== undefined, true);
    assert.deepEqual([getSessionById(f.rowId)?.title, getSessionById(f.rowId)?.title_source], ["First exchange summary", "pi"]);
  } finally {
    f.cleanup();
  }
});

test("Wayang titles from the first accepted browser message before settlement", async () => {
  const f = fixture();
  try {
    const fake = new FakeProvider(() => "Immediate accepted title");
    setAutoTitleProviderForTests(fake);
    persistFile(f);
    const turn = acceptedTurn(f);

    const work = scheduleWayangAutoTitleOnAcceptedTurn(f.rowId, turn, { stillAccepted: () => true });
    assert.ok(work);
    await work;

    assert.equal(fake.dispatchCalls, 1);
    assert.match(fake.inputs[0]!, /raw first accepted message/);
    assert.doesNotMatch(fake.inputs[0]!, /decorated accepted message/);
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(), "Immediate accepted title");
    assert.deepEqual(
      [getSessionById(f.rowId)?.title, getSessionById(f.rowId)?.title_source],
      ["Immediate accepted title", "pi"],
    );
  } finally {
    f.cleanup();
  }
});

test("accepted-message naming preserves a concurrent human title", async () => {
  const f = fixture();
  try {
    const response = deferred<string>();
    const dispatched = deferred<void>();
    setAutoTitleProviderForTests({
      async prepare() {
        return {
          dispatch() {
            dispatched.resolve();
            return response.promise;
          },
        };
      },
    });
    persistFile(f);
    const work = scheduleWayangAutoTitleOnAcceptedTurn(f.rowId, acceptedTurn(f), { stillAccepted: () => true })!;
    await dispatched.promise;
    SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).appendSessionInfo("Human title", { origin: "human" });
    response.resolve("Automatic title");
    await work;

    assert.equal(SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(), "Human title");
    assert.notEqual(getSessionById(f.rowId)?.title, "Automatic title");
  } finally {
    f.cleanup();
  }
});

test("accepted-message naming rejects ineligible provenance before provider disclosure", () => {
  const f = fixture();
  try {
    const fake = new FakeProvider(() => "Must not generate");
    setAutoTitleProviderForTests(fake);
    persistFile(f);
    const ineligible = Object.freeze({ ...acceptedTurn(f), sourceMarkerEligible: false });
    assert.equal(scheduleWayangAutoTitleOnAcceptedTurn(f.rowId, ineligible, { stillAccepted: () => true }), null);
    assert.equal(fake.prepareCalls, 0);
  } finally {
    f.cleanup();
  }
});

test("accepted-message naming stops before disclosure when admission is cancelled", async () => {
  const f = fixture();
  try {
    const prepared = deferred<{ dispatch(input: string): Promise<string> }>();
    let dispatchCalls = 0;
    let accepted = true;
    setAutoTitleProviderForTests({ prepare: () => prepared.promise });
    persistFile(f);
    const work = scheduleWayangAutoTitleOnAcceptedTurn(f.rowId, acceptedTurn(f), {
      stillAccepted: () => accepted,
    })!;
    accepted = false;
    prepared.resolve({ dispatch: async () => { dispatchCalls++; return "Must not title"; } });
    await work;

    assert.equal(dispatchCalls, 0);
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(), undefined);
  } finally {
    f.cleanup();
  }
});

test("accepted-message naming stops commit when admission is cancelled after disclosure", async () => {
  const f = fixture();
  try {
    const response = deferred<string>();
    const dispatched = deferred<void>();
    let accepted = true;
    setAutoTitleProviderForTests({
      async prepare() {
        return {
          dispatch() {
            dispatched.resolve();
            return response.promise;
          },
        };
      },
    });
    persistFile(f);
    const work = scheduleWayangAutoTitleOnAcceptedTurn(f.rowId, acceptedTurn(f), {
      stillAccepted: () => accepted,
    })!;
    await dispatched.promise;
    accepted = false;
    response.resolve("Must not commit");
    await work;

    assert.equal(SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(), undefined);
  } finally {
    f.cleanup();
  }
});

test("accepted-message naming reauthorizes privacy immediately before disclosure", async () => {
  const f = fixture();
  try {
    const prepared = deferred<{ dispatch(input: string): Promise<string> }>();
    let dispatchCalls = 0;
    setAutoTitleProviderForTests({ prepare: () => prepared.promise });
    persistFile(f);
    const work = scheduleWayangAutoTitleOnAcceptedTurn(f.rowId, acceptedTurn(f), {
      stillAccepted: () => true,
    })!;
    const project = getStore().projects.find((candidate) => candidate.cwd === f.cwd)!;
    project.access_policy.privacy_mode = "protected";
    project.access_policy.allowed_agent_profile_ids = [project.default_agent_profile_id];
    flush();
    prepared.resolve({ dispatch: async () => { dispatchCalls++; return "Must not disclose"; } });
    await work;

    assert.equal(dispatchCalls, 0);
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(), undefined);
  } finally {
    f.cleanup();
  }
});

test("accepted failure retries once on a later interaction using the first message only", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const fake = new FakeProvider(() => {
      calls++;
      if (calls === 1) throw new Error("synthetic first-attempt failure");
      return "First-message retry title";
    });
    setAutoTitleProviderForTests(fake);
    persistFile(f);
    const first = acceptedTurn(f, "raw first message", "accepted-first", "decorated first message");
    await scheduleWayangAutoTitleOnAcceptedTurn(f.rowId, first, { stillAccepted: () => true });
    assert.equal(fake.dispatchCalls, 1);

    f.manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      provider: "synthetic",
      model: "synthetic",
      stopReason: "stop",
      timestamp: Date.now(),
    } as any);
    f.manager.appendCustomEntry(WAYANG_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE, {
      user_entry_id: first.piUserEntryId,
      raw_user_text: first.rawUserText,
      accepted_at: first.acceptedAt,
      client_message_id: first.clientMessageId,
    });
    assert.equal(
      scheduleWayangAutoTitleOnInteraction(f.rowId, first.clientMessageId),
      null,
      "settlement cannot duplicate the accepted attempt for the same interaction",
    );

    const second = acceptedTurn(f, "raw second message", "accepted-second", "decorated second message");
    assert.equal(
      scheduleWayangAutoTitleOnAcceptedTurn(f.rowId, second, { stillAccepted: () => true }),
      null,
      "a later accepted message cannot replace first-message provenance",
    );
    await scheduleWayangAutoTitleOnInteraction(f.rowId, second.clientMessageId);

    assert.equal(fake.dispatchCalls, 2);
    assert.match(fake.inputs[1]!, /raw first message/);
    assert.doesNotMatch(fake.inputs[1]!, /raw second message/);
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(), "First-message retry title");
  } finally {
    f.cleanup();
  }
});

test("historical retry requires the triggering interaction's authoritative marker", async () => {
  const f = fixture();
  try {
    const fake = new FakeProvider(() => "Historical retry title");
    setAutoTitleProviderForTests(fake);
    appendExchange(f.manager, 1);
    persistFile(f);
    const trigger = acceptedTurn(f, "raw trigger", "historical-trigger", "decorated trigger");

    assert.equal(scheduleWayangAutoTitleOnInteraction(f.rowId, trigger.clientMessageId, {
      acceptedTurn: trigger,
      stillAccepted: () => false,
    }), null);
    assert.equal(fake.dispatchCalls, 0);

    f.manager.appendCustomEntry(WAYANG_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE, {
      user_entry_id: trigger.piUserEntryId,
      raw_user_text: trigger.rawUserText,
      accepted_at: trigger.acceptedAt,
      client_message_id: trigger.clientMessageId,
    });
    await scheduleWayangAutoTitleOnInteraction(f.rowId, trigger.clientMessageId, {
      acceptedTurn: trigger,
      stillAccepted: () => false,
    });
    assert.equal(fake.dispatchCalls, 1);
    assert.match(fake.inputs[0]!, /raw 1/);
    assert.doesNotMatch(fake.inputs[0]!, /raw trigger/);
  } finally {
    f.cleanup();
  }
});

test("historical projection cannot skip an unmarked first physical user", () => {
  const f = fixture();
  try {
    const fake = new FakeProvider(() => "Must not generate");
    setAutoTitleProviderForTests(fake);
    f.manager.appendMessage({ role: "user", content: "cancelled first user", timestamp: Date.now() } as any);
    f.manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "cancelled" }],
      provider: "synthetic",
      model: "synthetic",
      stopReason: "aborted",
      timestamp: Date.now(),
    } as any);
    appendExchange(f.manager, 2);
    persistFile(f);

    assert.equal(scheduleWayangAutoTitle(f.rowId), null);
    assert.equal(fake.prepareCalls, 0);
  } finally {
    f.cleanup();
  }
});

test("a durable Pi success invalidates snapshots even when the Wayang mirror write fails", async () => {
  const f = fixture();
  try {
    const fake = new FakeProvider(() => "Canonical despite mirror failure");
    setAutoTitleProviderForTests(fake);
    for (let index = 1; index <= 3; index++) appendExchange(f.manager, index);
    persistFile(f);
    failNextCommitStoreMutationPersistenceForTests();
    let invalidations = 0;
    await scheduleWayangAutoTitle(f.rowId, { onCommitted: () => { invalidations++; } });
    assert.equal(
      SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(),
      "Canonical despite mirror failure",
    );
    assert.equal(invalidations, 1);
    assert.equal(getSessionById(f.rowId)?.title_source, "provisional", "failed mirror leaves the durable pre-CAS row intact");
  } finally {
    f.cleanup();
  }
});

test("same-count failure is suppressed and the next completed exchange permits one retry", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const fake = new FakeProvider(() => {
      calls++;
      if (calls === 1) throw new Error("synthetic unavailable");
      return "Retry title";
    });
    setAutoTitleProviderForTests(fake);
    for (let index = 1; index <= 3; index++) appendExchange(f.manager, index);
    persistFile(f);
    await scheduleWayangAutoTitle(f.rowId);
    assert.equal(scheduleWayangAutoTitle(f.rowId), null);
    assert.equal(fake.dispatchCalls, 1);

    appendExchange(f.manager, 4);
    await scheduleWayangAutoTitle(f.rowId);
    assert.equal(fake.dispatchCalls, 2);
    assert.doesNotMatch(fake.inputs[1]!, /raw 4/, "retry still sends only the first three exchanges");
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(), "Retry title");
  } finally {
    f.cleanup();
  }
});

test("each distinct accepted interaction can retry a failed unchanged-history attempt", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const fake = new FakeProvider(() => {
      calls++;
      if (calls < 3) throw new Error("synthetic unavailable");
      return "Interaction retry title";
    });
    setAutoTitleProviderForTests(fake);
    for (let index = 1; index <= 3; index++) appendExchange(f.manager, index);
    persistFile(f);

    await scheduleWayangAutoTitle(f.rowId);
    assert.equal(scheduleWayangAutoTitle(f.rowId), null, "ordinary same-history triggers remain suppressed");
    await scheduleWayangAutoTitleOnInteraction(f.rowId, "accepted-interaction-one");
    assert.equal(fake.dispatchCalls, 2);
    assert.equal(scheduleWayangAutoTitleOnInteraction(f.rowId, "accepted-interaction-one"), null);
    assert.equal(fake.dispatchCalls, 2, "one accepted interaction cannot retry itself");

    await scheduleWayangAutoTitleOnInteraction(f.rowId, "accepted-interaction-two");
    assert.equal(fake.dispatchCalls, 3);
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(), "Interaction retry title");
  } finally {
    f.cleanup();
  }
});

test("in-flight title work coalesces across a newly completed interaction", async () => {
  const f = fixture();
  try {
    const response = deferred<string>();
    const dispatched = deferred<void>();
    let dispatchCalls = 0;
    setAutoTitleProviderForTests({
      async prepare() {
        return {
          dispatch() {
            dispatchCalls++;
            dispatched.resolve();
            return response.promise;
          },
        };
      },
    });
    for (let index = 1; index <= 3; index++) appendExchange(f.manager, index);
    persistFile(f);

    const first = scheduleWayangAutoTitleOnInteraction(f.rowId, "interaction-before-new-exchange");
    assert.ok(first);
    await dispatched.promise;
    appendExchange(f.manager, 4);
    const second = scheduleWayangAutoTitleOnInteraction(f.rowId, "interaction-after-new-exchange");
    assert.equal(second, first, "the same bounded first-three projection has only one provider request");
    response.resolve("Coalesced title");
    await first;

    assert.equal(dispatchCalls, 1);
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(), "Coalesced title");
  } finally {
    f.cleanup();
  }
});

test("interaction repairs a canonical Pi title without another provider request", async () => {
  const f = fixture();
  try {
    const fake = new FakeProvider(() => "Canonical automatic title");
    setAutoTitleProviderForTests(fake);
    for (let index = 1; index <= 3; index++) appendExchange(f.manager, index);
    persistFile(f);
    failNextCommitStoreMutationPersistenceForTests();
    await scheduleWayangAutoTitle(f.rowId);
    assert.equal(fake.dispatchCalls, 1);
    assert.equal(getSessionById(f.rowId)?.title_source, "provisional");

    assert.equal(scheduleWayangAutoTitleOnInteraction(f.rowId, "repair-interaction"), null);
    assert.equal(fake.dispatchCalls, 1, "a physical session_info must suppress another title-model call");
    assert.deepEqual(
      [getSessionById(f.rowId)?.title, getSessionById(f.rowId)?.title_source],
      ["Canonical automatic title", "pi"],
    );
  } finally {
    f.cleanup();
  }
});

test("interaction preserves authored and deliberately cleared physical titles", () => {
  for (const physicalName of ["Agent-authored title", ""] as const) {
    const f = fixture();
    try {
      const fake = new FakeProvider(() => "Must not generate");
      setAutoTitleProviderForTests(fake);
      appendExchange(f.manager, 1);
      persistFile(f);
      if (!physicalName) setProvisionalSessionTitle(f.rowId, "Old provisional fallback");
      f.manager.appendSessionInfo(physicalName, { origin: "human" });

      assert.equal(scheduleWayangAutoTitleOnInteraction(f.rowId, `interaction-${physicalName || "clear"}`), null);
      assert.equal(fake.dispatchCalls, 0);
      if (physicalName) {
        assert.deepEqual(
          [getSessionById(f.rowId)?.title, getSessionById(f.rowId)?.title_source],
          [physicalName, "pi"],
        );
      } else {
        assert.deepEqual(
          [getSessionById(f.rowId)?.title, getSessionById(f.rowId)?.title_source],
          ["", "pi"],
          "a deliberate blank session_info clears stale fallback display and blocks automation",
        );
      }
    } finally {
      f.cleanup();
    }
  }
});

test("accepted-message naming preserves authored and deliberately cleared physical titles", () => {
  for (const physicalName of ["Agent-authored title", ""] as const) {
    const f = fixture();
    try {
      const fake = new FakeProvider(() => "Must not generate");
      setAutoTitleProviderForTests(fake);
      persistFile(f);
      if (!physicalName) setProvisionalSessionTitle(f.rowId, "Old provisional fallback");
      f.manager.appendSessionInfo(physicalName, { origin: "human" });
      const turn = acceptedTurn(f, "raw accepted", physicalName ? "accepted-authored" : "accepted-clear");

      assert.equal(scheduleWayangAutoTitleOnAcceptedTurn(f.rowId, turn, { stillAccepted: () => true }), null);
      assert.equal(fake.dispatchCalls, 0);
      assert.deepEqual(
        [getSessionById(f.rowId)?.title, getSessionById(f.rowId)?.title_source],
        physicalName ? [physicalName, "pi"] : ["", "pi"],
      );
    } finally {
      f.cleanup();
    }
  }
});

test("a concurrent human name wins after provider dispatch", async () => {
  const f = fixture();
  try {
    const response = deferred<string>();
    const dispatched = deferred<void>();
    const fake: TitleProvider = {
      async prepare() {
        return {
          dispatch() {
            dispatched.resolve();
            return response.promise;
          },
        };
      },
    };
    setAutoTitleProviderForTests(fake);
    for (let index = 1; index <= 3; index++) appendExchange(f.manager, index);
    persistFile(f);
    const work = scheduleWayangAutoTitle(f.rowId)!;
    await dispatched.promise;
    SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).appendSessionInfo("Human title", { origin: "human" });
    response.resolve("Automatic title");
    await work;
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(), "Human title");
    assert.notEqual(getSessionById(f.rowId)?.title, "Automatic title");
  } finally {
    f.cleanup();
  }
});

test("stopped activation catch-up reuses its history snapshot before commit", async () => {
  const f = fixture();
  try {
    const fake = new FakeProvider(() => "Activation title");
    setAutoTitleProviderForTests(fake);
    for (let index = 1; index <= 3; index++) appendExchange(f.manager, index);
    persistFile(f);
    const snapshot = getSessionFileSnapshot(f.manager.getSessionFile()!, f.cwd);
    assert.ok(snapshot?.autoTitle.markedProjection);
    const work = scheduleWayangAutoTitleFromActivation(f.rowId, snapshot.autoTitle, {
      stillSelected: () => true,
      onCommitted: invalidateSessionFileSnapshot,
    });
    assert.ok(work);
    await work;
    assert.equal(fake.dispatchCalls, 1);
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(), "Activation title");
  } finally {
    f.cleanup();
  }
});

test("request-time gate observes a Protected-policy change before dispatch", async () => {
  const f = fixture();
  try {
    const prepared = deferred<{ dispatch(input: string): Promise<string> }>();
    let dispatchCalls = 0;
    setAutoTitleProviderForTests({ prepare: () => prepared.promise });
    for (let index = 1; index <= 3; index++) appendExchange(f.manager, index);
    persistFile(f);
    const work = scheduleWayangAutoTitle(f.rowId)!;
    const project = getStore().projects.find((candidate) => candidate.cwd === f.cwd)!;
    project.access_policy.privacy_mode = "protected";
    project.access_policy.allowed_agent_profile_ids = [project.default_agent_profile_id];
    flush();
    prepared.resolve({ dispatch: async () => { dispatchCalls++; return "Must not dispatch"; } });
    await work;
    assert.equal(dispatchCalls, 0);
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(), undefined);
  } finally {
    f.cleanup();
  }
});
