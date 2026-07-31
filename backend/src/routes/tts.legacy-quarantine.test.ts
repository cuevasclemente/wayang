import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import express from "express";
import { createAgentProfile, updateAgentProfile } from "../agent-profiles.js";
import { close as closeStore, getStore } from "../db.js";
import { createProject, updateProject } from "../projects.js";
import { getTtsCacheDir } from "../tts-cache.js";
import { router } from "./tts.js";

function postJson(server: http.Server, pathname: string, body: unknown): Promise<{ status: number; body: any }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server is not listening");
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: address.port,
      path: pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("stopped quarantined legacy private sessions deny TTS before history, broker, and cache work", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-quarantine-tts-route-"));
  const dataDir = path.join(root, "data");
  const projectCwd = path.join(root, "standard-project");
  const sessionFile = path.join(root, "stopped-session.jsonl");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.writeFileSync(sessionFile, [
    { type: "session", version: 3, id: "quarantined-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectCwd },
    { type: "message", id: "assistant-message", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Synthetic assistant text." }], timestamp: 1_767_225_601_000 } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const previous = {
    dataDir: process.env.WAYANG_DATA_DIR,
    brokerUrl: process.env.WAYANG_TTS_BROKER_URL,
    baseUrl: process.env.WAYANG_TTS_BASE_URL,
    fetch: globalThis.fetch,
  };
  process.env.WAYANG_DATA_DIR = dataDir;
  process.env.WAYANG_TTS_BROKER_URL = "http://tts-broker.invalid";
  delete process.env.WAYANG_TTS_BASE_URL;

  let brokerCalls = 0;
  globalThis.fetch = async () => {
    brokerCalls += 1;
    return new Response(JSON.stringify({
      job_id: "01234567-89ab-cdef-0123-456789abcdef",
      status: "queued",
      manifest_url: "/v1/tts/jobs/01234567-89ab-cdef-0123-456789abcdef/manifest",
      events_url: "/v1/tts/jobs/01234567-89ab-cdef-0123-456789abcdef/events",
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  };

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  const server = http.createServer(app);

  t.after(async () => {
    await closeServer(server);
    closeStore();
    globalThis.fetch = previous.fetch;
    if (previous.dataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous.dataDir;
    if (previous.brokerUrl === undefined) delete process.env.WAYANG_TTS_BROKER_URL;
    else process.env.WAYANG_TTS_BROKER_URL = previous.brokerUrl;
    if (previous.baseUrl === undefined) delete process.env.WAYANG_TTS_BASE_URL;
    else process.env.WAYANG_TTS_BASE_URL = previous.baseUrl;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const standardProfile = createAgentProfile({
    name: "Standard TTS profile",
    description: "Generic standard profile for TTS policy fixtures",
    default_provider: "openai-codex",
    default_model: "gpt-5.6-sol",
  });
  const alternateProfile = createAgentProfile({ name: "Alternate standard TTS profile" });
  const project = createProject({
    cwd: projectCwd,
    name: "Standard TTS project",
    default_agent_profile_id: standardProfile.id,
    default_provider: "openai-codex",
    default_model: "gpt-5.6-sol",
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [standardProfile.id] },
  });
  const now = Date.now();
  const store = getStore();
  store.sessions.push({
    id: "quarantined-session",
    pi_session_file: sessionFile,
    title: "Stopped legacy private fixture",
    cwd: project.cwd,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    agent_profile_id: standardProfile.id,
    pending_agent_switch: null,
    legacy_private_session_quarantine: true,
    legacy_capability_ineligible: true,
    created_at: now,
    last_active: now,
    archived: 0,
    archived_at: null,
    goal: null,
    goal_status: null,
    scheduled_job_id: null,
    scheduled_run_id: null,
    error: null,
  });

  await listen(server);
  const denied = await postJson(server, "/api/tts/synthesize", {
    sessionId: "quarantined-session",
    messageId: "assistant-message",
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body, { error: "Read aloud is unavailable for quarantined legacy sessions" });
  assert.equal(brokerCalls, 0, "quarantine denial must happen before any broker fetch");
  assert.equal(fs.existsSync(getTtsCacheDir()), false, "quarantine denial must not create the TTS cache directory or a cache file");

  // The durable marker remains authoritative across project and profile drift.
  updateProject(project.id, {
    access_policy: {
      privacy_mode: "protected",
      allowed_agent_profile_ids: [standardProfile.id],
    },
  });
  updateAgentProfile(standardProfile.id, { name: "Renamed standard TTS profile" });
  store.sessions[store.sessions.length - 1]!.agent_profile_id = alternateProfile.id;
  const driftDenied = await postJson(server, "/api/tts/synthesize", {
    sessionId: "quarantined-session",
    messageId: "assistant-message",
  });
  assert.equal(driftDenied.status, 403);
  assert.equal(brokerCalls, 0);

  // A standard exact-false session keeps the existing TTS behavior, including
  // the pre-existing behavior of its now-Protected project.
  store.sessions.push({
    ...store.sessions[store.sessions.length - 1]!,
    id: "standard-session",
    title: "Standard synthetic fixture",
    legacy_private_session_quarantine: false,
    legacy_capability_ineligible: false,
  });
  const allowed = await postJson(server, "/api/tts/synthesize", {
    sessionId: "standard-session",
    messageId: "assistant-message",
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.status, "queued");
  assert.equal(brokerCalls, 1);
});
