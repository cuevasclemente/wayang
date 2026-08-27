import assert from "node:assert/strict";
import http from "node:http";
import test, { type TestContext } from "node:test";
import express from "express";
import { capabilityPreviewStateDigest } from "../workspace-capability-approval/renderer.js";
import { WorkspaceCapabilityApprovalService } from "../workspace-capability-approval/service.js";
import type { ReservePinAttemptResult, SettingsPinAttemptPort, WorkspaceCapabilityMutationPort } from "../workspace-capability-approval/types.js";
import { createWorkspaceCapabilitiesRouter } from "./workspace-capabilities.js";

const OWNER = { sessionId: "synthetic-web-session", origin: "https://wayang.test" };

class Pins implements SettingsPinAttemptPort {
  cancellations: string[] = [];
  constructor(private readonly reservation: ReservePinAttemptResult = { status: "reserved" }) {}
  async reserve() { return this.reservation; }
  async verifyAndConsume() { return { status: "verified" as const }; }
  async cancelAndConsume(input: Parameters<SettingsPinAttemptPort["cancelAndConsume"]>[0]) { this.cancellations.push(input.reason); }
}

function workspace(): WorkspaceCapabilityMutationPort {
  return {
    async previewActivation(intent) {
      const preview = {
        intent,
        projectLabel: "Synthetic Project",
        projectCwd: "/synthetic/project",
        agentProfileLabel: "Synthetic Profile",
        privacyMode: "standard" as const,
        profileAllowed: true,
        profileEnabled: true,
        associationBefore: null,
        associationAfter: { active: true, revision: 1 },
        previewStateDigest: "",
        affectedRuntimes: [],
      };
      preview.previewStateDigest = capabilityPreviewStateDigest(preview);
      return { status: "ok", preview };
    },
    async commitActivation(input) {
      return { status: "committed", result: {
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
          id: "event",
          associationRevision: 1,
          operationDigest: input.approvalDigest,
          approvedAt: input.approvedAt,
          revokedAt: null,
        },
      }, idleRuntimeIds: [] };
    },
    async denyAssociationFirst(intent, revokedAt) {
      return { status: "revoked", association: {
        capabilityId: intent.capabilityId,
        projectId: intent.projectId,
        agentProfileId: intent.agentProfileId,
        revision: intent.expectedRevision + 1,
        active: false,
        approvedAt: 1,
        revokedAt,
        updatedAt: revokedAt,
      }, cleanupRuntimeIds: [] };
    },
    async getCatalogStatus(limit) {
      return { associations: [], approvalEvents: [], history: { returned: 0, limit, hasMore: false } };
    },
  };
}

async function start(t: TestContext, pins = new Pins(), workspacePort = workspace()) {
  const service = new WorkspaceCapabilityApprovalService({ workspace: workspacePort, pinAttempts: pins, randomId: () => "request" });
  const app = express();
  app.use("/api", createWorkspaceCapabilitiesRouter({
    service,
    owners: {
      resolve(req) {
        return req.header("x-synthetic-auth") === "lost"
          ? { status: "unauthenticated", previousOwner: OWNER }
          : { status: "authenticated", owner: OWNER };
      },
    },
  }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { pins, base: `http://127.0.0.1:${address.port}/api` };
}

const INTENT = {
  capabilityId: "wayang.host-execution.v1",
  projectId: "project",
  agentProfileId: "profile",
};

test("request API accepts compiled IDs and rejects provider/model extras", async (t) => {
  const { base } = await start(t);
  const stale = await fetch(`${base}/workspace-capabilities/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...INTENT, provider: "old", model: "tuple" }),
  });
  assert.equal(stale.status, 400);
  const created = await fetch(`${base}/workspace-capabilities/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(INTENT),
  });
  assert.equal(created.status, 201);
  const challenge = await created.json() as Record<string, unknown>;
  assert.equal("provider" in challenge, false);
  assert.equal("model" in challenge, false);
  assert.match(created.headers.get("cache-control") ?? "", /no-store/);
});

test("request API accepts and displays busy affected-runtime statuses", async (t) => {
  const busy = workspace();
  busy.previewActivation = async (intent) => {
    const preview = {
      intent,
      projectLabel: "Synthetic Project",
      projectCwd: "/synthetic/project",
      agentProfileLabel: "Synthetic Profile",
      privacyMode: "standard" as const,
      profileAllowed: true,
      profileEnabled: true,
      associationBefore: null,
      associationAfter: { active: true, revision: 1 },
      previewStateDigest: "",
      affectedRuntimes: [
        { runtimeId: "streaming-runtime", status: "streaming" as const },
        { runtimeId: "queued-runtime", status: "queued" as const },
        { runtimeId: "starting-runtime", status: "starting" as const },
        { runtimeId: "locked-runtime", status: "mutation_locked" as const },
      ],
    };
    preview.previewStateDigest = capabilityPreviewStateDigest(preview);
    return { status: "ok", preview };
  };
  const { base } = await start(t, new Pins(), busy);
  const response = await fetch(`${base}/workspace-capabilities/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(INTENT),
  });
  assert.equal(response.status, 201);
  const body = await response.json() as { affectedRuntimes: Array<{ status: string }> };
  assert.deepEqual(body.affectedRuntimes.map((runtime) => runtime.status), [
    "streaming", "queued", "starting", "mutation_locked",
  ]);
});

test("busy-runtime display saturation returns a distinct bounded contract", async (t) => {
  const saturated = workspace();
  saturated.previewActivation = async () => ({ status: "runtime_limit", limit: 64 });
  const { base } = await start(t, new Pins(), saturated);
  const response = await fetch(`${base}/workspace-capabilities/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(INTENT),
  });
  assert.equal(response.status, 409);
  const body = await response.json() as { code?: string; error?: string };
  assert.equal(body.code, "runtime_limit");
  assert.match(body.error ?? "", /at most 64 affected runtimes/);
});

test("cooldown returns the typed 429 contract and Retry-After without creating a challenge", async (t) => {
  const retryAt = Date.now() + 5_000;
  const { base } = await start(t, new Pins({ status: "cooldown", retryAt }));
  const response = await fetch(`${base}/workspace-capabilities/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(INTENT),
  });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) >= 1);
  const body = await response.json() as { code?: string; error?: string; requestId?: string };
  assert.equal(body.code, "cooldown");
  assert.equal("requestId" in body, false);
});

test("authentication loss consumes pending PIN request and malformed commit cannot replay", async (t) => {
  const { base, pins } = await start(t);
  const created = await fetch(`${base}/workspace-capabilities/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(INTENT),
  });
  assert.equal(created.status, 201);
  const lost = await fetch(`${base}/workspace-capabilities/requests/request/commit`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-synthetic-auth": "lost" },
    body: JSON.stringify({ pin: "2468" }),
  });
  assert.equal(lost.status, 401);
  assert.deepEqual(pins.cancellations, ["authentication_lost"]);
  const replay = await fetch(`${base}/workspace-capabilities/requests/request/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "2468" }),
  });
  assert.equal(replay.status, 404);
});

test("revocation route requires exact triple plus expectedRevision and returns association", async (t) => {
  const { base } = await start(t);
  const oldPath = await fetch(`${base}/workspace-capability-activations/event/revoke`, { method: "POST" });
  assert.equal(oldPath.status, 404);
  const malformed = await fetch(`${base}/workspace-capability-associations/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...INTENT, expectedRevision: 3, activationId: "event" }),
  });
  assert.equal(malformed.status, 400);
  const revoked = await fetch(`${base}/workspace-capability-associations/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...INTENT, expectedRevision: 3 }),
  });
  assert.equal(revoked.status, 200);
  assert.match(revoked.headers.get("cache-control") ?? "", /no-store/);
  const body = await revoked.json() as { association: { revision: number; active: boolean } };
  assert.equal(body.association.revision, 4);
  assert.equal(body.association.active, false);
});
