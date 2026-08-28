import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAgentProfile, updateAgentProfile } from "./agent-profiles.js";
import {
  close,
  failNextCommitStoreMutationPersistenceForTests,
  getStore,
  init,
} from "./db.js";
import { createProject, updateProject } from "./projects.js";
import { capabilityOperationDigest } from "./workspace-capability-approval/renderer.js";
import type {
  AffectedRuntimeStatus,
  CapabilityApprovalBinding,
  WorkspaceCapabilityId,
  WorkspacePrivacyMode,
} from "./workspace-capability-approval/types.js";
import {
  HardenedSettingsPinAttemptAdapter,
  WorkspaceCapabilityIntegration,
  buildWorkspaceCapabilityActivationPreview,
  provisionPinAttemptStateForService,
  syncDirectoryBestEffort,
  type WorkspaceCapabilityRuntimeLifecyclePort,
} from "./workspace-capability-integration.js";

let root = "";
let projectRoot = "";

beforeEach(() => {
  close();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-capability-integration-"));
  projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot);
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  init();
});

afterEach(() => {
  close();
  delete process.env.WAYANG_DATA_DIR;
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

function denial(): WorkspaceCapabilityRuntimeLifecyclePort & { activations: string[]; latched: string[]; cleaned: string[] } {
  return {
    activations: [],
    latched: [],
    cleaned: [],
    latchActivation(input) { this.activations.push(`${input.intent.capabilityId}:${input.runtimeIds.join(",")}`); },
    latchDenied(input) { this.latched.push(`${input.association.capabilityId}:${input.association.revision}`); },
    async cleanupDeniedRuntimeIds(runtimeIds) { this.cleaned.push(...runtimeIds); },
  };
}

function setup() {
  const profile = createAgentProfile({ name: "Arbitrary Standard", resource_mode: "standard" });
  const project = createProject({
    cwd: projectRoot,
    name: "Arbitrary Project",
    default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] },
  });
  return { profile, project, intent: {
    capabilityId: "wayang.host-execution.v1" as const,
    projectId: project.id,
    agentProfileId: profile.id,
  } };
}

function binding(): CapabilityApprovalBinding {
  return {
    requestId: "request-1",
    reservationId: "reservation-1",
    expiresAt: 100_000,
    owner: { sessionId: "owner-session", origin: "https://wayang.test" },
  };
}

async function commit(integration: WorkspaceCapabilityIntegration, intent: ReturnType<typeof setup>["intent"], approvedAt = 10) {
  const preview = await integration.previewActivation(intent);
  assert.equal(preview.status, "ok");
  if (preview.status !== "ok") throw new Error("preview failed");
  const approvalBinding = binding();
  const approvalDigest = capabilityOperationDigest(preview.preview, approvalBinding);
  return integration.commitActivation({ preview: preview.preview, approvalBinding, approvalDigest, approvedAt });
}

test("atomic activation advances sole association and appends PIN digest audit event", async () => {
  const integration = new WorkspaceCapabilityIntegration(denial());
  const { intent } = setup();
  const preview = await integration.previewActivation(intent);
  assert.equal(preview.status, "ok");
  if (preview.status !== "ok") return;
  const approvalBinding = binding();
  const approvalDigest = capabilityOperationDigest(preview.preview, approvalBinding);
  const forgedDigest = `${approvalDigest[0] === "a" ? "b" : "a"}${approvalDigest.slice(1)}`;
  assert.deepEqual(
    await integration.commitActivation({ preview: preview.preview, approvalBinding, approvalDigest: forgedDigest, approvedAt: 10 }),
    { status: "denied", reason: "invalid_approval_digest" },
  );
  assert.equal(getStore().workspaceCapabilityAssociations.length, 0);
  const result = await integration.commitActivation({ preview: preview.preview, approvalBinding, approvalDigest, approvedAt: 10 });
  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;
  assert.equal(result.result.association.revision, 1);
  assert.equal(result.result.approvalEvent.operationDigest, approvalDigest);
  assert.equal(getStore().workspaceCapabilityAssociations.length, 1);
  assert.equal(getStore().workspaceCapabilityApprovalEvents.length, 1);
});

test("provider/model default changes do not conflict with a pair approval", async () => {
  const integration = new WorkspaceCapabilityIntegration(denial());
  const { intent, project } = setup();
  const preview = await integration.previewActivation(intent);
  assert.equal(preview.status, "ok");
  if (preview.status !== "ok") return;
  updateProject(project.id, { default_provider: "other-provider", default_model: "other-model" });
  const approvalBinding = binding();
  const result = await integration.commitActivation({
    preview: preview.preview,
    approvalBinding,
    approvalDigest: capabilityOperationDigest(preview.preview, approvalBinding),
    approvedAt: 11,
  });
  assert.equal(result.status, "committed");
});

test("preview accepts and displays every bounded affected runtime status", () => {
  const { intent } = setup();
  const statuses: AffectedRuntimeStatus[] = ["idle", "streaming", "queued", "starting", "mutation_locked"];
  const result = buildWorkspaceCapabilityActivationPreview(intent, statuses.map((status, index) => ({
    runtimeId: `runtime-${index}`,
    status,
  })));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.preview.affectedRuntimes.map((runtime) => runtime.status), statuses);
  assert.doesNotThrow(() => capabilityOperationDigest(result.preview, binding()));
});

test("busy preview semantics apply to all compiled capability classes", () => {
  const capabilities: Array<[WorkspaceCapabilityId, WorkspacePrivacyMode]> = [
    ["wayang.standard-resources.v1", "standard"],
    ["wayang.standard-browser.v1", "standard"],
    ["wayang.host-execution.v1", "standard"],
    ["wayang.protected-browser.v1", "protected"],
    ["wayang.protected-automation.v1", "protected"],
  ];
  for (const [index, [capabilityId, privacyMode]] of capabilities.entries()) {
    const cwd = path.join(root, `capability-project-${index}`);
    fs.mkdirSync(cwd);
    const profile = createAgentProfile({ name: `Capability Profile ${index}`, resource_mode: "standard" });
    const project = createProject({
      cwd,
      name: `Capability Project ${index}`,
      default_agent_profile_id: profile.id,
      access_policy: { privacy_mode: privacyMode, allowed_agent_profile_ids: [profile.id] },
    });
    const result = buildWorkspaceCapabilityActivationPreview({
      capabilityId,
      projectId: project.id,
      agentProfileId: profile.id,
    }, [{ runtimeId: `busy-${index}`, status: "streaming" }]);
    assert.equal(result.status, "ok", capabilityId);
  }
});

test("renderer rejects unknown affected runtime statuses", () => {
  const { intent } = setup();
  const result = buildWorkspaceCapabilityActivationPreview(intent, [{ runtimeId: "runtime", status: "idle" }]);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const forged = structuredClone(result.preview) as any;
  forged.affectedRuntimes[0].status = "unknown";
  assert.throws(() => capabilityOperationDigest(forged, binding()), /invalid affected runtime status/);
});

test("runtime display saturation is distinct from authority conflict", () => {
  const { intent } = setup();
  const result = buildWorkspaceCapabilityActivationPreview(intent, Array.from({ length: 65 }, (_, index) => ({
    runtimeId: `runtime-${index}`,
    status: "idle" as const,
  })));
  assert.deepEqual(result, { status: "runtime_limit", limit: 64 });
});

test("runtime list and status drift do not conflict after PIN review", async () => {
  const lifecycle = denial();
  const integration = new WorkspaceCapabilityIntegration(lifecycle);
  const { intent } = setup();
  const reviewed = buildWorkspaceCapabilityActivationPreview(intent, [
    { runtimeId: "reviewed-stream", status: "streaming" },
    { runtimeId: "reviewed-queue", status: "queued" },
  ]);
  assert.equal(reviewed.status, "ok");
  if (reviewed.status !== "ok") return;
  const approvalBinding = binding();
  const result = await integration.commitActivation({
    preview: reviewed.preview,
    approvalBinding,
    approvalDigest: capabilityOperationDigest(reviewed.preview, approvalBinding),
    approvedAt: 11,
  });
  assert.equal(result.status, "committed");
  assert.deepEqual(lifecycle.activations, ["wayang.host-execution.v1:"]);
});

test("authority drift still conflicts without invoking the activation latch", async () => {
  const lifecycle = denial();
  const integration = new WorkspaceCapabilityIntegration(lifecycle);
  const { intent, project } = setup();
  const reviewed = await integration.previewActivation(intent);
  assert.equal(reviewed.status, "ok");
  if (reviewed.status !== "ok") return;
  const replacement = createAgentProfile({ name: "Authority Drift Replacement", resource_mode: "standard" });
  updateProject(project.id, {
    default_agent_profile_id: replacement.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [replacement.id] },
  });
  const approvalBinding = binding();
  const result = await integration.commitActivation({
    preview: reviewed.preview,
    approvalBinding,
    approvalDigest: capabilityOperationDigest(reviewed.preview, approvalBinding),
    approvedAt: 11,
  });
  assert.equal(result.status, "conflict");
  assert.deepEqual(lifecycle.activations, []);
  assert.equal(getStore().workspaceCapabilityAssociations.length, 0);
});

test("profile enabled-state drift still conflicts without invoking the activation latch", async () => {
  const lifecycle = denial();
  const integration = new WorkspaceCapabilityIntegration(lifecycle);
  const { intent, project, profile } = setup();
  const reviewed = await integration.previewActivation(intent);
  assert.equal(reviewed.status, "ok");
  if (reviewed.status !== "ok") return;
  const replacement = createAgentProfile({ name: "Replacement Profile", resource_mode: "standard" });
  updateProject(project.id, {
    default_agent_profile_id: replacement.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id, replacement.id] },
  });
  updateAgentProfile(profile.id, { enabled: false });
  const approvalBinding = binding();
  const result = await integration.commitActivation({
    preview: reviewed.preview,
    approvalBinding,
    approvalDigest: capabilityOperationDigest(reviewed.preview, approvalBinding),
    approvedAt: 11,
  });
  assert.equal(result.status, "conflict");
  assert.deepEqual(lifecycle.activations, []);
});

test("privacy-mode drift still conflicts without invoking the activation latch", async () => {
  const lifecycle = denial();
  const integration = new WorkspaceCapabilityIntegration(lifecycle);
  const { intent, project, profile } = setup();
  const reviewed = await integration.previewActivation(intent);
  assert.equal(reviewed.status, "ok");
  if (reviewed.status !== "ok") return;
  updateProject(project.id, {
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
  });
  const approvalBinding = binding();
  const result = await integration.commitActivation({
    preview: reviewed.preview,
    approvalBinding,
    approvalDigest: capabilityOperationDigest(reviewed.preview, approvalBinding),
    approvedAt: 11,
  });
  assert.equal(result.status, "conflict");
  assert.deepEqual(lifecycle.activations, []);
});

test("association revision drift still conflicts after another activation wins", async () => {
  const lifecycle = denial();
  const integration = new WorkspaceCapabilityIntegration(lifecycle);
  const { intent } = setup();
  const reviewed = await integration.previewActivation(intent);
  assert.equal(reviewed.status, "ok");
  if (reviewed.status !== "ok") return;
  const approvalBinding = binding();
  const input = {
    preview: reviewed.preview,
    approvalBinding,
    approvalDigest: capabilityOperationDigest(reviewed.preview, approvalBinding),
    approvedAt: 11,
  };
  assert.equal((await integration.commitActivation(input)).status, "committed");
  assert.equal((await integration.commitActivation({ ...input, approvedAt: 12 })).status, "conflict");
  assert.equal(lifecycle.activations.length, 1);
  assert.equal(getStore().workspaceCapabilityApprovalEvents.length, 1);
});

test("activation latch is synchronous and precedes durable association/event commit", async () => {
  const lifecycle = denial();
  lifecycle.latchActivation = function (input) {
    assert.equal(getStore().workspaceCapabilityAssociations.length, 0);
    assert.equal(getStore().workspaceCapabilityApprovalEvents.length, 0);
    this.activations.push(input.intent.capabilityId);
  };
  const integration = new WorkspaceCapabilityIntegration(lifecycle);
  const { intent } = setup();
  const result = await commit(integration, intent, 12);
  assert.equal(result.status, "committed");
  assert.deepEqual(lifecycle.activations, ["wayang.host-execution.v1"]);
  assert.equal(getStore().workspaceCapabilityAssociations.length, 1);
  assert.equal(getStore().workspaceCapabilityApprovalEvents.length, 1);
});

test("durable commit failure after latching creates no authority and leaves refresh requested", async () => {
  const lifecycle = denial();
  lifecycle.latchActivation = function (input) {
    this.activations.push(input.intent.capabilityId);
    failNextCommitStoreMutationPersistenceForTests(new Error("synthetic activation persistence failure"));
  };
  const integration = new WorkspaceCapabilityIntegration(lifecycle);
  const { intent } = setup();
  await assert.rejects(commit(integration, intent, 12), /synthetic activation persistence failure/);
  assert.deepEqual(lifecycle.activations, ["wayang.host-execution.v1"]);
  assert.equal(getStore().workspaceCapabilityAssociations.length, 0);
  assert.equal(getStore().workspaceCapabilityApprovalEvents.length, 0);
});

test("exact-revision revocation publishes tombstone before latch and annotates audit", async () => {
  const d = denial();
  const integration = new WorkspaceCapabilityIntegration(d);
  const { intent } = setup();
  const committed = await commit(integration, intent, 12);
  assert.equal(committed.status, "committed");
  if (committed.status !== "committed") return;
  const revoked = await integration.denyAssociationFirst({ ...intent, expectedRevision: 1 }, 13);
  assert.equal(revoked.status, "revoked");
  assert.deepEqual(d.latched, ["wayang.host-execution.v1:2"]);
  assert.equal(getStore().workspaceCapabilityAssociations[0]?.active, false);
  assert.equal(getStore().workspaceCapabilityApprovalEvents[0]?.revoked_at, 13);
  assert.equal(getStore().workspaceCapabilityApprovalEvents.length, 1);
  assert.equal((await integration.denyAssociationFirst({ ...intent, expectedRevision: 1 }, 14)).status, "already_revoked");
  assert.equal(getStore().workspaceCapabilityApprovalEvents.length, 1);
});

test("stale expected revision cannot revoke a newer regrant", async () => {
  const integration = new WorkspaceCapabilityIntegration(denial());
  const { intent } = setup();
  assert.equal((await commit(integration, intent, 10)).status, "committed");
  assert.equal((await integration.denyAssociationFirst({ ...intent, expectedRevision: 1 }, 11)).status, "revoked");
  assert.equal((await commit(integration, intent, 12)).status, "committed");
  assert.equal((await integration.denyAssociationFirst({ ...intent, expectedRevision: 1 }, 13)).status, "conflict");
  assert.equal(getStore().workspaceCapabilityAssociations[0]?.revision, 3);
  assert.equal(getStore().workspaceCapabilityAssociations[0]?.active, true);
});

test("missing or unsafe PIN/cooldown authority fails closed without creating defaults", async () => {
  const statePath = path.join(root, "missing", "pin-attempt-state.json");
  const pins = new HardenedSettingsPinAttemptAdapter(statePath);
  const result = await pins.reserve({
    realm: "wayang.workspace-capabilities.v1",
    reservationId: "reservation",
    requestId: "request",
    operationDigest: "d".repeat(64),
    expiresAt: Date.now() + 60_000,
  });
  assert.deepEqual(result, { status: "unavailable" });
  assert.equal(fs.existsSync(statePath), false);
});

test("unsupported directory fsync is best-effort", () => {
  const directory = path.join(root, "portable-directory-sync");
  fs.mkdirSync(directory, { mode: 0o700 });
  let called = false;
  assert.doesNotThrow(() => syncDirectoryBestEffort(directory, (descriptor) => {
    called = true;
    assert.equal(fs.fstatSync(descriptor).isDirectory(), true);
    const error = new Error("directory fsync is unsupported") as NodeJS.ErrnoException;
    error.code = "EINVAL";
    throw error;
  }));
  assert.equal(called, true);
});

test("failed startup initialization latches an otherwise valid state unavailable for the process", async () => {
  const pinDirectory = path.join(root, "config", "pi");
  const stateDirectory = path.join(root, "approval-latched");
  fs.mkdirSync(pinDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(pinDirectory, "command-guard-identity-pin"), "12345678\n", { mode: 0o600 });
  const statePath = path.join(stateDirectory, "pin-attempt-state.json");
  const initial = `${JSON.stringify({ version: 1, attemptCount: 0, lastAttemptAtMs: 0, reservation: null })}\n`;
  fs.writeFileSync(statePath, initial, { mode: 0o600 });
  const pins = new HardenedSettingsPinAttemptAdapter(statePath, false);
  assert.deepEqual(await pins.reserve({
    realm: "wayang.workspace-capabilities.v1",
    reservationId: "reservation",
    requestId: "request",
    operationDigest: "f".repeat(64),
    expiresAt: Date.now() + 60_000,
  }), { status: "unavailable" });
  assert.equal(fs.readFileSync(statePath, "utf8"), initial);
});

test("owner-only PIN state reserves the preallocated attempt and verifies opaquely once", async () => {
  const pinDirectory = path.join(root, "config", "pi");
  const stateDirectory = path.join(root, "approval");
  fs.mkdirSync(pinDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(pinDirectory, "command-guard-identity-pin"), "12345678\n", { mode: 0o600 });
  const statePath = path.join(stateDirectory, "pin-attempt-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, attemptCount: 0, lastAttemptAtMs: 0, reservation: null }), { mode: 0o600 });
  const pins = new HardenedSettingsPinAttemptAdapter(statePath);
  const reserved = await pins.reserve({
    realm: "wayang.workspace-capabilities.v1",
    reservationId: "preallocated-reservation",
    requestId: "request",
    operationDigest: "e".repeat(64),
    expiresAt: Date.now() + 60_000,
  });
  assert.deepEqual(reserved, { status: "reserved" });
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).reservation.reservationId, "preallocated-reservation");
  assert.deepEqual(await pins.verifyAndConsume({
    realm: "wayang.workspace-capabilities.v1",
    reservationId: "preallocated-reservation",
    requestId: "request",
    pin: "12345678",
    now: Date.now(),
  }), { status: "verified" });
  const persisted = fs.readFileSync(statePath, "utf8");
  assert.equal(persisted.includes("12345678"), false);
  assert.equal(JSON.parse(persisted).reservation, null);
});
