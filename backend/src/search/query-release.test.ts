import test from "node:test";
import assert from "node:assert/strict";
import { executeRevalidatedSearch, type SynchronousSearchRelease } from "./query-release.js";
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
  let released = 0;
  await assert.rejects(executeRevalidatedSearch({
    prepare: () => ({ releaseSnapshot: String(revision) }),
    execute: async () => { revision++; return "never release"; },
    release: () => { released++; },
  }), (error: unknown) => error instanceof SearchQueryError && error.code === "search_changed");
  assert.equal(revision, 2);
  assert.equal(released, 0);
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

test("transport release runs before revocation queued in final prepare", async () => {
  const events: string[] = [];
  let prepares = 0;
  let revoked = false;
  await executeRevalidatedSearch({
    prepare: () => {
      if (++prepares === 2) queueMicrotask(() => { revoked = true; events.push("revoked"); });
      return { releaseSnapshot: "authorized" };
    },
    execute: async () => "authorized result",
    release: (_prepared, result) => {
      assert.equal(revoked, false);
      assert.equal(result, "authorized result");
      events.push("released");
    },
  });
  assert.deepEqual(events, ["released", "revoked"]);
  assert.equal(revoked, true, "an awaited return value is no longer release-authorized");
});

test("revocation before final prepare prevents the transport callback", async () => {
  let revoked = false;
  let released = 0;
  await assert.rejects(executeRevalidatedSearch({
    prepare: () => {
      if (revoked) throw new SearchQueryError("search_changed");
      return { releaseSnapshot: "authorized" };
    },
    execute: async () => { queueMicrotask(() => { revoked = true; }); return "stale result"; },
    release: () => { released++; },
  }), (error: unknown) => error instanceof SearchQueryError && error.code === "search_changed");
  assert.equal(released, 0);
});

test("changed final snapshot retries without releasing the rejected response", async () => {
  let snapshot = "before";
  let executions = 0;
  const sent: string[] = [];
  await executeRevalidatedSearch({
    prepare: () => ({ releaseSnapshot: snapshot }),
    execute: async () => {
      if (++executions === 1) { snapshot = "after"; return "stale body/facets"; }
      return "fresh body/facets";
    },
    release: (_prepared, result) => { sent.push(result); },
  });
  assert.equal(executions, 2);
  assert.deepEqual(sent, ["fresh body/facets"]);
});

test("transport callback errors are not caught as query retries or duplicate sends", async () => {
  let executions = 0;
  let releases = 0;
  const transportFailure = new SearchQueryError("search_changed");
  await assert.rejects(executeRevalidatedSearch({
    prepare: () => ({ releaseSnapshot: "same" }),
    execute: async () => { executions++; return "result"; },
    release: () => { releases++; throw transportFailure; },
  }), (error: unknown) => error === transportFailure);
  assert.equal(executions, 1);
  assert.equal(releases, 1);
});

test("async callbacks are rejected before execution, including from untyped callers", async () => {
  let executions = 0;
  let releases = 0;
  await assert.rejects(executeRevalidatedSearch({
    prepare: () => ({ releaseSnapshot: "same" }),
    execute: async () => { executions++; return "result"; },
    // @ts-expect-error Promise-returning transport callbacks are forbidden.
    release: async () => { releases++; },
  }), TypeError);
  assert.equal(executions, 0);
  assert.equal(releases, 0);
});

test("untyped non-void callback results fail without awaiting or retrying", async () => {
  let executions = 0;
  let releases = 0;
  const callback = (() => { releases++; return Promise.resolve(); }) as unknown as SynchronousSearchRelease<[{ releaseSnapshot: string }, string]>;
  await assert.rejects(executeRevalidatedSearch({
    prepare: () => ({ releaseSnapshot: "same" }),
    execute: async () => { executions++; return "result"; },
    release: callback,
  }), TypeError);
  assert.equal(executions, 1);
  assert.equal(releases, 1);
});
