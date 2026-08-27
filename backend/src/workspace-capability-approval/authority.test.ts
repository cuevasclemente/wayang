import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityApprovalAuthority } from "./authority.js";
import { CapabilityApprovalError } from "./errors.js";
import { capabilityOperationDigest, capabilityPreviewStateDigest } from "./renderer.js";
import type { CapabilityActivationPreview, SettingsPinAttemptPort, SettingsRequestOwner } from "./types.js";

const OWNER: SettingsRequestOwner = { sessionId: "synthetic-session-a", origin: "https://wayang.test" };
const OTHER_SESSION: SettingsRequestOwner = { sessionId: "synthetic-session-b", origin: OWNER.origin };
const OTHER_ORIGIN: SettingsRequestOwner = { sessionId: OWNER.sessionId, origin: "https://other.test" };

function preview(overrides: Partial<CapabilityActivationPreview> = {}): CapabilityActivationPreview {
  const value: CapabilityActivationPreview = {
    intent: {
      capabilityId: "wayang.protected-browser.v1",
      projectId: "future-protected-project-id",
      agentProfileId: "arbitrary-profile-id",
    },
    projectLabel: "Unrelated Protected Project",
    projectCwd: "/synthetic/protected-project",
    privacyMode: "protected",
    profileAllowed: true,
    agentProfileLabel: "Any Deployment Name",
    profileEnabled: true,
    associationBefore: null,
    associationAfter: { active: true, revision: 1 },
    previewStateDigest: "",
    affectedRuntimes: [{ runtimeId: "idle-runtime", status: "idle" }],
    ...overrides,
  };
  value.previewStateDigest = capabilityPreviewStateDigest(value);
  return value;
}

class SyntheticPinAttempts implements SettingsPinAttemptPort {
  reservations: Parameters<SettingsPinAttemptPort["reserve"]>[0][] = [];
  verifications = 0;
  cancellations: string[] = [];
  expectedPin = "2468";
  async reserve(input: Parameters<SettingsPinAttemptPort["reserve"]>[0]) {
    this.reservations.push(input);
    return { status: "reserved" as const };
  }
  async verifyAndConsume(input: Parameters<SettingsPinAttemptPort["verifyAndConsume"]>[0]) {
    this.verifications += 1;
    return input.pin === this.expectedPin ? { status: "verified" as const } : { status: "wrong_pin" as const };
  }
  async cancelAndConsume(input: Parameters<SettingsPinAttemptPort["cancelAndConsume"]>[0]) {
    this.cancellations.push(input.reason);
  }
}

function errorCode(expected: string) {
  return (error: unknown) => error instanceof CapabilityApprovalError && error.code === expected;
}

function ids(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}

test("preallocates request and reservation IDs and binds them plus owner/Origin into the digest", async () => {
  const pins = new SyntheticPinAttempts();
  let committedDigest = "";
  const authority = new CapabilityApprovalAuthority({
    pinAttempts: pins,
    ownerKey: Buffer.alloc(32, 1),
    randomId: ids("synthetic-request", "synthetic-reservation"),
    now: () => 1_000,
    requestTtlMs: 10_000,
    commitVerified: async ({ approvalDigest }) => { committedDigest = approvalDigest; return "committed"; },
  });

  const current = preview();
  const challenge = await authority.create(OWNER, current);
  const binding = {
    requestId: "synthetic-request",
    reservationId: "synthetic-reservation",
    expiresAt: 11_000,
    owner: OWNER,
  };
  assert.equal(challenge.operationDigest, capabilityOperationDigest(current, binding));
  assert.equal(Object.hasOwn(challenge, "provider"), false);
  assert.equal(Object.hasOwn(challenge, "model"), false);
  assert.equal(pins.reservations[0]?.requestId, binding.requestId);
  assert.equal(pins.reservations[0]?.reservationId, binding.reservationId);
  assert.equal(pins.reservations[0]?.operationDigest, challenge.operationDigest);
  assert.equal(await authority.commit(OWNER, challenge.requestId, pins.expectedPin), "committed");
  assert.equal(committedDigest, challenge.operationDigest);
  assert.notEqual(capabilityOperationDigest(current, { ...binding, owner: OTHER_ORIGIN }), challenge.operationDigest);
});

test("binds a request to both exact web session and exact Origin", async () => {
  const pins = new SyntheticPinAttempts();
  const authority = new CapabilityApprovalAuthority({ pinAttempts: pins, commitVerified: async () => "ok" });
  const challenge = await authority.create(OWNER, preview());
  await assert.rejects(authority.commit(OTHER_SESSION, challenge.requestId, pins.expectedPin), errorCode("owner_mismatch"));
  await assert.rejects(authority.commit(OTHER_ORIGIN, challenge.requestId, pins.expectedPin), errorCode("owner_mismatch"));
  assert.equal(pins.verifications, 0);
  await authority.cancel(OWNER, challenge.requestId);
  assert.deepEqual(pins.cancellations, ["cancelled"]);
});

test("wrong PIN consumes a request and prevents replay", async () => {
  const pins = new SyntheticPinAttempts();
  let commits = 0;
  const authority = new CapabilityApprovalAuthority({ pinAttempts: pins, commitVerified: async () => { commits += 1; return "ok"; } });
  const challenge = await authority.create(OWNER, preview());
  await assert.rejects(authority.commit(OWNER, challenge.requestId, "0000"), errorCode("wrong_pin"));
  await assert.rejects(authority.commit(OWNER, challenge.requestId, pins.expectedPin), errorCode("request_not_found"));
  assert.equal(commits, 0);
});

test("expiry consumes the exact reserved attempt and releases the realm", async () => {
  let now = 1_000_000;
  const pins = new SyntheticPinAttempts();
  const authority = new CapabilityApprovalAuthority({
    pinAttempts: pins,
    now: () => now,
    requestTtlMs: 10_000,
    randomId: ids("request-1", "reservation-1", "request-2", "reservation-2"),
    commitVerified: async () => "ok",
  });
  const first = await authority.create(OWNER, preview());
  await assert.rejects(authority.create(OWNER, preview()), errorCode("realm_busy"));
  now = first.expiresAt;
  await authority.expirePending();
  assert.deepEqual(pins.cancellations, ["expired"]);
  assert.equal((await authority.create(OWNER, preview())).requestId, "request-2");
});

test("incompatible privacy fails before PIN reservation while non-idle runtimes remain reviewable", async () => {
  const pins = new SyntheticPinAttempts();
  const authority = new CapabilityApprovalAuthority({ pinAttempts: pins, commitVerified: async () => "ok" });
  await assert.rejects(authority.create(OWNER, preview({ privacyMode: "standard" })), /incompatible/);
  assert.equal(pins.reservations.length, 0);
  const challenge = await authority.create(OWNER, preview({ affectedRuntimes: [{ runtimeId: "busy", status: "streaming" }] }));
  assert.deepEqual(challenge.affectedRuntimes, [{ runtimeId: "busy", status: "streaming" }]);
  assert.equal(pins.reservations.length, 1);
});
