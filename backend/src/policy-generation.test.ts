import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { close, getStore, init } from "./db.js";
import { getPolicyGeneration, onPolicyChanged } from "./policy-generation.js";
import { createProject, getProject } from "./projects.js";

test("sync/async rejecting policy listeners cannot fail durable notify or refresh, block later listeners, or become unhandled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-policy-listener-isolation-"));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const previousData = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(dir, "data");
  let observed = 0;
  let unhandledRejections = 0;
  const onUnhandledRejection = () => { unhandledRejections += 1; };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    init();
    getPolicyGeneration();
    const removeThrowing = onPolicyChanged(() => { throw new Error("synthetic listener failure"); });
    const removeAsyncRejecting = onPolicyChanged(async () => { throw new Error("synthetic async listener failure"); });
    const removeObserver = onPolicyChanged(() => { observed += 1; });
    try {
      const project = createProject({ cwd });
      assert.ok(getProject(project.id), "project remains published after throwing notify listener");
      assert.equal(observed, 1, "later listener runs after sync and async rejecting listeners");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(unhandledRejections, 0, "async listener rejection is handled internally");

      const stored = getStore().projects.find((candidate) => candidate.id === project.id)!;
      stored.default_provider = "synthetic-provider";
      stored.default_model = "synthetic-model";
      assert.doesNotThrow(() => getPolicyGeneration(), "refresh emission is isolated too");
      assert.equal(observed, 2);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(unhandledRejections, 0);
    } finally {
      removeThrowing();
      removeAsyncRejecting();
      removeObserver();
    }
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    close();
    if (previousData === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousData;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
