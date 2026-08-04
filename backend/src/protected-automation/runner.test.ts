import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { close, init } from "../db.js";
import { runProtectedAutomation } from "./runner.js";
import { captureProtectedAutomationSnapshot } from "./snapshots.js";
import type { ProtectedAutomationJobRow, ProtectedAutomationRunRow } from "./types.js";

let root = "";

function productionRunnerSkipReason(): string | false {
  if (process.platform !== "linux") return "Linux-only runner";
  try { fs.accessSync("/usr/bin/bwrap", fs.constants.X_OK); }
  catch { return "production runner integration requires executable /usr/bin/bwrap"; }
  return false;
}

beforeEach(() => {
  close();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-production-bwrap-"));
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  init();
});

afterEach(() => {
  close();
  delete process.env.WAYANG_DATA_DIR;
  const unlock = (target: string): void => {
    let metadata: fs.Stats;
    try { metadata = fs.lstatSync(target); } catch { return; }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    try { fs.chmodSync(target, 0o700); } catch { return; }
    for (const name of fs.readdirSync(target)) unlock(path.join(target, name));
  };
  unlock(root);
  fs.rmSync(root, { recursive: true, force: true });
});

test("production runner executes the exact snapshot with only reviewed roots and environment", {
  skip: productionRunnerSkipReason(),
  timeout: 30_000,
}, async () => {
  const projectRoot = path.join(root, "project");
  const sourceRoot = path.join(projectRoot, "source");
  const runRoot = path.join(root, "run");
  const stateRoot = path.join(root, "state");
  for (const directory of [sourceRoot, runRoot, stateRoot]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "main.mjs"), [
    "import fs from 'node:fs';",
    "const keys = Object.keys(process.env).sort();",
    "fs.writeFileSync(process.env.WAYANG_AUTOMATION_RUN_DIR + '/result.txt', 'run\\n');",
    "fs.writeFileSync(process.env.WAYANG_AUTOMATION_STATE_DIR + '/result.txt', 'state\\n');",
    "fs.writeFileSync(process.env.WAYANG_AUTOMATION_PROJECT_DIR + '/result.txt', 'project\\n');",
    "console.log(JSON.stringify({ keys, argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }));",
  ].join("\n"));
  const snapshot = captureProtectedAutomationSnapshot({
    projectRoot,
    projectId: "synthetic-project",
    agentProfileId: "synthetic-profile",
    jobId: "synthetic-job",
    revision: 1,
    sourceDirectory: "source",
    entrypoint: "main.mjs",
  });
  const job: ProtectedAutomationJobRow = {
    id: "synthetic-job", project_id: "synthetic-project", agent_profile_id: "synthetic-profile",
    capability_revision: 1, revision: 1, source_revision: 1, name: "Synthetic production run",
    source_manifest_sha256: snapshot.manifestSha256, entrypoint: "main.mjs", argv: ["argument"],
    uses_browser_profile: false, allowed_https_origins: [], cron_expr: "* * * * *", timezone: "local",
    timeout_ms: 5_000, overlap_policy: "skip", missed_run_policy: "skip", enabled: true,
    blocked_reason: null, deleted_at: null, created_at: 1, updated_at: 1, schedule_cursor_at: 1,
    last_occurrence_key: null, last_run_at: null, next_run_at: null,
  };
  const run: ProtectedAutomationRunRow = {
    id: "synthetic-run", job_id: job.id, project_id: job.project_id, agent_profile_id: job.agent_profile_id,
    job_revision: 1, capability_revision: 1, trigger: "manual", scheduled_for: null, occurrence_key: null,
    started_at: 2, finished_at: null, status: "running", outcome_code: null, exit_code: null,
  };
  let authorityChecks = 0;
  const result = await runProtectedAutomation({ job, run, projectRoot }, {
    runRoot,
    stateRoot,
    assertAuthorized: () => { authorityChecks += 1; },
  });
  assert.equal(result.status, "completed", result.stderr.toString("utf8"));
  assert.equal(result.exitCode, 0);
  assert.ok(authorityChecks >= 2);
  const output = JSON.parse(result.stdout.toString("utf8")) as { keys: string[]; argv: string[]; env: Record<string, string>; cwd: string };
  assert.deepEqual(output.argv, ["argument"]);
  assert.ok(output.keys.every((key) => [
    "HOME", "LANG", "PATH", "PWD", "WAYANG_AUTOMATION_PROJECT_DIR", "WAYANG_AUTOMATION_RUN_DIR", "WAYANG_AUTOMATION_STATE_DIR",
  ].includes(key)));
  assert.equal(output.cwd, "/workspace");
  assert.equal(output.env.WAYANG_AUTOMATION_PROJECT_DIR, "/workspace");
  assert.equal(output.env.WAYANG_AUTOMATION_RUN_DIR, "/run/wayang-automation/run");
  assert.equal(output.env.WAYANG_AUTOMATION_STATE_DIR, "/run/wayang-automation/state");
  assert.equal("WAYANG_AUTOMATION_RPC_FD" in output.env, false);
  assert.equal(fs.readFileSync(path.join(runRoot, "result.txt"), "utf8"), "run\n");
  assert.equal(fs.readFileSync(path.join(stateRoot, "result.txt"), "utf8"), "state\n");
  assert.equal(fs.readFileSync(path.join(projectRoot, "result.txt"), "utf8"), "project\n");

  const browserResult = await runProtectedAutomation({ job: { ...job, uses_browser_profile: true }, run, projectRoot }, {
    runRoot,
    stateRoot,
    browserPort: { async request() { throw new Error("script must not issue browser RPC"); } },
    assertAuthorized: () => undefined,
  });
  assert.equal(browserResult.status, "completed", browserResult.stderr.toString("utf8"));
  const browserOutput = JSON.parse(browserResult.stdout.toString("utf8")) as { env: Record<string, string> };
  assert.equal(browserOutput.env.WAYANG_AUTOMATION_RPC_FD, "3");

  const unavailable = await runProtectedAutomation({ job: { ...job, uses_browser_profile: true }, run, projectRoot }, {    runRoot,
    stateRoot,
    assertAuthorized: () => { throw new Error("browser-unavailable must fail before spawn"); },
  });
  assert.equal(unavailable.status, "failed");
  assert.equal(unavailable.outcomeCode, "browser_unavailable");
});
