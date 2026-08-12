import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createAgentProfile } from "../agent-profiles.js";
import { close, failNextCommitStoreMutationPersistenceForTests, flush, getStore, init } from "../db.js";
import { createProject, deleteProjectRegistration } from "../projects.js";
import { createSession } from "../sessions.js";
import { deleteAgentProfile } from "../agent-profiles.js";
import type { MessagingEndpointDeclaration, NormalizedMessagingInboundEvent } from "./contracts.js";
import {
  acceptMessagingEvent,
  acknowledgeMessagingDelivery,
  activateMessagingSession,
  admitMessagingTransactionManifest,
  bindMessagingConversation,
  claimNextDueMessagingDelivery,
  claimNextMessagingEvent,
  compactMessagingHistory,
  completeMessagingEventWithDeliveries,
  failMessagingDelivery,
  getMessagingEndpoint,
  getMessagingTransaction,
  listMessagingEndpoints,
  messagingDeclarationSha256,
  persistMessagingDeliveryAttestation,
  persistMessagingDeliveryRemoteProgress,
  reconcileMessagingEndpointDeclarations,
  recordMessagingEventDispatchSession,
  recoverPriorBootMessagingDeliveryClaims,
  refreshMessagingEventClaimBinding,
  requeueProcessingMessagingEvent,
  scheduleMessagingDeliveryRetry,
  withholdMessagingDeliveryGroup,
} from "./store.js";
import { MESSAGING_HISTORY_RETENTION_MS } from "./store-types.js";

function withStore(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-messaging-store-"));
  const prior = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  close();
  try {
    init();
    fn(dir);
  } finally {
    close();
    if (prior === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fixture(dir: string) {
  const projectRoot = path.join(dir, "project");
  fs.mkdirSync(projectRoot);
  const profile = createAgentProfile({ name: "Messaging profile" });
  const project = createProject({ cwd: projectRoot, default_agent_profile_id: profile.id });
  const declaration: MessagingEndpointDeclaration = {
    endpointId: "matrix-project-agent",
    connectorId: "matrix",
    provisioningKey: "project-agent",
    projectId: project.id,
    agentProfileId: profile.id,
    displayName: "Project Agent",
    conversationMode: "shared",
    allowedSubjectIds: ["@alice:example.test"],
    transportSecurity: "unencrypted_accepted",
  };
  return { projectRoot, profile, project, declaration };
}

function event(overrides: Partial<NormalizedMessagingInboundEvent> = {}): NormalizedMessagingInboundEvent {
  return {
    connectorId: "matrix",
    connectorEventId: "$event-1:example.test",
    externalConversationId: "!room:example.test",
    senderSubjectId: "@alice:example.test",
    body: "hello from matrix",
    occurredAt: 10,
    ...overrides,
  };
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function admission(
  declaration: MessagingEndpointDeclaration,
  digest: string,
  inbound = event(),
  acceptedAt = Date.now(),
) {
  return {
    endpointId: declaration.endpointId,
    declarationSha256: digest,
    declaration,
    participantSnapshot: {
      connectorId: declaration.connectorId,
      externalConversationId: inbound.externalConversationId,
      senderSubjectId: inbound.senderSubjectId,
      joinedHumanSubjectIds: [inbound.senderSubjectId],
      complete: true as const,
      observedAt: acceptedAt,
      revision: `membership-${acceptedAt}`,
      confidentiality: "server_visible" as const,
    },
    event: inbound,
  };
}

function accept(
  declaration: MessagingEndpointDeclaration,
  digest: string,
  inbound = event(),
  acceptedAt = Date.now(),
) {
  return acceptMessagingEvent({ ...admission(declaration, digest, inbound, acceptedAt), acceptedAt });
}

function provision(declaration: MessagingEndpointDeclaration) {
  const [created] = reconcileMessagingEndpointDeclarations([declaration], 100);
  assert.ok(created);
  const digest = messagingDeclarationSha256(declaration);
  const bound = bindMessagingConversation({
    endpointId: declaration.endpointId,
    declarationSha256: digest,
    expectedRevision: created.revision,
    externalConversationId: "!room:example.test",
    now: 101,
  });
  return { digest, bound };
}

test("declaration reconciliation and conversation/session binding use exact revision CAS", () => withStore((dir) => {
  const f = fixture(dir);
  const { digest, bound } = provision(f.declaration);
  assert.equal(bound.revision, 2);
  assert.equal(bound.external_conversation_id, "!room:example.test");
  assert.throws(() => bindMessagingConversation({
    endpointId: f.declaration.endpointId,
    declarationSha256: digest,
    expectedRevision: 1,
    externalConversationId: "!room:example.test",
  }), /revision conflict/);

  const eligible = createSession(f.projectRoot, { agentProfileId: f.profile.id, title: "eligible" });
  const otherProfile = createAgentProfile({ name: "Other profile" });
  const wrongProfile = createSession(f.projectRoot, { agentProfileId: otherProfile.id, title: "wrong" });
  assert.throws(() => activateMessagingSession({
    endpointId: f.declaration.endpointId,
    declarationSha256: digest,
    expectedRevision: bound.revision,
    sessionId: wrongProfile.id,
  }), /not eligible/);

  const activated = activateMessagingSession({
    endpointId: f.declaration.endpointId,
    declarationSha256: digest,
    expectedRevision: bound.revision,
    sessionId: eligible.id,
    now: 102,
  });
  assert.equal(activated.active_session_id, eligible.id);
  assert.equal(activated.revision, 3);

  const storedEligible = getStore().sessions.find((row) => row.id === eligible.id)!;
  storedEligible.project_id = null;
  storedEligible.legacy_capability_ineligible = true;
  assert.throws(() => flush(), /ineligible active messaging session binding/);
  storedEligible.project_id = f.project.id;
  storedEligible.legacy_capability_ineligible = false;
  flush();

  const changed = { ...f.declaration, allowedSubjectIds: ["@alice:example.test", "@bob:example.test"] };
  const [reconciled] = reconcileMessagingEndpointDeclarations([changed], 103);
  assert.equal(reconciled?.revision, 4);
  assert.notEqual(reconciled?.declaration_sha256, digest);
  assert.equal(getMessagingEndpoint("missing"), undefined);
  assert.equal(listMessagingEndpoints().length, 1);
}));

test("reconciliation rejects omitted historical Project/Profile owners and duplicate bound conversations", () => withStore((dir) => {
  const f = fixture(dir);
  provision(f.declaration);
  const conflictingPair = {
    ...f.declaration,
    endpointId: "matrix-project-agent-replacement",
    provisioningKey: "replacement",
  };
  assert.throws(() => reconcileMessagingEndpointDeclarations([conflictingPair]), /already owned by another endpoint/);

  const otherProfile = createAgentProfile({ name: "Conversation conflict profile" });
  const otherDeclaration: MessagingEndpointDeclaration = {
    ...f.declaration,
    endpointId: "matrix-other-agent",
    provisioningKey: "other-agent",
    agentProfileId: otherProfile.id,
  };
  const [other] = reconcileMessagingEndpointDeclarations([otherDeclaration]);
  assert.ok(other);
  assert.throws(() => bindMessagingConversation({
    endpointId: otherDeclaration.endpointId,
    declarationSha256: messagingDeclarationSha256(otherDeclaration),
    expectedRevision: other.revision,
    externalConversationId: "!room:example.test",
  }), /already bound to another endpoint/);
}));

test("reverse validation rejects persisted duplicate authorities and terminal events without outbox", () => withStore((dir) => {
  const f = fixture(dir);
  const { digest } = provision(f.declaration);
  const first = getStore().messagingEndpoints[0]!;
  getStore().messagingEndpoints.push({
    ...structuredClone(first),
    endpoint_id: "corrupt-pair",
    provisioning_key: "corrupt-pair",
  });
  assert.throws(() => flush(), /duplicate messaging Project\/Profile pairs/);
  getStore().messagingEndpoints.pop();

  const otherProfile = createAgentProfile({ name: "Persisted conversation conflict profile" });
  const otherDeclaration: MessagingEndpointDeclaration = {
    ...f.declaration,
    endpointId: "matrix-persisted-conflict",
    provisioningKey: "persisted-conflict",
    agentProfileId: otherProfile.id,
  };
  reconcileMessagingEndpointDeclarations([otherDeclaration]);
  const other = getStore().messagingEndpoints.find((row) => row.endpoint_id === otherDeclaration.endpointId)!;
  other.external_conversation_id = "!room:example.test";
  assert.throws(() => flush(), /duplicate bound messaging conversations/);
  other.external_conversation_id = null;
  flush();

  const accepted = accept(f.declaration, digest, event(), 200).row;
  claimNextMessagingEvent({ endpointId: f.declaration.endpointId, declarationSha256: digest });
  const persistedEvent = getStore().messagingEvents.find((row) => row.connector_event_id === accepted.connector_event_id)!;
  persistedEvent.state = "completed";
  persistedEvent.completed_at = 201;
  assert.throws(() => flush(), /malformed messaging event/);
  persistedEvent.state = "processing";
  persistedEvent.completed_at = null;
  flush();
}));

test("event admission and atomic exact transaction manifests are idempotent but collision-detecting", () => withStore((dir) => {
  const f = fixture(dir);
  const { digest } = provision(f.declaration);
  const first = accept(f.declaration, digest, event(), 200);
  assert.equal(first.duplicate, false);
  assert.equal(first.row.acceptance_sequence, 1);
  const retry = accept(f.declaration, digest, event(), 201);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.row.accepted_at, 200);
  const timestampOnlyRetry = accept(f.declaration, digest, event({ occurredAt: 999 }), 202);
  assert.equal(timestampOnlyRetry.duplicate, true, "connector timestamps are audit metadata, not immutable identity");
  assert.equal(timestampOnlyRetry.row.occurred_at, 10, "the original admitted audit timestamp remains durable");
  assert.throws(() => accept(f.declaration, digest, event({ body: "different immutable body" })), /identity was reused/);

  const children = [
    admission(f.declaration, digest, event({ connectorEventId: "$transaction-a" }), 202),
    admission(f.declaration, digest, event({ connectorEventId: "$transaction-b", body: "second" }), 202),
  ];
  const tx = admitMessagingTransactionManifest({
    connectorId: "matrix", transactionId: "txn-1", canonicalTransactionSha256: sha("batch"), children, acceptedAt: 202,
  });
  assert.equal(tx.duplicate, false);
  assert.equal(tx.transaction.state, "completed");
  assert.deepEqual(tx.transaction.child_manifest.map((entry) => entry.connector_event_id), ["$transaction-a", "$transaction-b"]);
  assert.equal(getStore().messagingEvents.length, 3);

  const duplicate = admitMessagingTransactionManifest({
    connectorId: "matrix", transactionId: "txn-1", canonicalTransactionSha256: sha("batch"),
    children: children.map((child) => ({ ...child, event: { ...child.event, occurredAt: child.event.occurredAt + 1_000 } })),
    acceptedAt: 203,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(getStore().messagingEvents.length, 3);
  assert.throws(() => admitMessagingTransactionManifest({
    connectorId: "matrix", transactionId: "txn-1", canonicalTransactionSha256: sha("batch"),
    children: [children[1]!, children[0]!],
  }), /different exact content/);
  assert.throws(() => admitMessagingTransactionManifest({
    connectorId: "matrix", transactionId: "txn-1", canonicalTransactionSha256: sha("changed"), children,
  }), /different exact content/);
  close();
  init();
  assert.deepEqual(
    getStore().messagingTransactions[0]?.child_manifest.map((entry) => entry.connector_event_id),
    ["$transaction-a", "$transaction-b"],
  );
}));

test("completed transaction lookup supports policy-independent duplicate short-circuit without weakening collision checks", () => withStore((dir) => {
  const f = fixture(dir);
  const { digest } = provision(f.declaration);
  const transactionHash = sha("lookup-batch");
  const children = [admission(f.declaration, digest, event({ connectorEventId: "$lookup-child" }), 210)];
  admitMessagingTransactionManifest({
    connectorId: "matrix",
    transactionId: "lookup-transaction",
    canonicalTransactionSha256: transactionHash,
    children,
    acceptedAt: 210,
  });

  const changedDeclaration: MessagingEndpointDeclaration = {
    ...f.declaration,
    allowedSubjectIds: ["@alice:example.test", "@bob:example.test"],
  };
  reconcileMessagingEndpointDeclarations([changedDeclaration], 211);

  const completed = getMessagingTransaction("matrix", "lookup-transaction");
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.canonical_transaction_sha256, transactionHash);
  assert.deepEqual(completed?.child_manifest.map((entry) => entry.connector_event_id), ["$lookup-child"]);
  assert.equal(getMessagingTransaction("matrix", "missing"), undefined);

  completed!.child_manifest.splice(0);
  assert.equal(getMessagingTransaction("matrix", "lookup-transaction")?.child_manifest.length, 1,
    "lookup must not expose mutable durable transaction state");

  assert.throws(() => admitMessagingTransactionManifest({
    connectorId: "matrix",
    transactionId: "lookup-transaction",
    canonicalTransactionSha256: sha("colliding-batch"),
    children,
  }), /different exact content/);
}));

test("durable admission revalidates and preserves exact participant attestation evidence", () => withStore((dir) => {
  const f = fixture(dir);
  const { digest } = provision(f.declaration);
  const inbound = event();
  assert.throws(() => acceptMessagingEvent({
    endpointId: f.declaration.endpointId,
    declarationSha256: digest,
    declaration: f.declaration,
    participantSnapshot: {
      connectorId: "matrix",
      externalConversationId: inbound.externalConversationId,
      senderSubjectId: inbound.senderSubjectId,
      joinedHumanSubjectIds: [inbound.senderSubjectId, "@mallory:example.test"],
      complete: true,
      observedAt: 250,
      revision: "membership-blocked",
      confidentiality: "server_visible",
    },
    event: inbound,
    acceptedAt: 250,
  }), /unexpected human/);
  assert.equal(getStore().messagingEvents.length, 0);
  const admitted = accept(f.declaration, digest, inbound, 251).row;
  assert.equal(admitted.endpoint_revision_at_admission, 2);
  assert.deepEqual(admitted.attested_human_subject_ids, ["@alice:example.test"]);
  assert.match(admitted.attestation_sha256, /^[a-f0-9]{64}$/u);
}));

test("claim head-of-line and generation CAS fence concurrent and stale workers", () => withStore((dir) => {
  const f = fixture(dir);
  const { digest, bound } = provision(f.declaration);
  const session = createSession(f.projectRoot, { agentProfileId: f.profile.id });
  activateMessagingSession({
    endpointId: f.declaration.endpointId, declarationSha256: digest,
    expectedRevision: bound.revision, sessionId: session.id,
  });
  const first = accept(f.declaration, digest, event({ connectorEventId: "$first" })).row;
  accept(f.declaration, digest, event({ connectorEventId: "$second" }));
  const claimA = claimNextMessagingEvent({ endpointId: f.declaration.endpointId, declarationSha256: digest })!;
  assert.equal(claimA.connector_event_id, "$first");
  assert.equal(claimNextMessagingEvent({ endpointId: f.declaration.endpointId, declarationSha256: digest }), null);
  requeueProcessingMessagingEvent({
    connectorId: first.connector_id, connectorEventId: first.connector_event_id,
    canonicalEventSha256: first.canonical_event_sha256, claimId: claimA.claim_id!,
  });
  const claimB = claimNextMessagingEvent({ endpointId: f.declaration.endpointId, declarationSha256: digest })!;
  assert.notEqual(claimB.claim_id, claimA.claim_id);
  assert.equal(claimB.claim_attempt, 2);
  assert.throws(() => completeMessagingEventWithDeliveries({
    connectorId: first.connector_id, connectorEventId: first.connector_event_id,
    canonicalEventSha256: first.canonical_event_sha256, claimId: claimA.claim_id!, sessionId: session.id,
    payloads: [{ kind: "final", text: "stale" }],
  }), /claim is stale/);
  completeMessagingEventWithDeliveries({
    connectorId: first.connector_id, connectorEventId: first.connector_event_id,
    canonicalEventSha256: first.canonical_event_sha256, claimId: claimB.claim_id!, sessionId: session.id,
    payloads: [{ kind: "final", text: "current" }],
  });
  assert.equal(claimNextMessagingEvent({ endpointId: f.declaration.endpointId, declarationSha256: digest })?.connector_event_id, "$second");
}));

test("origin session survives claim refresh and failed handoff persistence across restart", () => withStore((dir) => {
  const f = fixture(dir);
  const { digest, bound } = provision(f.declaration);
  const originSession = createSession(f.projectRoot, { agentProfileId: f.profile.id });
  const firstActivation = activateMessagingSession({
    endpointId: f.declaration.endpointId, declarationSha256: digest,
    expectedRevision: bound.revision, sessionId: originSession.id,
  });
  const accepted = accept(f.declaration, digest).row;
  const claim = claimNextMessagingEvent({ endpointId: f.declaration.endpointId, declarationSha256: digest })!;
  recordMessagingEventDispatchSession({
    connectorId: accepted.connector_id, connectorEventId: accepted.connector_event_id,
    canonicalEventSha256: accepted.canonical_event_sha256, claimId: claim.claim_id!, sessionId: originSession.id,
  });
  const currentSession = createSession(f.projectRoot, { agentProfileId: f.profile.id });
  const secondActivation = activateMessagingSession({
    endpointId: f.declaration.endpointId, declarationSha256: digest,
    expectedRevision: firstActivation.revision, sessionId: currentSession.id,
  });
  refreshMessagingEventClaimBinding({
    connectorId: accepted.connector_id, connectorEventId: accepted.connector_event_id,
    canonicalEventSha256: accepted.canonical_event_sha256, claimId: claim.claim_id!,
    expectedEndpointRevision: secondActivation.revision,
  });
  failNextCommitStoreMutationPersistenceForTests();
  assert.throws(() => completeMessagingEventWithDeliveries({
    connectorId: accepted.connector_id, connectorEventId: accepted.connector_event_id,
    canonicalEventSha256: accepted.canonical_event_sha256, claimId: claim.claim_id!,
    sessionId: currentSession.id, eventState: "failed", errorCode: "turn_failed",
    payloads: [{ kind: "continue_in_wayang", session_id: originSession.id, reason_code: "browser_handoff_required" }],
  }), /Synthetic store persistence failure/);
  assert.equal(getStore().messagingEvents[0]?.wayang_session_id, originSession.id);
  assert.equal(getStore().messagingEvents[0]?.claim_session_id, currentSession.id);
  close();
  init();
  assert.equal(getStore().messagingEvents[0]?.wayang_session_id, originSession.id);
  assert.equal(getStore().messagingEvents[0]?.state, "processing");
}));

test("claim, recovery requeue, and atomic completion preserve one ordered work item", () => withStore((dir) => {
  const f = fixture(dir);
  const { digest, bound } = provision(f.declaration);
  const session = createSession(f.projectRoot, { agentProfileId: f.profile.id });
  const activated = activateMessagingSession({
    endpointId: f.declaration.endpointId, declarationSha256: digest, expectedRevision: bound.revision, sessionId: session.id,
  });
  assert.equal(activated.active_session_id, session.id);
  const accepted = accept(f.declaration, digest).row;
  const claim = claimNextMessagingEvent({ endpointId: f.declaration.endpointId, declarationSha256: digest });
  assert.equal(claim?.state, "processing");
  assert.equal(claimNextMessagingEvent({ endpointId: f.declaration.endpointId, declarationSha256: digest }), null);

  const requeued = requeueProcessingMessagingEvent({
    connectorId: accepted.connector_id, connectorEventId: accepted.connector_event_id,
    canonicalEventSha256: accepted.canonical_event_sha256, claimId: claim!.claim_id!,
  });
  assert.equal(requeued.state, "accepted");
  const reclaimed = claimNextMessagingEvent({ endpointId: f.declaration.endpointId, declarationSha256: digest });
  assert.equal(reclaimed?.acceptance_sequence, accepted.acceptance_sequence);

  const completed = completeMessagingEventWithDeliveries({
    connectorId: accepted.connector_id,
    connectorEventId: accepted.connector_event_id,
    canonicalEventSha256: accepted.canonical_event_sha256,
    claimId: reclaimed!.claim_id!,
    sessionId: session.id,
    deliveryGroupId: "delivery-group-1",
    payloads: [{ kind: "final", text: "final answer" }, { kind: "notice", text: "second chunk" }],
    now: 300,
  });
  assert.equal(completed.event.state, "completed");
  assert.equal(completed.event.delivery_id, "delivery-group-1");
  assert.deepEqual(completed.deliveries.map((row) => row.chunk_index), [0, 1]);
  assert.equal(getStore().messagingDeliveries.length, 2);

  close();
  init();
  assert.equal(getStore().messagingEvents[0]?.state, "completed");
  assert.equal(getStore().messagingDeliveries.length, 2);
}));

test("delivery claims persist exact send authority, fence boots, recover, retry, ack, fail, and withhold in order", () => withStore((dir) => {
  const f = fixture(dir);
  const { digest, bound } = provision(f.declaration);
  const session = createSession(f.projectRoot, { agentProfileId: f.profile.id });
  activateMessagingSession({
    endpointId: f.declaration.endpointId, declarationSha256: digest,
    expectedRevision: bound.revision, sessionId: session.id, now: 290,
  });
  const accepted = accept(f.declaration, digest, event(), 291).row;
  const eventClaim = claimNextMessagingEvent({ endpointId: f.declaration.endpointId, declarationSha256: digest })!;
  const completed = completeMessagingEventWithDeliveries({
    connectorId: accepted.connector_id, connectorEventId: accepted.connector_event_id,
    canonicalEventSha256: accepted.canonical_event_sha256, claimId: eventClaim.claim_id!, sessionId: session.id,
    deliveryGroupId: "durable-delivery-group",
    payloads: [{ kind: "final", text: "first" }, { kind: "notice", text: "second" }], now: 300,
  });

  const firstClaim = claimNextDueMessagingDelivery({ connectorId: "matrix", workerBootId: "boot-a", now: 300 })!;
  assert.equal(firstClaim.id, completed.deliveries[0]!.id);
  assert.equal(claimNextDueMessagingDelivery({ connectorId: "matrix", workerBootId: "boot-a", now: 300 }), null);
  const outboundSnapshot = (observedAt: number) => ({
    connectorId: "matrix",
    externalConversationId: "!room:example.test",
    joinedHumanSubjectIds: ["@alice:example.test"],
    complete: true as const,
    observedAt,
    revision: `outbound-membership-${observedAt}`,
    confidentiality: "server_visible" as const,
  });
  persistMessagingDeliveryAttestation({
    deliveryId: firstClaim.id, claimId: firstClaim.claim_id!, claimGeneration: firstClaim.claim_generation,
    workerBootId: "boot-a", payloadSha256: firstClaim.payload_sha256,
    declarationSha256: digest, declaration: f.declaration,
    participantSnapshot: outboundSnapshot(300), connectorTransactionIds: ["stable-send-1"], now: 300,
  });
  scheduleMessagingDeliveryRetry({
    deliveryId: firstClaim.id, claimId: firstClaim.claim_id!, claimGeneration: firstClaim.claim_generation,
    workerBootId: "boot-a", errorCode: "transport_error", nextAttemptAt: 400, now: 301,
  });
  assert.equal(claimNextDueMessagingDelivery({ connectorId: "matrix", workerBootId: "boot-a", now: 399 }), null);
  const retryClaim = claimNextDueMessagingDelivery({ connectorId: "matrix", workerBootId: "boot-a", now: 400 })!;
  assert.equal(retryClaim.claim_generation, 2);
  assert.throws(() => persistMessagingDeliveryAttestation({
    deliveryId: retryClaim.id, claimId: retryClaim.claim_id!, claimGeneration: retryClaim.claim_generation,
    workerBootId: "boot-a", payloadSha256: retryClaim.payload_sha256,
    declarationSha256: digest, declaration: f.declaration,
    participantSnapshot: outboundSnapshot(400), connectorTransactionIds: ["changed-send-id"], now: 400,
  }), /changed across retry/);
  const retryAttested = persistMessagingDeliveryAttestation({
    deliveryId: retryClaim.id, claimId: retryClaim.claim_id!, claimGeneration: retryClaim.claim_generation,
    workerBootId: "boot-a", payloadSha256: retryClaim.payload_sha256,
    declarationSha256: digest, declaration: f.declaration,
    participantSnapshot: outboundSnapshot(400), connectorTransactionIds: ["stable-send-1"], now: 400,
  });
  assert.deepEqual(retryAttested.connector_transaction_ids, ["stable-send-1"]);
  const progressed = persistMessagingDeliveryRemoteProgress({
    deliveryId: retryClaim.id, claimId: retryClaim.claim_id!, claimGeneration: retryClaim.claim_generation,
    workerBootId: "boot-a", connectorTransactionId: "stable-send-1",
    remoteDeliveryId: "$remote-1", expectedSubchunkIndex: 0, now: 400,
  });
  assert.deepEqual(progressed.remote_delivery_ids, ["$remote-1"]);

  failNextCommitStoreMutationPersistenceForTests();
  assert.throws(() => acknowledgeMessagingDelivery({
    deliveryId: retryClaim.id, claimId: retryClaim.claim_id!, claimGeneration: retryClaim.claim_generation,
    workerBootId: "boot-a", connectorTransactionIds: ["stable-send-1"], remoteDeliveryIds: ["$remote-1"], now: 401,
  }), /Synthetic store persistence failure/);
  assert.equal(getStore().messagingDeliveries[0]?.state, "delivering");
  assert.deepEqual(getStore().messagingDeliveries[0]?.connector_transaction_ids, ["stable-send-1"]);
  assert.deepEqual(getStore().messagingDeliveries[0]?.remote_delivery_ids, ["$remote-1"]);
  assert.deepEqual(recoverPriorBootMessagingDeliveryClaims({ connectorId: "matrix", workerBootId: "boot-a", now: 402 }), []);

  close();
  init();
  const recovered = recoverPriorBootMessagingDeliveryClaims({ connectorId: "matrix", workerBootId: "boot-b", now: 403 });
  assert.equal(recovered.length, 1);
  const restartClaim = claimNextDueMessagingDelivery({ connectorId: "matrix", workerBootId: "boot-b", now: 403 })!;
  assert.equal(restartClaim.claim_generation, 3);
  assert.deepEqual(restartClaim.remote_delivery_ids, ["$remote-1"], "restart must not resend a durably acknowledged subchunk");
  persistMessagingDeliveryAttestation({
    deliveryId: restartClaim.id, claimId: restartClaim.claim_id!, claimGeneration: restartClaim.claim_generation,
    workerBootId: "boot-b", payloadSha256: restartClaim.payload_sha256,
    declarationSha256: digest, declaration: f.declaration,
    participantSnapshot: outboundSnapshot(403), connectorTransactionIds: ["stable-send-1"], now: 403,
  });
  const delivered = acknowledgeMessagingDelivery({
    deliveryId: restartClaim.id, claimId: restartClaim.claim_id!, claimGeneration: restartClaim.claim_generation,
    workerBootId: "boot-b", connectorTransactionIds: ["stable-send-1"], remoteDeliveryIds: ["$remote-1"], now: 404,
  });
  assert.equal(delivered.state, "delivered");

  const secondClaim = claimNextDueMessagingDelivery({ connectorId: "matrix", workerBootId: "boot-b", now: 405 })!;
  const withheld = withholdMessagingDeliveryGroup({
    deliveryId: secondClaim.id, claimId: secondClaim.claim_id!, claimGeneration: secondClaim.claim_generation,
    workerBootId: "boot-b", errorCode: "authorization_changed", now: 405,
  });
  assert.deepEqual(withheld.map((row) => row.state), ["withheld"]);

  const secondAccepted = accept(f.declaration, digest, event({ connectorEventId: "$second-output" }), 406).row;
  const secondEventClaim = claimNextMessagingEvent({ endpointId: f.declaration.endpointId, declarationSha256: digest })!;
  completeMessagingEventWithDeliveries({
    connectorId: secondAccepted.connector_id, connectorEventId: secondAccepted.connector_event_id,
    canonicalEventSha256: secondAccepted.canonical_event_sha256, claimId: secondEventClaim.claim_id!, sessionId: session.id,
    payloads: [{ kind: "error", code: "delivery_failed" }], now: 407,
  });
  const failedClaim = claimNextDueMessagingDelivery({ connectorId: "matrix", workerBootId: "boot-b", now: 407 })!;
  persistMessagingDeliveryAttestation({
    deliveryId: failedClaim.id, claimId: failedClaim.claim_id!, claimGeneration: failedClaim.claim_generation,
    workerBootId: "boot-b", payloadSha256: failedClaim.payload_sha256,
    declarationSha256: digest, declaration: f.declaration,
    participantSnapshot: outboundSnapshot(407), connectorTransactionIds: ["stable-send-2"], now: 407,
  });
  assert.equal(failMessagingDelivery({
    deliveryId: failedClaim.id, claimId: failedClaim.claim_id!, claimGeneration: failedClaim.claim_generation,
    workerBootId: "boot-b", errorCode: "remote_rejected", now: 408,
  })[0]?.state, "failed");
}));

test("failed persistence publishes no partial endpoint, transaction, event, or delivery mutation", () => withStore((dir) => {
  const f = fixture(dir);
  failNextCommitStoreMutationPersistenceForTests();
  assert.throws(() => reconcileMessagingEndpointDeclarations([f.declaration]), /Synthetic store persistence failure/);
  assert.equal(getStore().messagingEndpoints.length, 0);

  const { digest, bound } = provision(f.declaration);
  failNextCommitStoreMutationPersistenceForTests();
  assert.throws(() => admitMessagingTransactionManifest({
    connectorId: "matrix",
    transactionId: "persistence-failed-transaction",
    canonicalTransactionSha256: sha("atomic-batch"),
    children: [admission(f.declaration, digest, event({ connectorEventId: "$atomic-child" }))],
  }), /Synthetic store persistence failure/);
  assert.equal(getStore().messagingTransactions.length, 0);
  assert.equal(getStore().messagingEvents.length, 0);

  const session = createSession(f.projectRoot, { agentProfileId: f.profile.id });
  activateMessagingSession({
    endpointId: f.declaration.endpointId, declarationSha256: digest, expectedRevision: bound.revision, sessionId: session.id,
  });
  const accepted = accept(f.declaration, digest).row;
  const claim = claimNextMessagingEvent({ endpointId: f.declaration.endpointId, declarationSha256: digest });
  failNextCommitStoreMutationPersistenceForTests();
  assert.throws(() => completeMessagingEventWithDeliveries({
    connectorId: accepted.connector_id,
    connectorEventId: accepted.connector_event_id,
    canonicalEventSha256: accepted.canonical_event_sha256,
    claimId: claim!.claim_id!,
    sessionId: session.id,
    payloads: [{ kind: "final", text: "must not leak" }],
  }), /Synthetic store persistence failure/);
  assert.equal(getStore().messagingEvents[0]?.state, "processing");
  assert.equal(getStore().messagingDeliveries.length, 0);
}));

test("graph-aware retention removes only expired completed transaction/event/delivery graphs", () => withStore((dir) => {
  const f = fixture(dir);
  const { digest } = provision(f.declaration);
  const old = 1_000;
  admitMessagingTransactionManifest({
    connectorId: "matrix", transactionId: "expired-txn", canonicalTransactionSha256: sha("expired-txn"),
    children: [admission(f.declaration, digest, event(), old)], acceptedAt: old,
  });
  const claimedEvent = claimNextMessagingEvent({ endpointId: f.declaration.endpointId, declarationSha256: digest })!;
  const completed = completeMessagingEventWithDeliveries({
    connectorId: "matrix", connectorEventId: claimedEvent.connector_event_id,
    canonicalEventSha256: claimedEvent.canonical_event_sha256, claimId: claimedEvent.claim_id!,
    sessionId: null, payloads: [{ kind: "notice", text: "done" }], now: old,
  });
  const claimedDelivery = claimNextDueMessagingDelivery({ connectorId: "matrix", workerBootId: "retention-boot", now: old })!;
  const transactionId = "wayang.retention";
  const attested = persistMessagingDeliveryAttestation({
    deliveryId: claimedDelivery.id, claimId: claimedDelivery.claim_id!, claimGeneration: claimedDelivery.claim_generation,
    workerBootId: "retention-boot", payloadSha256: claimedDelivery.payload_sha256,
    declarationSha256: digest, declaration: f.declaration,
    participantSnapshot: {
      connectorId: "matrix", externalConversationId: "!room:example.test",
      joinedHumanSubjectIds: ["@alice:example.test"], complete: true, observedAt: old,
      revision: "retention-membership", confidentiality: "server_visible",
    }, connectorTransactionIds: [transactionId], now: old,
  });
  const progressed = persistMessagingDeliveryRemoteProgress({
    deliveryId: attested.id, claimId: attested.claim_id!, claimGeneration: attested.claim_generation,
    workerBootId: "retention-boot", connectorTransactionId: transactionId,
    remoteDeliveryId: "$retained:example.test", expectedSubchunkIndex: 0, now: old,
  });
  acknowledgeMessagingDelivery({
    deliveryId: progressed.id, claimId: progressed.claim_id!, claimGeneration: progressed.claim_generation,
    workerBootId: "retention-boot", connectorTransactionIds: [transactionId],
    remoteDeliveryIds: ["$retained:example.test"], now: old,
  });
  assert.equal(completed.deliveries.length, 1);
  assert.deepEqual(compactMessagingHistory(old + MESSAGING_HISTORY_RETENTION_MS - 1), {
    transactions: 0, events: 0, deliveries: 0,
  });
  assert.deepEqual(compactMessagingHistory(old + MESSAGING_HISTORY_RETENTION_MS + 1), {
    transactions: 1, events: 1, deliveries: 1,
  });
  assert.equal(getStore().messagingTransactions.length, 0);
  assert.equal(getStore().messagingEvents.length, 0);
  assert.equal(getStore().messagingDeliveries.length, 0);
}));

test("Project and Profile deletion cannot transfer or orphan messaging endpoint authority", () => withStore((dir) => {
  const f = fixture(dir);
  provision(f.declaration);
  const replacement = createAgentProfile({ name: "Replacement" });
  assert.throws(() => deleteAgentProfile(f.profile.id, replacement.id), /messaging endpoints reference/);
  assert.throws(() => deleteProjectRegistration(f.project.id), /messaging_endpoints/);
  assert.equal(getMessagingEndpoint(f.declaration.endpointId)?.agent_profile_id, f.profile.id);
}));
