import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { createAgentProfile } from "./agent-profiles.js";
import { AuthService } from "./auth/service.js";
import type { AuthConfig } from "./config.js";
import { close, getStore, init } from "./db.js";
import { createProject } from "./projects.js";
import { CapabilityApprovalError } from "./workspace-capability-approval/errors.js";
import { createProductionWorkspaceCapabilityBootstrap } from "./workspace-capability-bootstrap.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-production-capability-bootstrap-"));
const dataDir = path.join(root, "data");
const projectRoot = path.join(root, "project");
const previousDataDir = process.env.WAYANG_DATA_DIR;
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const legacyKeys = ["WAYANG_WREN_HOST_EXECUTION", "WAYANG_FINANCE_BROWSER_AUTHORITY"] as const;
const previousLegacy = new Map(legacyKeys.map((key) => [key, process.env[key]]));
fs.mkdirSync(projectRoot, { recursive: true });
process.env.WAYANG_DATA_DIR = dataDir;
process.env.XDG_CONFIG_HOME = path.join(root, "missing-config");
for (const key of legacyKeys) process.env[key] = "1";
init();

const authConfig: AuthConfig = {
  enabled: false,
  passwordHash: "",
  sessionSecret: "synthetic-session-secret-with-at-least-32-bytes",
  sessionDays: 1,
  sessionStorePath: path.join(dataDir, "auth-sessions.json"),
  trustProxy: false,
  proxyIdentityHeader: "",
  cookieSecure: "never",
  allowedOrigins: ["http://127.0.0.1:8787"],
};
const auth = new AuthService(authConfig);
const bootstrap = createProductionWorkspaceCapabilityBootstrap(auth, { dataDir });
const profile = createAgentProfile({ name: "Wren", resource_mode: "standard" });
const project = createProject({
  cwd: projectRoot,
  name: "Finance",
  default_agent_profile_id: profile.id,
  access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] },
});

after(async () => {
  await bootstrap.close();
  close();
  if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
  else process.env.WAYANG_DATA_DIR = previousDataDir;
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  for (const key of legacyKeys) {
    const previous = previousLegacy.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("production bootstrap performs no startup activation and ignores profile names and legacy authority flags", () => {
  assert.equal(getStore().workspaceCapabilityAssociations.length, 0);
  assert.equal(getStore().workspaceCapabilityApprovalEvents.length, 0);
});

test("missing PIN and cooldown state remain unavailable and are never provisioned by bootstrap", async () => {
  const cooldownPath = path.join(dataDir, "workspace-capability-approval", "pin-attempt-state.json");
  await assert.rejects(
    bootstrap.routerOptions.service.requestActivation(
      { sessionId: "synthetic-owner", origin: "http://127.0.0.1:8787" },
      {
        capabilityId: "wayang.host-execution.v1",
        projectId: project.id,
        agentProfileId: profile.id,
      },
    ),
    (error: unknown) => error instanceof CapabilityApprovalError && error.code === "pin_unavailable" && error.statusCode === 503,
  );
  assert.equal(fs.existsSync(cooldownPath), false);
  assert.equal(getStore().workspaceCapabilityAssociations.length, 0);
  assert.equal(getStore().workspaceCapabilityApprovalEvents.length, 0);
});
