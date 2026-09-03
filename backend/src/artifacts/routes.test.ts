import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAgentProfile } from "../agent-profiles.js";
import { closeWayangServer, createApp } from "../app.js";
import { AuthService } from "../auth/service.js";
import { getConfig } from "../config.js";
import { close, init } from "../db.js";
import { createProject } from "../projects.js";
import { createSession } from "../sessions.js";
import { closeArtifactRegistry, initArtifactRegistry } from "./registry.js";
import { presentArtifacts } from "./service.js";

let root = "";
let projectRoot = "";
let sessionId = "";
let server: http.Server | null = null;
let origin = "";
let oldHome: string | undefined;
let oldDataDir: string | undefined;
let oldStandardBrowserProfiles: string | undefined;

async function availablePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

beforeEach(async () => {
  closeArtifactRegistry();
  close();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-artifact-routes-"));
  projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  oldHome = process.env.HOME;
  oldDataDir = process.env.WAYANG_DATA_DIR;
  oldStandardBrowserProfiles = process.env.WAYANG_STANDARD_BROWSER_PROFILE_HOSTS;
  process.env.HOME = root;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  delete process.env.WAYANG_STANDARD_BROWSER_PROFILE_HOSTS;
  init();
  const profile = createAgentProfile({ name: "Artifact route fixture", resource_mode: "project_only" });
  createProject({
    cwd: projectRoot,
    default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] },
  });
  sessionId = createSession(projectRoot, { agentProfileId: profile.id }).id;
  initArtifactRegistry(process.env.WAYANG_DATA_DIR);
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  const auth = new AuthService({
    ...getConfig().auth,
    enabled: false,
    sessionStorePath: path.join(root, "auth-sessions.json"),
    allowedOrigins: [origin],
  });
  const app = createApp({ config: { dataDir: process.env.WAYANG_DATA_DIR }, authService: auth });
  server = app.server;
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(port, "127.0.0.1", resolve);
  });
});

afterEach(async () => {
  if (server) await closeWayangServer(server);
  server = null;
  closeArtifactRegistry();
  close();
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
  else process.env.WAYANG_DATA_DIR = oldDataDir;
  if (oldStandardBrowserProfiles === undefined) delete process.env.WAYANG_STANDARD_BROWSER_PROFILE_HOSTS;
  else process.env.WAYANG_STANDARD_BROWSER_PROFILE_HOSTS = oldStandardBrowserProfiles;
  fs.rmSync(root, { recursive: true, force: true });
});

test("opaque artifact routes list, preview, download, and reject guessed ids", async () => {
  const report = path.join(projectRoot, "report.md");
  fs.writeFileSync(report, "# Route fixture\n", { mode: 0o600 });
  const [artifact] = presentArtifacts(sessionId, [{ path: report, title: "Route fixture" }]);

  const list = await fetch(`${origin}/api/sessions/${sessionId}/artifacts`, { headers: { origin } });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "private, no-store");
  assert.equal(list.headers.get("x-content-type-options"), "nosniff");
  const catalog = await list.json() as { artifacts: Array<{ id: string }> };
  assert.equal(catalog.artifacts[0].id, artifact.id);
  assert.equal(JSON.stringify(catalog).includes(report), false);

  const preview = await fetch(`${origin}/api/sessions/${sessionId}/artifacts/${artifact.id}/preview`, { headers: { origin } });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json() as { text: string }).text, "# Route fixture\n");

  const download = await fetch(`${origin}/api/sessions/${sessionId}/artifacts/${artifact.id}/download`, { headers: { origin } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/u);
  assert.equal(await download.text(), "# Route fixture\n");

  const guessed = await fetch(`${origin}/api/sessions/${sessionId}/artifacts/00000000-0000-4000-8000-000000000000/preview`, { headers: { origin } });
  assert.equal(guessed.status, 404);
  assert.equal(JSON.stringify(await guessed.json()).includes(projectRoot), false);
});

test("artifact routes enforce Fetch Metadata and retired Files routes return 404", async () => {
  const denied = await fetch(`${origin}/api/sessions/${sessionId}/artifacts`, {
    headers: { origin, "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
  });
  assert.equal(denied.status, 403);

  for (const endpoint of ["tree", "read", "write"]) {
    const response = await fetch(`${origin}/api/fs/${endpoint}`, { headers: { origin } });
    assert.equal(response.status, 404);
  }
  const discovery = await fetch(`${origin}/api/fs/discover-projects`, { headers: { origin } });
  assert.equal(discovery.status, 200);
});
