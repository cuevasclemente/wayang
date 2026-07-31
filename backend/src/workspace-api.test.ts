import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { close, init } from "./db.js";
import { router as projectsRouter } from "./routes/projects.js";
import { router as agentProfilesRouter } from "./routes/agent-profiles.js";

test("project and agent profile CRUD APIs validate and redact list responses", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-workspace-api-"));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  init();

  const app = express();
  app.use(express.json());
  app.use("/api", projectsRouter);
  app.use("/api", agentProfilesRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const agentResponse = await fetch(`${base}/agent-profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Finance",
      instructions: "detail-only private instructions",
      memory_access: "read",
      default_provider: "anthropic",
      default_model: "finance-model",
    }),
  });
  assert.equal(agentResponse.status, 201);
  const finance = await agentResponse.json() as { id: string; instructions: string };
  assert.equal(finance.instructions, "detail-only private instructions");

  const listResponse = await fetch(`${base}/agent-profiles`);
  const list = await listResponse.json() as Array<Record<string, unknown>>;
  assert.equal(listResponse.status, 200);
  assert.equal(list.some((profile) => Object.hasOwn(profile, "instructions")), false);
  const detail = await (await fetch(`${base}/agent-profiles/${finance.id}`)).json() as { instructions: string };
  assert.equal(detail.instructions, "detail-only private instructions");

  const invalidPair = await fetch(`${base}/agent-profiles/${finance.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ default_model: null }),
  });
  assert.equal(invalidPair.status, 400);

  const projectResponse = await fetch(`${base}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd,
      name: "Private finance",
      default_agent_profile_id: finance.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [finance.id] },
    }),
  });
  assert.equal(projectResponse.status, 201);
  const project = await projectResponse.json() as { id: string; cwd: string };
  assert.equal(project.cwd, fs.realpathSync.native(cwd));

  const immutable = await fetch(`${base}/projects/${project.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: path.join(dir, "other") }),
  });
  assert.equal(immutable.status, 409);

  const invalidProtected = await fetch(`${base}/projects/${project.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [] } }),
  });
  assert.equal(invalidProtected.status, 400);

  const createdInstructions = await fetch(`${base}/projects/${project.id}/instructions`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "# Project instructions\n", create_if_missing: true }),
  });
  assert.equal(createdInstructions.status, 200);
  const instructionBody = await createdInstructions.json() as { exists: boolean; sha256: string; path: string };
  assert.equal(instructionBody.exists, true);
  assert.equal(instructionBody.path, path.join(cwd, "AGENTS.md"));

  const stale = await fetch(`${base}/projects/${project.id}/instructions`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "overwrite", expected_sha256: "0".repeat(64) }),
  });
  assert.equal(stale.status, 412);

  const deleteInUse = await fetch(`${base}/agent-profiles/${finance.id}`, { method: "DELETE" });
  assert.equal(deleteInUse.status, 409);
});
