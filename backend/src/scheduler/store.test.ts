import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { close, init } from "../db.js";
import {
  createScheduledJob,
  createScheduledRun,
  getScheduledJob,
  hasRunningRun,
  listScheduledJobs,
  listScheduledRuns,
  markStaleScheduledRunsFailed,
  updateScheduledJob,
  updateScheduledRun,
} from "./store.js";

test("scheduled job store supports CRUD metadata and run recovery", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-scheduler-test-"));
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    const job = createScheduledJob({
      name: "Daily summary",
      cron_expr: "0 9 * * *",
      prompt: "summarize",
      cwd: "/tmp",
      command_guard_mode: "off",
      enabled: true,
    });

    assert.equal(listScheduledJobs().length, 1);
    assert.equal(getScheduledJob(job.id)?.name, "Daily summary");
    assert.equal(getScheduledJob(job.id)?.command_guard_mode, "off");
    assert.ok(getScheduledJob(job.id)?.next_run_at);

    const updated = updateScheduledJob(job.id, { enabled: false, name: "Disabled summary", command_guard_mode: "balanced" });
    assert.equal(updated?.enabled, false);
    assert.equal(updated?.command_guard_mode, "balanced");
    assert.equal(updated?.next_run_at, null);

    const run = createScheduledRun({ jobId: job.id, trigger: "manual", scheduledFor: null });
    assert.equal(hasRunningRun(job.id), true);
    assert.equal(listScheduledRuns(job.id).length, 1);

    updateScheduledRun(run.id, { status: "completed", finished_at: Date.now(), result_summary: "ok" });
    assert.equal(hasRunningRun(job.id), false);

    createScheduledRun({ jobId: job.id, trigger: "schedule", scheduledFor: Date.now() });
    assert.equal(markStaleScheduledRunsFailed("restart"), 1);
    const latest = listScheduledRuns(job.id)[0];
    assert.equal(latest.status, "failed");
    assert.equal(latest.error_message, "restart");
  } finally {
    close();
    if (previousDataDir === undefined) {
      delete process.env.WAYANG_DATA_DIR;
    } else {
      process.env.WAYANG_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
