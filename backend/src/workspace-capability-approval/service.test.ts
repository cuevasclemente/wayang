import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityApprovalError } from "./errors.js";
import { capabilityPreviewStateDigest } from "./renderer.js";
import {
  MAX_WORKSPACE_CAPABILITY_ACTIVATION_HISTORY,
  boundedHistoryLimit,
  mayAppendActivationHistory,
} from "./history-policy.js";
import { WorkspaceCapabilityApprovalService } from "./service.js";
import type {
  CapabilityActivationIntent,
  CapabilityActivationPreview,
  SettingsPinAttemptPort,
  WorkspaceCapabilityMutationPort,
} from "./types.js";

const OWNER = { sessionId: "synthetic-settings-session", origin: "https://wayang.test" };
const INTENT: CapabilityActivationIntent = {
  capabilityId: "wayang.host-execution.v1",
  projectId: "standard-project",
  agentProfileId: "ordinary-profile",
};

function preview(intent = INTENT): CapabilityActivationPreview {
  const value: CapabilityActivationPreview = {
    intent,
    projectLabel: "Renamed Project",
    projectCwd: "/synthetic/project",
    agentProfileLabel: "Not A Built-in Identity",
    privacyMode: intent.capabilityId.startsWith("wayang.protected-") ? "protected" : "standard",
    profileAllowed: true,
    profileEnabled: true,
    associationBefore: null,
    associationAfter: { active: true, revision: 1 },
    previewStateDigest: "",
    affectedRuntimes: [{ runtimeId: "idle-one", status: "idle" }],
  };
  value.previewStateDigest = capabilityPreviewStateDigest(value);
  return value;
}

class AcceptingPinPort implements SettingsPinAttemptPort {
  async reserve() { return { status: "reserved" as const }; }
  async verifyAndConsume() { return { status: "verified" as const }; }
  async cancelAndConsume() {}
}

function workspacePort(events: string[]): WorkspaceCapabilityMutationPort {
  return {
    async previewActivation(intent) {
      events.push("preview");
      return { status: "ok", preview: preview(intent) };
    },
    async commitActivation(input) {
      events.push(`commit:${input.approvalDigest.length}`);
      return {
        status: "committed",
        result: {
          association: {
            ...input.preview.intent,
            revision: 1,
            active: true,
            approvedAt: input.approvedAt,
            revokedAt: null,
            updatedAt: input.approvedAt,
          },
          approvalEvent: {
            ...input.preview.intent,
            id: "event-1",
            associationRevision: 1,
            operationDigest: input.approvalDigest,
            approvedAt: input.approvedAt,
            revokedAt: null,
          },
        },
        idleRuntimeIds: ["idle-one"],
      };
    },
    async denyAssociationFirst(intent, revokedAt) {
      events.push("deny-first");
      return {
        status: "revoked",
        association: {
          capabilityId: intent.capabilityId,
          projectId: intent.projectId,
          agentProfileId: intent.agentProfileId,
          revision: intent.expectedRevision + 1,
          active: false,
          approvedAt: 1,
          revokedAt,
          updatedAt: revokedAt,
        },
        cleanupRuntimeIds: ["runtime-one"],
      };
    },
    async getCatalogStatus(limit) {
      return { associations: [], approvalEvents: [], history: { returned: 0, limit, hasMore: false } };
    },
  };
}

function code(expected: string) {
  return (error: unknown) => error instanceof CapabilityApprovalError && error.code === expected;
}

test("activation uses the atomic workspace port and stops idle runtimes after commit", async () => {
  const events: string[] = [];
  const service = new WorkspaceCapabilityApprovalService({
    workspace: workspacePort(events),
    pinAttempts: new AcceptingPinPort(),
    cleanup: {
      async stopAfterActivation(ids) { events.push(`stop:${ids.join(",")}`); },
      async cleanupAfterRevocation() {},
    },
    randomId: (() => { const ids = ["request-1", "reservation-1"]; return () => ids.shift()!; })(),
  });
  const challenge = await service.requestActivation(OWNER, INTENT);
  const result = await service.commit(OWNER, challenge.requestId, "2468");
  assert.equal(result.association.revision, 1);
  assert.equal(result.approvalEvent.operationDigest, challenge.operationDigest);
  assert.deepEqual(events.map((event) => event.replace(/commit:\d+/, "commit:digest")), ["preview", "commit:digest", "stop:idle-one"]);
});

test("commit conflict requires a fresh preview and cannot replay the verified request", async () => {
  const workspace = workspacePort([]);
  workspace.commitActivation = async () => ({ status: "conflict" });
  const service = new WorkspaceCapabilityApprovalService({ workspace, pinAttempts: new AcceptingPinPort() });
  const challenge = await service.requestActivation(OWNER, INTENT);
  await assert.rejects(service.commit(OWNER, challenge.requestId, "2468"), code("state_conflict"));
  await assert.rejects(service.commit(OWNER, challenge.requestId, "2468"), code("request_not_found"));
});

test("revocation uses exact triple and expected revision, denial before cleanup", async () => {
  const events: string[] = [];
  const service = new WorkspaceCapabilityApprovalService({
    workspace: workspacePort(events),
    pinAttempts: new AcceptingPinPort(),
    cleanup: {
      async stopAfterActivation() {},
      async cleanupAfterRevocation() { events.push("cleanup"); throw new Error("synthetic cleanup failure"); },
    },
    now: () => 1234,
  });
  const association = await service.revoke(OWNER, { ...INTENT, expectedRevision: 7 });
  assert.equal(association.revision, 8);
  assert.equal(association.active, false);
  assert.deepEqual(events, ["deny-first", "cleanup"]);
});

test("activation accepts only the exact triple shape and rejects tuple-era or unknown fields", async () => {
  const events: string[] = [];
  const service = new WorkspaceCapabilityApprovalService({ workspace: workspacePort(events), pinAttempts: new AcceptingPinPort() });
  await assert.rejects(service.requestActivation(OWNER, { ...INTENT, provider: "old", model: "tuple" }), code("invalid_request"));
  await assert.rejects(service.requestActivation(OWNER, { ...INTENT, extraGrant: true }), code("invalid_request"));
  await assert.rejects(service.requestActivation(OWNER, { ...INTENT, capabilityId: "Wren" }), code("invalid_request"));
  await assert.rejects(service.revoke(OWNER, { ...INTENT, expectedRevision: 1, id: "old-event" }), code("invalid_request"));
  assert.deepEqual(events, []);
});

test("protected automation activation uses the reviewed preview and PIN reservation flow", async () => {
  const events: string[] = [];
  let reservations = 0;
  const service = new WorkspaceCapabilityApprovalService({
    workspace: workspacePort(events),
    pinAttempts: {
      async reserve() { reservations += 1; return { status: "reserved" as const }; },
      async verifyAndConsume() { return { status: "verified" as const }; },
      async cancelAndConsume() {},
    },
  });

  const challenge = await service.requestActivation(OWNER, {
    capabilityId: "wayang.protected-automation.v1",
    projectId: "protected-project",
    agentProfileId: "automation-owner",
  });
  assert.equal(challenge.capabilityId, "wayang.protected-automation.v1");
  assert.deepEqual(events, ["preview"]);
  assert.equal(reservations, 1);
});

test("runtime display saturation has a distinct response and consumes no PIN reservation", async () => {
  let reservations = 0;
  const service = new WorkspaceCapabilityApprovalService({
    workspace: {
      ...workspacePort([]),
      async previewActivation() { return { status: "runtime_limit", limit: 64 }; },
    },
    pinAttempts: {
      async reserve() { reservations += 1; return { status: "reserved" as const }; },
      async verifyAndConsume() { return { status: "verified" as const }; },
      async cancelAndConsume() {},
    },
  });
  await assert.rejects(service.requestActivation(OWNER, INTENT), code("runtime_limit"));
  assert.equal(reservations, 0);
});

test("history saturation rejects before consuming a PIN reservation", async () => {
  let reservations = 0;
  const service = new WorkspaceCapabilityApprovalService({
    workspace: {
      ...workspacePort([]),
      async previewActivation() { return { status: "denied", reason: "activation_history_full" }; },
    },
    pinAttempts: {
      async reserve() { reservations += 1; return { status: "reserved" as const }; },
      async verifyAndConsume() { return { status: "verified" as const }; },
      async cancelAndConsume() {},
    },
  });
  await assert.rejects(service.requestActivation(OWNER, INTENT), code("history_full"));
  assert.equal(reservations, 0);
});

test("history policy remains bounded without rollover", () => {
  assert.deepEqual(mayAppendActivationHistory(MAX_WORKSPACE_CAPABILITY_ACTIVATION_HISTORY - 1), { allowed: true });
  assert.deepEqual(mayAppendActivationHistory(MAX_WORKSPACE_CAPABILITY_ACTIVATION_HISTORY), { allowed: false, reason: "history_full" });
  assert.equal(boundedHistoryLimit(undefined), 100);
  assert.throws(() => boundedHistoryLimit("201"), /history limit/);
});

test("status separates current associations from PIN approval events", async () => {
  const service = new WorkspaceCapabilityApprovalService({ workspace: workspacePort([]), pinAttempts: new AcceptingPinPort() });
  const status = await service.status(10);
  assert.deepEqual(status.capabilities.map((entry) => entry.id), [
    "wayang.standard-resources.v1",
    "wayang.standard-browser.v1",
    "wayang.host-execution.v1",
    "wayang.protected-browser.v1",
    "wayang.protected-automation.v1",
  ]);
  assert.deepEqual(status.associations, []);
  assert.deepEqual(status.approvalEvents, []);
  assert.equal(status.history.limit, 10);
});
