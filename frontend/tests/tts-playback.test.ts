import assert from "node:assert/strict";
import { test } from "node:test";
import { initialTtsPlayback, ttsPlaybackReducer as reduce, ttsPlaybackStage as stage } from "../src/tts/playbackController.ts";

const chunk = (index: number) => ({ index, status: "completed" as const, url: `/api/tts/jobs/test/chunks/${index}` });
const start = () => reduce(initialTtsPlayback(), { type: "start" });
const ready = (state: ReturnType<typeof start>, index: number) => reduce(state, { type: "chunk", chunk: chunk(index) });
const end = (state: ReturnType<typeof start>) => reduce(state, { type: "ended", sourceId: state.source!.id });

test("first segment starts immediately; ended segment waits silently and advances only to exact next", () => {
  let state = ready(start(), 1);
  assert.equal(stage(state), "playing");
  assert.equal(state.source?.index, 1);
  assert.equal(state.playCommand, 1);
  state = end(state);
  assert.equal(stage(state), "buffering_next_chunk");
  assert.equal(state.playCommand, 1);
  state = ready(state, 3);
  assert.equal(state.source?.index, 1);
  assert.equal(state.playCommand, 1);
  state = ready(state, 2);
  assert.equal(state.source?.index, 2);
  assert.equal(state.playCommand, 2);
  state = end(state);
  assert.equal(state.source?.index, 3);
  assert.equal(state.playCommand, 3);
});

test("future/duplicate chunks and stale generation snapshots never restart or replace active audio", () => {
  let state = ready(start(), 1);
  const source = state.source;
  state = ready(state, 2);
  state = ready(state, 1);
  state = reduce(state, { type: "generation", status: "generating" });
  state = reduce(state, { type: "manifest", manifest: { chunks: [{ ...chunk(1), url: "/changed" }], chunks_total: 3 } });
  state = reduce(state, { type: "manifest", manifest: { chunks: [] } });
  assert.equal(state.source, source);
  assert.equal(state.chunks[1], chunk(1).url);
  assert.equal(state.chunks[2], chunk(2).url);
  assert.equal(state.playCommand, 1);
});

test("an initial out-of-order chunk cannot skip segment one", () => {
  let state = ready(start(), 2);
  assert.equal(state.source, null);
  assert.equal(state.playCommand, 0);
  state = ready(state, 1);
  assert.equal(state.source?.index, 1);
});

test("batched completion and final chunk play once; full replay is explicit", () => {
  let state = end(ready(start(), 1));
  state = reduce(state, { type: "manifest", manifest: {
    status: "completed", chunks: [chunk(1), chunk(2)], chunks_total: 2, chunks_completed: 2,
    final_audio_url: "/api/tts/jobs/test/final",
  } });
  assert.equal(state.source?.index, 2);
  assert.equal(state.playCommand, 2);
  state = end(state);
  assert.equal(stage(state), "ready_final");
  assert.equal(state.source?.index, 2);
  assert.equal(state.playCommand, 2);
  state = reduce(state, { type: "generation", status: "generating" });
  assert.equal(stage(state), "ready_final");
  state = reduce(state, { type: "replay" });
  assert.equal(state.source?.url, "/api/tts/jobs/test/final");
  assert.equal(state.source?.index, null);
  assert.equal(state.playCommand, 3);
  state = end(state);
  assert.equal(stage(state), "ready_final");
  assert.equal(state.playCommand, 3);
});

test("completion does not pretend a missing segment was played", () => {
  let state = end(ready(start(), 1));
  state = reduce(state, { type: "manifest", manifest: { status: "completed", chunks: [chunk(3)], chunks_total: 3, final_audio_url: "/final" } });
  assert.equal(stage(state), "buffering_next_chunk");
  assert.equal(state.playCommand, 1);
  assert.equal(state.nextIndex, 2);
});

for (const intent of ["pause", "blocked"] as const) {
  test(`${intent} survives future events and completion until explicit resume`, () => {
    let state = ready(start(), 1);
    state = reduce(state, intent === "pause" ? { type: "pause" } : { type: "blocked", command: state.playCommand });
    state = reduce(state, { type: "manifest", manifest: { status: "completed", chunks: [chunk(1), chunk(2)], chunks_total: 2, final_audio_url: "/final" } });
    assert.equal(state.intent, intent);
    assert.equal(state.playCommand, 1);
    assert.equal(state.source?.index, 1);
    state = reduce(state, { type: "resume" });
    assert.equal(state.playCommand, 2);
    state = end(state);
    assert.equal(state.source?.index, 2);
    assert.equal(state.playCommand, 3);
  });
}

test("pausing a silent gap holds the next segment; resume never replays the ended source", () => {
  let state = end(ready(start(), 1));
  state = reduce(state, { type: "pause" });
  state = ready(state, 2);
  assert.equal(state.playCommand, 1);
  assert.equal(state.source?.index, 1);
  state = reduce(state, { type: "resume" });
  assert.equal(state.source?.index, 2);
  assert.equal(state.playCommand, 2);
});

test("stale end and rejection cannot affect a newer source; native play is not a command", () => {
  let state = ready(ready(start(), 1), 2);
  const oldSource = state.source!.id;
  state = end(state);
  const next = state;
  state = reduce(state, { type: "ended", sourceId: oldSource });
  state = reduce(state, { type: "blocked", command: oldSource });
  assert.equal(state, next);
  state = reduce(state, { type: "native_play" });
  assert.equal(state.playCommand, 2);
});

test("direct fallback plays once, finishes without buffering, and allows full replay", () => {
  let state = reduce(start(), { type: "direct", url: "/v1/tts/direct/audio" });
  assert.equal(state.source?.url, "/api/tts/direct/audio");
  assert.equal(state.playCommand, 1);
  state = end(state);
  assert.equal(stage(state), "ready_final");
  state = reduce(state, { type: "replay" });
  assert.equal(state.playCommand, 2);
});

test("retry resets queue, cursor, failure and playback intent", () => {
  let state = end(ready(start(), 1));
  state = reduce(state, { type: "error", error: "synthetic" });
  state = ready(state, 2);
  assert.equal(state.playCommand, 1);
  state = reduce(state, { type: "start" });
  assert.deepEqual(state, start());
});
