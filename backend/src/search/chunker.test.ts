/**
 * chunker.test.ts — Unit tests for the JSONL chunker.
 *
 * Fixtures are synthesized in /tmp at test time so we never touch real
 * session history files.
 */

import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chunkJsonlFile, MAX_CHUNK_CHARS } from "./chunker.js";

function tempFile(name: string, lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-chunker-"));
  const file = path.join(dir, name);
  const body = lines.length === 0 ? "" : lines.join("\n") + "\n";
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

const baseMeta = {
  title: "Test session",
  goal: "exercise the chunker",
  cwd: "/tmp/proj",
  model: "openrouter/test-model",
};

test("emits a meta chunk even for an empty file", async () => {
  const file = tempFile("empty.jsonl", []);
  const { chunks, stats } = await chunkJsonlFile(file, baseMeta);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].role, "meta");
  assert.match(chunks[0].text, /Test session/);
  assert.match(chunks[0].text, /cwd: \/tmp\/proj/);
  assert.equal(stats.linesRead, 0);
  assert.equal(stats.messagesUsed, 0);
});

test("skips non-message rows and tool/thinking content by default", async () => {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/tmp/proj" }),
    JSON.stringify({ type: "model_change", provider: "x", modelId: "y" }),
    JSON.stringify({
      type: "message",
      id: "m1",
      message: {
        role: "user",
        content: [
          { type: "text", text: "Find the bug in foo.ts" },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "m2",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning we should not index by default" },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "text", text: "Reading foo.ts now." },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "m3",
      message: {
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }],
      },
    }),
  ];
  const file = tempFile("mixed.jsonl", lines);
  const { chunks } = await chunkJsonlFile(file, baseMeta);
  const transcript = chunks
    .filter((c) => c.role !== "meta")
    .map((c) => c.text)
    .join("\n");
  assert.match(transcript, /Find the bug in foo\.ts/);
  assert.match(transcript, /Reading foo\.ts now/);
  assert.doesNotMatch(transcript, /internal reasoning/);
  assert.doesNotMatch(transcript, /file contents/);
  assert.doesNotMatch(transcript, /tool_result/);
});

test("adjacent same-role messages retain distinct exact anchors", async () => {
  const file = tempFile("same-role.jsonl", [
    JSON.stringify({ type: "message", id: "first", message: { role: "user", content: "first exact canary" } }),
    JSON.stringify({ type: "message", id: "second", message: { role: "user", content: "second exact platypus" } }),
  ]);
  const { chunks } = await chunkJsonlFile(file, baseMeta);
  const transcript = chunks.filter((chunk) => chunk.role !== "meta");
  assert.deepEqual(transcript.map((chunk) => chunk.messageId), ["first", "second"]);
  assert.match(transcript[1].text, /platypus/);
  assert.doesNotMatch(transcript[1].text, /canary/);
});

test("includes thinking when option is set", async () => {
  const lines = [
    JSON.stringify({
      type: "message",
      id: "m1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret reasoning" },
          { type: "text", text: "visible reply" },
        ],
      },
    }),
  ];
  const file = tempFile("think.jsonl", lines);
  const { chunks } = await chunkJsonlFile(file, baseMeta, { includeThinking: true });
  const allText = chunks.map((c) => c.text).join("\n");
  assert.match(allText, /visible reply/);
  assert.match(allText, /secret reasoning/);
  const thinkingChunks = chunks.filter((c) => c.role === "thinking");
  assert.ok(thinkingChunks.length >= 1, "expected at least one thinking chunk");
});

test("accepts legacy string content as well as array content", async () => {
  const lines = [
    JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hello world" } }),
    JSON.stringify({
      type: "message",
      id: "m2",
      message: { role: "assistant", content: [{ type: "text", text: "hi back" }] },
    }),
  ];
  const file = tempFile("legacy.jsonl", lines);
  const { chunks } = await chunkJsonlFile(file, baseMeta);
  const allText = chunks.map((c) => c.text).join("\n");
  assert.match(allText, /hello world/);
  assert.match(allText, /hi back/);
});

test("splits utterances longer than MAX_CHUNK_CHARS", async () => {
  const longText = "abc ".repeat(2000); // ~8000 chars
  const lines = [
    JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "user", content: [{ type: "text", text: longText }] },
    }),
  ];
  const file = tempFile("long.jsonl", lines);
  const { chunks } = await chunkJsonlFile(file, baseMeta);
  const transcriptChunks = chunks.filter((c) => c.role !== "meta");
  assert.ok(transcriptChunks.length >= 2, `expected splits, got ${transcriptChunks.length}`);
  for (const c of transcriptChunks) {
    assert.ok(c.text.length <= MAX_CHUNK_CHARS + 256, "chunk should be near max size");
  }
});

test("keeps adjacent searchable messages on exact message-bound chunks", async () => {
  const lines: string[] = [];
  for (let i = 0; i < 40; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `m${i}`,
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: `turn ${i} content `.repeat(5) }],
        },
      }),
    );
  }
  const file = tempFile("many.jsonl", lines);
  const { chunks, stats } = await chunkJsonlFile(file, baseMeta);
  const transcriptChunks = chunks.filter((c) => c.role !== "meta");
  assert.equal(stats.messagesUsed, 40);
  assert.equal(transcriptChunks.length, 40);
  assert.deepEqual(transcriptChunks.map((chunk) => chunk.messageId),
    Array.from({ length: 40 }, (_, index) => `m${index}`));
  assert.ok(transcriptChunks.every((chunk) => !(chunk.text.includes("User:") && chunk.text.includes("Assistant:"))));
});

test("fingerprint rejection closes its descriptor before the promise settles", async () => {
  const file = tempFile("fingerprint-race.jsonl", [
    JSON.stringify({ type: "session", version: 3, id: "s-race", cwd: "/tmp/proj" }),
    JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "before" } }),
  ]);
  const stat = fs.statSync(file);
  const expectedFingerprint = {
    ino: Number(stat.ino) || 0,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
  fs.appendFileSync(file, JSON.stringify({
    type: "message", id: "m2", message: { role: "assistant", content: "after" },
  }) + "\n");
  await assert.rejects(
    chunkJsonlFile(file, baseMeta, { expectedFingerprint }),
    /changed before search indexing/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  fs.writeFileSync(file, "", "utf8");
  assert.equal(fs.readFileSync(file, "utf8"), "");
});

test("recovers from malformed lines without aborting", async () => {
  const lines = [
    "this is not json",
    JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "ok" } }),
    "{invalid",
    JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: "fine" } }),
  ];
  const file = tempFile("malformed.jsonl", lines);
  const { chunks, stats } = await chunkJsonlFile(file, baseMeta);
  const allText = chunks.map((c) => c.text).join("\n");
  assert.match(allText, /User: ok/);
  assert.match(allText, /Assistant: fine/);
  assert.equal(stats.skippedParseErrors, 2);
});
