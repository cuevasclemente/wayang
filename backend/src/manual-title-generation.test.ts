import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { close, init } from "./db.js";
import {
  createSession,
  getSessionById,
  setExplicitSessionTitle,
  updatePiSessionFile,
} from "./sessions.js";
import { WAYANG_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE } from "./interactive-turn-provenance.js";
import {
  cancelManualTitleGeneration,
  enqueueManualTitleGeneration,
  getManualTitleGeneration,
  ManualTitleGenerationError,
  resetManualTitleGenerationForTests,
  runManualTitleGenerationNowForTests,
  setManualTitleProviderForTests,
  type ManualTitleGenerationDependencies,
} from "./manual-title-generation.js";
import type { TitleProvider } from "./terra-title-provider.js";

interface Fixture {
  root: string;
  cwd: string;
  rowId: string;
  manager: SessionManager;
  busy: { value: boolean };
  dependencies: ManualTitleGenerationDependencies;
  cleanup(): void;
}

function fixture(title?: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-manual-title-"));
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  const previousAutoTitle = process.env.WAYANG_AUTO_SESSION_TITLE;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  process.env.WAYANG_AUTO_SESSION_TITLE = "on";
  init();
  const row = createSession(cwd, title ? { title } : undefined);
  const manager = SessionManager.create(cwd, path.join(root, "sessions"), { id: row.id });
  if (title) manager.appendSessionInfo(title, { origin: "human" });
  manager.materialize();
  updatePiSessionFile(row.id, manager.getSessionFile()!);
  const busy = { value: false };
  return {
    root,
    cwd,
    rowId: row.id,
    manager,
    busy,
    dependencies: { isBusy: () => busy.value },
    cleanup() {
      resetManualTitleGenerationForTests();
      close();
      if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
      else process.env.WAYANG_DATA_DIR = previousDataDir;
      if (previousAutoTitle === undefined) delete process.env.WAYANG_AUTO_SESSION_TITLE;
      else process.env.WAYANG_AUTO_SESSION_TITLE = previousAutoTitle;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function appendExchange(manager: SessionManager, index: number): void {
  const userEntryId = manager.appendMessage({ role: "user", content: `decorated ${index}`, timestamp: Date.now() } as any);
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: `private ${index}` },
      { type: "text", text: `assistant ${index}` },
    ],
    provider: "synthetic",
    model: "synthetic",
    stopReason: "stop",
    timestamp: Date.now(),
  } as any);
  manager.appendCustomEntry(WAYANG_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE, {
    user_entry_id: userEntryId,
    raw_user_text: `raw ${index}`,
    accepted_at: index,
    client_message_id: `manual-title-${index}`,
  });
}

function appendFailedExchange(manager: SessionManager, index: number): void {
  const userEntryId = manager.appendMessage({ role: "user", content: `decorated ${index}`, timestamp: Date.now() } as any);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `failed assistant ${index}` }],
    provider: "synthetic",
    model: "synthetic",
    stopReason: "error",
    timestamp: Date.now(),
  } as any);
  manager.appendCustomEntry(WAYANG_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE, {
    user_entry_id: userEntryId,
    raw_user_text: `raw ${index}`,
    accepted_at: index,
    client_message_id: `manual-title-${index}`,
  });
}

function appendRecoveredExchange(manager: SessionManager, index: number): void {
  const userEntryId = manager.appendMessage({ role: "user", content: `decorated ${index}`, timestamp: Date.now() } as any);
  for (const [text, stopReason] of [
    [`checkpoint ${index}`, "toolUse"],
    ["", "error"],
    [`recovered ${index}`, "stop"],
  ] as const) {
    manager.appendMessage({
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      provider: "synthetic",
      model: "synthetic",
      stopReason,
      timestamp: Date.now(),
    } as any);
  }
  manager.appendCustomEntry(WAYANG_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE, {
    user_entry_id: userEntryId,
    raw_user_text: `raw ${index}`,
    accepted_at: index,
    client_message_id: `manual-title-${index}`,
  });
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

test("explicit generation replaces a confirmed human title through Pi CAS", async () => {
  const f = fixture("Confirmed old title");
  try {
    appendExchange(f.manager, 1);
    const fake = new FakeProvider(() => "Generated replacement");
    setManualTitleProviderForTests(fake);
    const queued = enqueueManualTitleGeneration(f.rowId, { expectedTitle: "Confirmed old title" }, f.dependencies);
    assert.equal(queued.state, "queued");

    await runManualTitleGenerationNowForTests(f.rowId);
    const completed = getManualTitleGeneration(f.rowId);
    assert.deepEqual([completed.state, completed.title], ["completed", "Generated replacement"]);
    assert.equal(fake.dispatchCalls, 1);
    assert.match(fake.inputs[0]!, /raw 1/);
    assert.doesNotMatch(fake.inputs[0]!, /decorated|private/);
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(), "Generated replacement");
    assert.deepEqual(
      [getSessionById(f.rowId)?.title, getSessionById(f.rowId)?.title_source],
      ["Generated replacement", "pi"],
    );
  } finally {
    f.cleanup();
  }
});

test("busy requests queue once and dispatch after idle", async () => {
  const f = fixture();
  try {
    appendExchange(f.manager, 1);
    const fake = new FakeProvider(() => "Queued title");
    setManualTitleProviderForTests(fake);
    f.busy.value = true;
    const first = enqueueManualTitleGeneration(f.rowId, { expectedTitle: "" }, f.dependencies);
    const duplicate = enqueueManualTitleGeneration(f.rowId, { expectedTitle: "" }, f.dependencies);
    assert.equal(duplicate.request_id, first.request_id);

    await runManualTitleGenerationNowForTests(f.rowId);
    assert.equal(getManualTitleGeneration(f.rowId).state, "queued");
    assert.equal(fake.prepareCalls, 0);
    f.busy.value = false;
    await runManualTitleGenerationNowForTests(f.rowId);
    assert.equal(getManualTitleGeneration(f.rowId).state, "completed");
    assert.equal(fake.dispatchCalls, 1);
  } finally {
    f.cleanup();
  }
});

test("only the first three completed exchanges are disclosed", async () => {
  const f = fixture();
  try {
    for (let index = 1; index <= 4; index++) appendExchange(f.manager, index);
    const fake = new FakeProvider(() => "First three title");
    setManualTitleProviderForTests(fake);
    enqueueManualTitleGeneration(f.rowId, { expectedTitle: "" }, f.dependencies);
    await runManualTitleGenerationNowForTests(f.rowId);

    assert.match(fake.inputs[0]!, /raw 1/);
    assert.match(fake.inputs[0]!, /raw 2/);
    assert.match(fake.inputs[0]!, /raw 3/);
    assert.doesNotMatch(fake.inputs[0]!, /raw 4|private|decorated/);
  } finally {
    f.cleanup();
  }
});

test("transient assistant errors remain eligible when the same turn recovers", async () => {
  const f = fixture();
  try {
    appendRecoveredExchange(f.manager, 1);
    const fake = new FakeProvider(() => "Recovered exchange title");
    setManualTitleProviderForTests(fake);
    enqueueManualTitleGeneration(f.rowId, { expectedTitle: "" }, f.dependencies);
    await runManualTitleGenerationNowForTests(f.rowId);

    assert.equal(getManualTitleGeneration(f.rowId).state, "completed");
    assert.equal(fake.dispatchCalls, 1);
    assert.match(fake.inputs[0]!, /raw 1/);
    assert.match(fake.inputs[0]!, /checkpoint 1\s+recovered 1/);
  } finally {
    f.cleanup();
  }
});

test("a failed first exchange does not block the earliest completed exchange", async () => {
  const f = fixture();
  try {
    appendFailedExchange(f.manager, 1);
    appendExchange(f.manager, 2);
    const fake = new FakeProvider(() => "Later completed title");
    setManualTitleProviderForTests(fake);
    enqueueManualTitleGeneration(f.rowId, { expectedTitle: "" }, f.dependencies);
    await runManualTitleGenerationNowForTests(f.rowId);

    assert.equal(getManualTitleGeneration(f.rowId).state, "completed");
    assert.equal(fake.dispatchCalls, 1);
    assert.match(fake.inputs[0]!, /raw 2/);
    assert.doesNotMatch(fake.inputs[0]!, /raw 1|failed assistant 1/);
  } finally {
    f.cleanup();
  }
});

test("manual rename after enqueue wins before provider disclosure", async () => {
  const f = fixture("Old title");
  try {
    appendExchange(f.manager, 1);
    const fake = new FakeProvider(() => "Must not generate");
    setManualTitleProviderForTests(fake);
    f.busy.value = true;
    enqueueManualTitleGeneration(f.rowId, { expectedTitle: "Old title" }, f.dependencies);
    setExplicitSessionTitle(f.rowId, "New human title");
    f.manager.appendSessionInfo("New human title", { origin: "human" });
    f.busy.value = false;

    await runManualTitleGenerationNowForTests(f.rowId);
    assert.equal(getManualTitleGeneration(f.rowId).state, "conflict");
    assert.equal(fake.prepareCalls, 0);
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(), "New human title");
  } finally {
    f.cleanup();
  }
});

test("external physical rename after enqueue defeats generation", async () => {
  const f = fixture("Old title");
  try {
    appendExchange(f.manager, 1);
    const fake = new FakeProvider(() => "Must not generate");
    setManualTitleProviderForTests(fake);
    f.busy.value = true;
    enqueueManualTitleGeneration(f.rowId, { expectedTitle: "Old title" }, f.dependencies);
    f.manager.appendSessionInfo("External title", { origin: "human" });
    f.busy.value = false;

    await runManualTitleGenerationNowForTests(f.rowId);
    assert.equal(getManualTitleGeneration(f.rowId).state, "conflict");
    assert.equal(fake.prepareCalls, 0);
  } finally {
    f.cleanup();
  }
});

test("rename during provider request defeats commit", async () => {
  const f = fixture("Old title");
  try {
    appendExchange(f.manager, 1);
    const response = deferred<string>();
    const dispatched = deferred<void>();
    setManualTitleProviderForTests({
      async prepare() {
        return {
          dispatch() {
            dispatched.resolve();
            return response.promise;
          },
        };
      },
    });
    enqueueManualTitleGeneration(f.rowId, { expectedTitle: "Old title" }, f.dependencies);
    const running = runManualTitleGenerationNowForTests(f.rowId);
    await dispatched.promise;
    setExplicitSessionTitle(f.rowId, "Concurrent human title");
    f.manager.appendSessionInfo("Concurrent human title", { origin: "human" });
    response.resolve("Automatic title");
    await running;

    assert.equal(getManualTitleGeneration(f.rowId).state, "conflict");
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, undefined, f.cwd).getSessionName(), "Concurrent human title");
  } finally {
    f.cleanup();
  }
});

test("no completed turn fails without preparing Terra", async () => {
  const f = fixture();
  try {
    const fake = new FakeProvider(() => "Must not generate");
    setManualTitleProviderForTests(fake);
    enqueueManualTitleGeneration(f.rowId, { expectedTitle: "" }, f.dependencies);
    await runManualTitleGenerationNowForTests(f.rowId);
    const result = getManualTitleGeneration(f.rowId);
    assert.deepEqual([result.state, result.code], ["failed", "title_input_unavailable"]);
    assert.equal(fake.prepareCalls, 0);
  } finally {
    f.cleanup();
  }
});

test("explicit action retains the configured Terra disclosure gate", () => {
  const f = fixture();
  try {
    appendExchange(f.manager, 1);
    delete process.env.WAYANG_AUTO_SESSION_TITLE;
    assert.throws(
      () => enqueueManualTitleGeneration(f.rowId, { expectedTitle: "" }, f.dependencies),
      (error: unknown) => error instanceof ManualTitleGenerationError
        && error.code === "title_generation_disabled"
        && error.statusCode === 403,
    );
  } finally {
    f.cleanup();
  }
});

test("cancel and restart reset clear process-local queue state", () => {
  const f = fixture();
  try {
    appendExchange(f.manager, 1);
    f.busy.value = true;
    enqueueManualTitleGeneration(f.rowId, { expectedTitle: "" }, f.dependencies);
    cancelManualTitleGeneration(f.rowId);
    assert.equal(getManualTitleGeneration(f.rowId).state, "cancelled");
    resetManualTitleGenerationForTests();
    assert.equal(getManualTitleGeneration(f.rowId).state, "idle");
  } finally {
    f.cleanup();
  }
});
