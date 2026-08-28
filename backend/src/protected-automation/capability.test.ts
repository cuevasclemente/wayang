import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAgentProfile } from "../agent-profiles.js";
import { close } from "../db.js";
import { createProject } from "../projects.js";
import {
  WORKSPACE_CAPABILITY_REGISTRY,
  commitWorkspaceCapabilityActivation,
  resolveWorkspaceCapability,
} from "../workspace-capabilities.js";
import {
  capabilityCatalog,
  compiledCapability,
} from "../workspace-capability-approval/catalog.js";

const CAPABILITY_ID = "wayang.protected-automation.v1" as const;
let temporaryPaths: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

beforeEach(() => {
  close();
  temporaryPaths = [];
  process.env.WAYANG_DATA_DIR = temporaryDirectory("wayang-protected-automation-capability-");
});

afterEach(() => {
  close();
  delete process.env.WAYANG_DATA_DIR;
  for (const target of temporaryPaths) fs.rmSync(target, { recursive: true, force: true });
  temporaryPaths = [];
});

test("protected automation is a Protected-only compiled capability with candid consequences", () => {
  assert.deepEqual(WORKSPACE_CAPABILITY_REGISTRY[CAPABILITY_ID], {
    id: CAPABILITY_ID,
    privacy_mode: "protected",
    risk: "protected-automation",
  });

  const capability = compiledCapability(CAPABILITY_ID);
  assert.equal(capability.compatiblePrivacyMode, "protected");
  assert.equal(capability.activationAvailable, true);
  assert.equal(capability.title, "Protected automation");
  assert.equal(capabilityCatalog().some((entry) => entry.id === CAPABILITY_ID), true);
  const consequences = capability.consequences.join("\n");
  assert.match(consequences, /without a shell/u);
  assert.match(consequences, /throughout the exact Protected project/u);
  assert.match(consequences, /no generic TCP, UDP, or Unix-socket network access/u);
  assert.match(consequences, /authenticated browser state/iu);
  assert.match(consequences, /configured HTTPS origins/u);
  assert.match(consequences, /secret-bearing steps remain human-only/u);
  assert.match(consequences, /same-UID processes/u);
});

test("protected automation authority remains an exact pair and ignores provider or model", () => {
  const owner = createAgentProfile({ name: "Automation owner", resource_mode: "project_only" });
  const otherProfile = createAgentProfile({ name: "Other profile", resource_mode: "project_only" });
  const project = createProject({
    cwd: temporaryDirectory("wayang-protected-automation-project-"),
    name: "Protected automation project",
    default_agent_profile_id: owner.id,
    access_policy: {
      privacy_mode: "protected",
      allowed_agent_profile_ids: [owner.id, otherProfile.id],
    },
  });
  const otherProject = createProject({
    cwd: temporaryDirectory("wayang-protected-automation-other-project-"),
    name: "Other protected project",
    default_agent_profile_id: owner.id,
    access_policy: {
      privacy_mode: "protected",
      allowed_agent_profile_ids: [owner.id],
    },
  });
  const input = {
    capability_id: CAPABILITY_ID,
    project_id: project.id,
    agent_profile_id: owner.id,
  };

  commitWorkspaceCapabilityActivation({
    ...input,
    operation_digest: "a".repeat(64),
    approved_at: 10,
  });

  assert.equal(resolveWorkspaceCapability(input).authorized, true);
  assert.equal(resolveWorkspaceCapability({
    ...input,
    provider: "fluid-provider",
    model: "fluid-model",
  } as never).authorized, true);
  assert.equal(resolveWorkspaceCapability({
    ...input,
    agent_profile_id: otherProfile.id,
  }).authorized, true, "every enabled allowlisted profile derives authority");
  assert.equal(resolveWorkspaceCapability({
    ...input,
    project_id: otherProject.id,
  }).authorized, true, "authority follows each Protected project's RBAC");

  const standardProject = createProject({
    cwd: temporaryDirectory("wayang-protected-automation-standard-project-"),
    name: "Standard project",
    default_agent_profile_id: owner.id,
    access_policy: {
      privacy_mode: "standard",
      allowed_agent_profile_ids: [owner.id],
    },
  });
  assert.throws(() => commitWorkspaceCapabilityActivation({
    capability_id: CAPABILITY_ID,
    project_id: standardProject.id,
    agent_profile_id: owner.id,
    operation_digest: "b".repeat(64),
    approved_at: 20,
  }), /incompatible with project privacy mode/u);
});
