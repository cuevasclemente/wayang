import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAgentProfile, updateAgentProfile } from "./agent-profiles.js";
import { close, init } from "./db.js";
import { getPiSessionBrowserAgentDiagnostic } from "./pi-bridge.js";
import { createProject, updateProject } from "./projects.js";
import { createSession } from "./sessions.js";
import { commitWorkspaceCapabilityActivation, revokeWorkspaceCapabilityAssociation } from "./workspace-capabilities.js";

let root = "";
let projectRoot = "";
let previousDataDir: string | undefined;
let previousChromiumPath: string | undefined;

beforeEach(() => {
  close();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-browser-diagnostic-"));
  projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  previousDataDir = process.env.WAYANG_DATA_DIR;
  previousChromiumPath = process.env.WAYANG_CHROMIUM_PATH;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  delete process.env.WAYANG_CHROMIUM_PATH;
  init();
});

afterEach(() => {
  close();
  if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
  else process.env.WAYANG_DATA_DIR = previousDataDir;
  if (previousChromiumPath === undefined) delete process.env.WAYANG_CHROMIUM_PATH;
  else process.env.WAYANG_CHROMIUM_PATH = previousChromiumPath;
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const defaultProfile = createAgentProfile({ name: "Diagnostic project default", resource_mode: "project_only" });
  const profile = createAgentProfile({ name: "Diagnostic profile", resource_mode: "project_only" });
  const project = createProject({
    cwd: projectRoot,
    default_agent_profile_id: defaultProfile.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [defaultProfile.id, profile.id] },
  });
  const session = createSession(projectRoot, { agentProfileId: profile.id });
  return { defaultProfile, profile, project, session };
}

test("diagnostics distinguish approval, fresh-runtime, configured-path, and revocation states without paths", () => {
  const f = fixture();
  let diagnostic = getPiSessionBrowserAgentDiagnostic(f.session.id);
  assert.equal(diagnostic.reason_code, "approval_required");
  assert.equal(JSON.stringify(diagnostic).includes(projectRoot), false);

  const association = commitWorkspaceCapabilityActivation({
    capability_id: "wayang.standard-browser.v1",
    project_id: f.project.id,
    agent_profile_id: f.profile.id,
    operation_digest: "a".repeat(64),
  });
  diagnostic = getPiSessionBrowserAgentDiagnostic(f.session.id);
  assert.equal(diagnostic.reason_code, "fresh_runtime_required");
  assert.equal(diagnostic.tool_state, "stale_runtime");

  process.env.WAYANG_CHROMIUM_PATH = "relative/chromium";
  diagnostic = getPiSessionBrowserAgentDiagnostic(f.session.id);
  assert.equal(diagnostic.executable.state, "invalid_configured_path");
  assert.equal(JSON.stringify(diagnostic).includes("relative/chromium"), false);

  revokeWorkspaceCapabilityAssociation({
    capability_id: "wayang.standard-browser.v1",
    project_id: f.project.id,
    agent_profile_id: f.profile.id,
    expected_revision: association.revision,
  });
  assert.equal(getPiSessionBrowserAgentDiagnostic(f.session.id).reason_code, "association_inactive");
});

test("diagnostics distinguish disabled, disallowed, scheduled, and privacy-compatible capability IDs", () => {
  const f = fixture();
  commitWorkspaceCapabilityActivation({
    capability_id: "wayang.standard-browser.v1",
    project_id: f.project.id,
    agent_profile_id: f.profile.id,
    operation_digest: "b".repeat(64),
  });
  const scheduled = createSession(projectRoot, { agentProfileId: f.profile.id, scheduledJobId: "job", scheduledRunId: "run" });
  assert.equal(getPiSessionBrowserAgentDiagnostic(scheduled.id).reason_code, "interactive_session_required");

  updateAgentProfile(f.profile.id, { enabled: false });
  assert.equal(getPiSessionBrowserAgentDiagnostic(f.session.id).reason_code, "profile_disabled");
  updateAgentProfile(f.profile.id, { enabled: true });

  updateProject(f.project.id, { access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [f.defaultProfile.id] } });
  assert.equal(getPiSessionBrowserAgentDiagnostic(f.session.id).reason_code, "profile_not_allowed");

  updateProject(f.project.id, { access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [f.defaultProfile.id, f.profile.id] } });
  const protectedDiagnostic = getPiSessionBrowserAgentDiagnostic(f.session.id);
  assert.equal(protectedDiagnostic.capability_id, "wayang.protected-browser.v1");
  assert.equal(protectedDiagnostic.reason_code, "approval_required");
});
