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
