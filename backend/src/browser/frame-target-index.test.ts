import assert from "node:assert/strict";
import test from "node:test";
import { ManagedChromiumFrameTargetIndex } from "./frame-target-index.js";

test("frame attribution is synchronous, exact, epoch-bound, and ambiguity-failing", () => {
  const index = new ManagedChromiumFrameTargetIndex();
  const epoch = index.reset();
  index.addPageTarget("page-a", epoch);
  index.addPageTarget("page-b", epoch);
  assert.equal(index.attachSession("session-a", "page-a", epoch), true);
  index.addFrame("session-a", "main-a", epoch);
  assert.equal(index.resolve("main-a"), null, "unready target resolved");
  index.markReady("page-a", epoch);
  assert.equal(index.resolve("main-a"), "page-a");

  assert.equal(index.attachSession("iframe-a", "page-a", epoch), true);
  index.addFrame("iframe-a", "child-a", epoch);
  assert.equal(index.resolve("child-a"), "page-a");

  assert.equal(index.attachSession("session-b", "page-b", epoch), true);
  index.addFrame("session-b", "main-b", epoch);
  index.markReady("page-b", epoch);
  assert.equal(index.resolve("main-b"), "page-b");
  index.addFrame("session-b", "child-a", epoch);
  assert.equal(index.resolve("child-a"), null, "ambiguous cross-page claim resolved");
  index.removeFrame("session-b", "child-a");
  assert.equal(index.resolve("child-a"), "page-a");

  index.removePageTarget("page-a");
  assert.equal(index.resolve("main-a"), null);
  assert.equal(index.resolve("child-a"), null);

  const nextEpoch = index.reset();
  index.addPageTarget("page-c", nextEpoch);
  index.attachSession("session-c", "page-c", nextEpoch);
  index.addFrame("session-c", "main-c", epoch);
  index.markReady("page-c", epoch);
  assert.equal(index.resolve("main-c"), null, "old epoch repopulated attribution");
});

test("degraded roots and detached sessions fail closed", () => {
  const index = new ManagedChromiumFrameTargetIndex();
  const epoch = index.reset();
  index.addPageTarget("page", epoch);
  index.attachSession("session", "page", epoch);
  index.addFrame("session", "frame", epoch);
  index.markReady("page", epoch);
  assert.equal(index.resolve("frame"), "page");
  index.degrade("page", epoch);
  assert.equal(index.resolve("frame"), null);
  index.removeSession("session");
  assert.equal(index.resolve("frame"), null);
});
