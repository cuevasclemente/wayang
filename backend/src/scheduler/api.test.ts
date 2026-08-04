import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { createAgentProfile } from "../agent-profiles.js";
import { close, init } from "../db.js";
import { ensureProjectForCwd } from "../projects.js";
import { router } from "../routes/scheduled-agent-jobs.js";

test("scheduled job API persists and clears agent_profile_id", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-scheduler-api-"));
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  init();
  ensureProjectForCwd(dir);
  const scheduledProfile = createAgentProfile({ name: "Scheduler API profile" });

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/scheduled-agent-jobs`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const createdResponse = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Profile-aware job",
      cron_expr: "0 9 * * *",
      prompt: "synthetic prompt",
      cwd: dir,
      agent_profile_id: scheduledProfile.id,
      enabled: false,
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { id: string; agent_profile_id: string | null };
  assert.equal(created.agent_profile_id, scheduledProfile.id);

  const updatedResponse = await fetch(`${base}/${created.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_profile_id: null }),
  });
  assert.equal(updatedResponse.status, 200);
  assert.equal(((await updatedResponse.json()) as { agent_profile_id: string | null }).agent_profile_id, null);

  close();
  init();
  const detailResponse = await fetch(`${base}/${created.id}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json() as { job: { agent_profile_id: string | null } };
  assert.equal(detail.job.agent_profile_id, null);

  const rejected = await fetch(`${base}/${created.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_profile_id: "unknown-profile" }),
  });
  assert.equal(rejected.status, 400);
});
