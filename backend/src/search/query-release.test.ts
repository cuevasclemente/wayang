import test from "node:test";
import assert from "node:assert/strict";
import { executeRevalidatedSearch } from "./query-release.js";
import { SearchQueryError } from "./query-parser.js";

for (const change of ["revocation", "deleted-session", "new-session", "generation", "epoch", "metadata", "removed-metadata", "filter-state"]) {
  test(`async release discards ALL results/facets after ${change} and retries once`, async () => {
    let revision = "before";
    let calls = 0;
    const released = await executeRevalidatedSearch({
      prepare: () => ({ releaseSnapshot: revision }),
      execute: async () => {
        if (++calls === 1) {
          await new Promise<void>(resolve => setImmediate(resolve));
          revision = change;
          return { rows: ["stale-body-canary"], facets: ["stale-facet-canary"] };
        }
        return { rows: ["current"], facets: ["current"] };
      },
    });
    assert.equal(calls, 2);
    assert.deepEqual(released.result, { rows: ["current"], facets: ["current"] });
  });
}

test("continuous snapshot churn fails closed after two executions", async () => {
  let revision = 0;
  await assert.rejects(executeRevalidatedSearch({
    prepare: () => ({ releaseSnapshot: String(revision) }),
    execute: async () => { revision++; return "never release"; },
  }), (error: unknown) => error instanceof SearchQueryError && error.code === "search_changed");
  assert.equal(revision, 2);
});

test("worker-side snapshot mismatch retries once; other failures never retry", async () => {
  for (const code of ["search_changed", "search_timeout", "search_unavailable"] as const) {
    let calls = 0;
    const work = executeRevalidatedSearch({ prepare: () => ({ releaseSnapshot: "same" }),
      execute: async () => { if (++calls === 1) throw new SearchQueryError(code); return "current"; } });
    if (code === "search_changed") {
      assert.equal((await work).result, "current");
      assert.equal(calls, 2);
    } else {
      await assert.rejects(work, (error: unknown) => error instanceof SearchQueryError && error.code === code);
      assert.equal(calls, 1);
    }
  }
});

test("abort or shutdown between execution and release prevents another prepare", async () => {
  for (const shutdown of [false, true]) {
    const controller = new AbortController();
    let stopped = false;
    let prepares = 0;
    await assert.rejects(executeRevalidatedSearch({
      prepare: () => { prepares++; return { releaseSnapshot: "same" }; },
      execute: async () => { if (shutdown) stopped = true; else controller.abort(); return "never release"; },
      guard: () => { if (stopped) throw new SearchQueryError("search_stopped"); },
      signal: controller.signal,
    }), (error: unknown) => error instanceof SearchQueryError && error.code === (shutdown ? "search_stopped" : "search_cancelled"));
    assert.equal(prepares, 1, "shutdown must not reopen the DB during release validation");
  }
});
