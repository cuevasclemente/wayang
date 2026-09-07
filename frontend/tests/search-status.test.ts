import { test } from "node:test";
import assert from "node:assert/strict";
import { searchStatusMessage } from "../src/lib/search-status.ts";

const empty = { query: "example", results: [], took_ms: 1, facets: { cwds: [], models: [] } };

test("incomplete and paused empty searches retain visible explanations", () => {
  assert.equal(searchStatusMessage(empty), null);
  assert.match(searchStatusMessage({ ...empty, degraded: "indexing_paused" })!, /paused/);
  assert.match(searchStatusMessage({ ...empty, degraded: "index_incomplete" })!, /incomplete/);
  assert.match(searchStatusMessage({ ...empty, degraded: "indexing_in_progress" })!, /several minutes/);
  assert.match(searchStatusMessage({ ...empty, degraded: "index_unavailable" })!, /unavailable/);
});
