import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DerivedTodoProjectionService } from "./derived-todo.js";
import { readTranscriptFileRevision } from "./reverse-reader.js";

function transcript(lines: unknown[]): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-derived-todo-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return { dir, file };
}

const header = { type: "session", version: 3, id: "session", cwd: "/synthetic" };
const todoState = (id: string, parentId: string | null, text: string) => ({
  type: "custom", id, parentId, customType: "todo-state", data: {
    todos: [{ text, status: "pending" }], nextId: 2,
  },
});
const tip = (id: string, parentId: string | null) => ({
  type: "message", id, parentId, message: { role: "assistant", content: [{ type: "text", text: "synthetic tip" }] },
});

test("derived TODO projection follows active branch and last todo-state wins", async () => {
  const { dir, file } = transcript([
    header,
    todoState("first", null, "first active"),
    todoState("sibling", "first", "off branch secret"),
    todoState("last", "first", "last active"),
    tip("tip", "last"),
  ]);
  const service = new DerivedTodoProjectionService();
  try {
    const projection = await service.project(file);
    assert.deepEqual(projection?.fingerprint, readTranscriptFileRevision(file));
    assert.equal(projection?.todoState.source, "todo-state");
    assert.deepEqual(projection?.todoState.todos.map((todo) => todo.text), ["last active"]);
    assert.equal(JSON.stringify(projection).includes("off branch secret"), false);
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("off-branch TODO quota poison cannot suppress valid active TODO", async () => {
  const poison = Array.from({ length: 501 }, (_, index) => ({ text: `poison-${index}` }));
  const { dir, file } = transcript([
    header,
    tip("root", null),
    { type: "custom", id: "poison", parentId: "root", customType: "todo-state", data: { todos: poison } },
    todoState("active", "root", "valid active"),
  ]);
  const service = new DerivedTodoProjectionService();
  try {
    const projection = await service.project(file);
    assert.deepEqual(projection?.todoState.todos.map((todo) => todo.text), ["valid active"]);
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("derived TODO projection recognizes active todo toolResult", async () => {
  const { dir, file } = transcript([
    header,
    {
      type: "message", id: "tool", parentId: null,
      message: {
        role: "toolResult", toolName: "todo", toolCallId: "call-1",
        content: [{ type: "text", text: "bounded tool output" }],
        details: { todos: [{ id: 7, text: "from tool", status: "in_progress" }], nextId: 8 },
      },
    },
  ]);
  const service = new DerivedTodoProjectionService();
  try {
    const projection = await service.project(file);
    assert.equal(projection?.todoState.source, "tool-result");
    assert.deepEqual(projection?.todoState.todos, [{
      id: 7, text: "from tool", status: "in_progress",
      priority: undefined, assignee: undefined, notes: undefined, dependencies: undefined,
    }]);
    assert.equal(projection?.todoState.nextId, 8);
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty active state falls back to deduplicated preseed TODOs", async () => {
  const { dir, file } = transcript([
    header,
    { type: "custom", id: "pre-1", parentId: null, customType: "todo-preseed", data: { todos: [{ text: "seed one" }] } },
    { type: "custom", id: "pre-2", parentId: "pre-1", customType: "todo-preseed", data: { todos: [{ text: "seed one" }, { text: "seed two", priority: "high" }] } },
    { type: "custom", id: "empty", parentId: "pre-2", customType: "todo-state", data: { todos: [], nextId: 99 } },
  ]);
  const service = new DerivedTodoProjectionService();
  try {
    const projection = await service.project(file);
    assert.equal(projection?.todoState.source, "todo-preseed");
    assert.deepEqual(projection?.todoState.todos.map((todo) => [todo.id, todo.text]), [[1, "seed one"], [2, "seed two"]]);
    assert.equal(projection?.todoState.nextId, 3);
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TODO projection rejects a file changed after the owning authorization fingerprint", async () => {
  const { dir, file } = transcript([header, todoState("state", null, "stale authorization")]);
  const stat = fs.statSync(file);
  const expectedFingerprint = {
    ino: Number(stat.ino) || 0,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
  fs.appendFileSync(file, JSON.stringify(tip("changed", "state")) + "\n");
  const service = new DerivedTodoProjectionService();
  try {
    assert.equal(await service.project(file, expectedFingerprint), null);
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("policy change before TODO cache publication withholds the derived result", async () => {
  const { dir, file } = transcript([header, todoState("state", null, "policy stale")]);
  let allowed = true;
  const service = new DerivedTodoProjectionService({
    beforeCachePublishForTests() { allowed = false; },
  });
  try {
    assert.equal(await service.project(file, undefined, () => allowed), null);
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TODO worker rejects replacement before open with zero body bytes", async () => {
  const { dir, file } = transcript([header, todoState("state", null, "pre-open")]);
  const stat = fs.statSync(file);
  const expectedFingerprint = {
    ino: Number(stat.ino) || 0,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
  let observedBytes = -1;
  const content = fs.readFileSync(file);
  const service = new DerivedTodoProjectionService({
    beforeWorkerOpenForTests() {
      fs.renameSync(file, `${file}.old`);
      fs.writeFileSync(file, content);
    },
    observeWorkerBodyBytesForTests(_filePath, bytes) { observedBytes = bytes; },
  });
  try {
    assert.equal(await service.project(file, expectedFingerprint), null);
    assert.equal(observedBytes, 0);
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("revision change before cache publication withholds TODO projection", async () => {
  const { dir, file } = transcript([header, todoState("state", null, "stale")]);
  let release!: () => void;
  let paused!: () => void;
  const reached = new Promise<void>((resolve) => { paused = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = new DerivedTodoProjectionService({
    async beforeCachePublishForTests() {
      paused();
      await gate;
    },
  });
  try {
    const pending = service.project(file);
    await reached;
    fs.appendFileSync(file, JSON.stringify(tip("changed", "state")) + "\n");
    release();
    assert.equal(await pending, null);
  } finally {
    release();
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("same canonical path and fingerprint coalesce in-flight and cached scans", async () => {
  const { dir, file } = transcript([header, todoState("state", null, "cached")]);
  let release!: () => void;
  let paused!: () => void;
  const reached = new Promise<void>((resolve) => { paused = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = new DerivedTodoProjectionService({
    async beforeCachePublishForTests() {
      paused();
      await gate;
    },
  });
  try {
    const first = service.project(file);
    await reached;
    const second = service.project(file);
    assert.equal(first, second);
    assert.equal(service.getInstrumentation().workersStarted, 1);
    assert.equal(service.getInstrumentation().inFlightHits, 1);
    release();
    assert.ok(await first);
    assert.ok(await service.project(file));
    assert.equal(service.getInstrumentation().workersStarted, 1);
    assert.equal(service.getInstrumentation().cacheHits, 1);
  } finally {
    release();
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TODO workers enforce global concurrency two with a bounded queue", async () => {
  const fixtures = ["one", "two", "three"].map((text, index) => transcript([
    { ...header, id: `session-${index}` },
    todoState(`state-${index}`, null, text),
  ]));
  const service = new DerivedTodoProjectionService({ workerDelayMsForTests: 250, workerTimeoutMs: 2_000 });
  try {
    const pending = fixtures.map(({ file }) => service.project(file));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const running = service.getInstrumentation();
    assert.equal(running.activeCount, 2);
    assert.equal(running.peakActiveCount, 2);
    assert.equal(running.queuedCount, 1);
    assert.ok((await Promise.all(pending)).every(Boolean));
    assert.equal(service.getInstrumentation().workersStarted, 3);
  } finally {
    await service.close();
    for (const fixture of fixtures) fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("TODO worker timeout terminates and withholds projection", async () => {
  const { dir, file } = transcript([header, todoState("state", null, "timeout")]);
  const service = new DerivedTodoProjectionService({ workerDelayMsForTests: 500, workerTimeoutMs: 100 });
  try {
    assert.equal(await service.project(file), null);
    assert.equal(service.getInstrumentation().timeouts, 1);
    assert.equal(service.getInstrumentation().activeCount, 0);
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("new fingerprint supersedes older active request for the same canonical path", async () => {
  const { dir, file } = transcript([header, todoState("old", null, "old")]);
  const service = new DerivedTodoProjectionService({ workerDelayMsForTests: 250, workerTimeoutMs: 2_000 });
  try {
    const stale = service.project(file);
    await new Promise((resolve) => setTimeout(resolve, 40));
    fs.appendFileSync(file, JSON.stringify(todoState("new", "old", "new")) + "\n");
    const latest = service.project(file);
    assert.equal(await stale, null);
    const projection = await latest;
    assert.deepEqual(projection?.todoState.todos.map((todo) => todo.text), ["new"]);
    assert.equal(service.getInstrumentation().superseded, 1);
    assert.equal(service.getInstrumentation().workersStarted, 2);
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("oversized bounded TODO result is withheld rather than truncated", async () => {
  const todos = Array.from({ length: 500 }, (_, index) => ({
    id: index + 1,
    text: `todo-${index}-${"x".repeat(1_000)}`,
    status: "pending",
  }));
  const { dir, file } = transcript([
    header,
    { type: "custom", id: "large", parentId: null, customType: "todo-state", data: { todos, nextId: 501 } },
  ]);
  const service = new DerivedTodoProjectionService();
  try {
    assert.equal(await service.project(file), null);
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
