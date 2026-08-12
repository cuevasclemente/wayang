import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeMessagingParticipant,
  compileMessagingEndpointDeclarations,
  validateMessagingEndpointDeclaration,
} from "./endpoint-policy.js";
import type {
  MessagingConversationBinding,
  MessagingEndpointDeclaration,
  MessagingParticipantSnapshot,
  NormalizedMessagingInboundEvent,
} from "./contracts.js";

const NOW = 1_800_000_000_000;

function declaration(overrides: Partial<MessagingEndpointDeclaration> = {}): MessagingEndpointDeclaration {
  return {
    endpointId: "memory-wren",
    connectorId: "matrix",
    provisioningKey: "memory-wren",
    projectId: "11111111-1111-4111-8111-111111111111",
    agentProfileId: "22222222-2222-4222-8222-222222222222",
    displayName: "Memory — Wren",
    conversationMode: "shared",
    allowedSubjectIds: ["@alice:example.test", "@bob:example.test"],
    transportSecurity: "unencrypted_accepted",
    ...overrides,
  };
}

function binding(overrides: Partial<MessagingConversationBinding> = {}): MessagingConversationBinding {
  return {
    endpointId: "memory-wren",
    connectorId: "matrix",
    externalConversationId: "!canonical:example.test",
    activeWayangSessionId: null,
    revision: 1,
    ...overrides,
  };
}

function inbound(overrides: Partial<NormalizedMessagingInboundEvent> = {}): NormalizedMessagingInboundEvent {
  return {
    connectorId: "matrix",
    connectorEventId: "$event:example.test",
    externalConversationId: "!canonical:example.test",
    senderSubjectId: "@alice:example.test",
    body: "Hello from Matrix",
    occurredAt: NOW - 1_000,
    ...overrides,
  };
}

function participants(overrides: Partial<MessagingParticipantSnapshot> = {}): MessagingParticipantSnapshot {
  return {
    connectorId: "matrix",
    externalConversationId: "!canonical:example.test",
    senderSubjectId: "@alice:example.test",
    joinedHumanSubjectIds: ["@alice:example.test", "@bob:example.test"],
    complete: true,
    observedAt: NOW,
    revision: "$membership-state:example.test",
    confidentiality: "server_visible",
    ...overrides,
  };
}

function authorize(
  endpoint = declaration(),
  bound = binding(),
  event = inbound(),
  snapshot = participants(),
) {
  return authorizeMessagingParticipant(endpoint, bound, event, snapshot, { now: NOW });
}

test("validates and freezes connector-neutral endpoint declarations", () => {
  const validated = validateMessagingEndpointDeclaration(declaration());
  assert.deepEqual(validated, declaration());
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.allowedSubjectIds), true);

  const protectedTransport = validateMessagingEndpointDeclaration(declaration({
    endpointId: "finance-agent",
    provisioningKey: "finance-agent",
    transportSecurity: "encrypted_required",
  }));
  assert.equal(protectedTransport.transportSecurity, "encrypted_required");
});

test("rejects malformed declarations and ambiguous declaration sets", () => {
  assert.throws(() => validateMessagingEndpointDeclaration({ ...declaration(), surprise: true }), /unknown or missing/);
  assert.throws(() => validateMessagingEndpointDeclaration(declaration({ allowedSubjectIds: [] })), /nonempty bounded array/);
  assert.throws(() => validateMessagingEndpointDeclaration(declaration({
    allowedSubjectIds: ["@alice:example.test", "@alice:example.test"],
  })), /duplicates/);
  assert.throws(() => validateMessagingEndpointDeclaration(declaration({ endpointId: "Invalid Name" })), /endpointId/);
  for (const displayName of ["unsafe\u202ename", "unsafe\u2028name", "unsafe\u2029name"]) {
    assert.throws(() => validateMessagingEndpointDeclaration(declaration({ displayName })), /displayName/);
  }

  assert.throws(() => compileMessagingEndpointDeclarations({}), /bounded array/);
  assert.throws(() => compileMessagingEndpointDeclarations(new Array(257).fill(declaration())), /bounded array/);
  assert.throws(() => compileMessagingEndpointDeclarations([
    declaration(),
    declaration({ provisioningKey: "second-key" }),
  ]), /Duplicate messaging endpointId/);
  assert.throws(() => compileMessagingEndpointDeclarations([
    declaration(),
    declaration({ endpointId: "second-endpoint" }),
  ]), /Duplicate messaging provisioning key/);

  assert.throws(() => compileMessagingEndpointDeclarations([
    declaration(),
    declaration({ endpointId: "slack-memory", connectorId: "slack" }),
  ]), /exact Project\/Profile pair/, "Project/Profile authority is globally unique across connectors");

  const crossConnector = compileMessagingEndpointDeclarations([
    declaration(),
    declaration({
      endpointId: "slack-memory",
      connectorId: "slack",
      agentProfileId: "33333333-3333-4333-8333-333333333333",
    }),
  ]);
  assert.equal(crossConnector.length, 2, "provisioning keys remain connector-namespaced for distinct authority pairs");
});

test("binds the actual event sender to fresh complete membership in the exact conversation", () => {
  assert.deepEqual(authorize(), { allowed: true });

  const wrongRoom = authorize(
    declaration(),
    binding(),
    inbound({ externalConversationId: "!lookalike:example.test" }),
  );
  assert.equal(wrongRoom.allowed, false);
  if (!wrongRoom.allowed) assert.equal(wrongRoom.code, "endpoint_binding_mismatch");

  const confusedDeputy = authorize(
    declaration(),
    binding(),
    inbound({ senderSubjectId: "@bob:example.test" }),
    participants({ senderSubjectId: "@alice:example.test" }),
  );
  assert.equal(confusedDeputy.allowed, false);
  if (!confusedDeputy.allowed) assert.equal(confusedDeputy.code, "event_snapshot_mismatch");

  const notJoined = authorize(
    declaration(),
    binding(),
    inbound(),
    participants({ joinedHumanSubjectIds: ["@bob:example.test"] }),
  );
  assert.equal(notJoined.allowed, false);
  if (!notJoined.allowed) assert.equal(notJoined.code, "sender_not_joined");

  const notAllowed = authorize(
    declaration(),
    binding(),
    inbound({ senderSubjectId: "@mallory:example.test" }),
    participants({
      senderSubjectId: "@mallory:example.test",
      joinedHumanSubjectIds: ["@mallory:example.test"],
    }),
  );
  assert.equal(notAllowed.allowed, false);
  if (!notAllowed.allowed) assert.equal(notAllowed.code, "sender_not_allowed");
});

test("enforces observed confidentiality and fresh complete membership evidence", () => {
  const transportDenied = authorize(
    declaration({ transportSecurity: "encrypted_required" }),
    binding(),
    inbound(),
    participants({ confidentiality: "server_visible" }),
  );
  assert.equal(transportDenied.allowed, false);
  if (!transportDenied.allowed) assert.equal(transportDenied.code, "transport_not_allowed");

  const encrypted = authorize(
    declaration({ transportSecurity: "encrypted_required" }),
    binding(),
    inbound(),
    participants({ confidentiality: "end_to_end_encrypted" }),
  );
  assert.deepEqual(encrypted, { allowed: true });

  const stale = authorizeMessagingParticipant(
    declaration(),
    binding(),
    inbound(),
    participants({ observedAt: NOW - 30_001 }),
    { now: NOW },
  );
  assert.equal(stale.allowed, false);
  if (!stale.allowed) assert.equal(stale.code, "stale_snapshot");

  const incomplete = authorize(
    declaration(),
    binding(),
    inbound(),
    { ...participants(), complete: false } as unknown as MessagingParticipantSnapshot,
  );
  assert.equal(incomplete.allowed, false);
  if (!incomplete.allowed) assert.equal(incomplete.code, "invalid_snapshot");

  const future = authorizeMessagingParticipant(
    declaration(), binding(), inbound(), participants({ observedAt: NOW + 5_001 }), { now: NOW },
  );
  assert.equal(future.allowed, false);
  if (!future.allowed) assert.equal(future.code, "stale_snapshot");

  const unknown = authorize(
    declaration(), binding(), inbound(), participants({ confidentiality: "unknown" }),
  );
  assert.equal(unknown.allowed, false);
  if (!unknown.allowed) assert.equal(unknown.code, "transport_not_allowed");
});

test("blocks the whole shared endpoint when any unexpected human is joined", () => {
  const decision = authorize(
    declaration(),
    binding(),
    inbound(),
    participants({
      joinedHumanSubjectIds: ["@alice:example.test", "@bob:example.test", "@mallory:example.test"],
    }),
  );
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(decision.code, "unexpected_participant");
    assert.deepEqual(decision.unexpectedSubjectIds, ["@mallory:example.test"]);
  }
});

test("rejects malformed or ambiguous events and membership snapshots", () => {
  const malformedSnapshots = [
    participants({ joinedHumanSubjectIds: [] }),
    participants({ joinedHumanSubjectIds: ["@alice:example.test", "@alice:example.test"] }),
    participants({ senderSubjectId: "unsafe\u0000sender" }),
  ];
  for (const snapshot of malformedSnapshots) {
    const decision = authorize(declaration(), binding(), inbound(), snapshot);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.code, "invalid_snapshot");
  }

  const invalidEvents = [
    { ...inbound(), body: "x".repeat(64 * 1024 + 1) },
    { ...inbound(), extra: true },
  ];
  for (const event of invalidEvents) {
    const decision = authorize(
      declaration(), binding(), event as NormalizedMessagingInboundEvent, participants(),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.code, "invalid_event");
  }

  for (const malformedBinding of [
    { ...binding(), revision: -1 },
    { ...binding(), extra: true },
  ]) {
    const decision = authorize(
      declaration(), malformedBinding as MessagingConversationBinding, inbound(), participants(),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.code, "invalid_event");
  }

  const extraSnapshot = authorize(
    declaration(), binding(), inbound(), { ...participants(), extra: true } as MessagingParticipantSnapshot,
  );
  assert.equal(extraSnapshot.allowed, false);
  if (!extraSnapshot.allowed) assert.equal(extraSnapshot.code, "invalid_snapshot");
});
