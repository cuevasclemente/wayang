import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { close, failNextCommitStoreMutationPersistenceForTests, flush, getStore, init } from "./db.js";
import { createSession, getSessionById, updatePiSessionFile } from "./sessions.js";
import { WAYANG_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE } from "./interactive-turn-provenance.js";
import {
  scheduleWayangAutoTitle,
  scheduleWayangAutoTitleFromActivation,
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
  const sessionFile = f.manager.getSessionFile();
  assert.ok(sessionFile);
  updatePiSessionFile(f.rowId, sessionFile);
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

test("Wayang titles exactly after three completed marked exchanges", async () => {
  const f = fixture();
  try {
    const fake = new FakeProvider(() => "Three exchange summary");
    setAutoTitleProviderForTests(fake);
    appendExchange(f.manager, 1);
    appendExchange(f.manager, 2);
    persistFile(f);
    assert.equal(scheduleWayangAutoTitle(f.rowId), null);
    assert.equal(fake.dispatchCalls, 0);

    appendExchange(f.manager, 3);
    const work = scheduleWayangAutoTitle(f.rowId);
    assert.ok(work);
    await work;
    assert.equal(fake.dispatchCalls, 1);
    assert.match(fake.inputs[0]!, /raw 1/);
    assert.doesNotMatch(fake.inputs[0]!, /decorated/);
    const physical = SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd);
    assert.equal(physical.getSessionName(), "Three exchange summary");
    assert.equal(physical.getSessionNameState().entryId !== undefined, true);
    assert.deepEqual([getSessionById(f.rowId)?.title, getSessionById(f.rowId)?.title_source], ["Three exchange summary", "pi"]);
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
