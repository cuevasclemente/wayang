import assert from "node:assert/strict";
import test from "node:test";
import type { MessagingEndpointDeclaration } from "../../contracts.js";
import { messagingDeclarationSha256 } from "../../store.js";
import type { MessagingDeliveryRow, MessagingEndpointRow } from "../../store-types.js";
import { deriveMatrixDeliveryTransactionId } from "./chunking.js";
import { MatrixDeliveryWorker, type MatrixDeliveryStorePort } from "./delivery-worker.js";
import type { MatrixNamespace } from "./identifiers.js";

const namespace: MatrixNamespace = { serverName: "example.test", senderLocalpart: "as", userPrefix: "u_", aliasPrefix: "r_" };
const declaration: MessagingEndpointDeclaration = {
  endpointId: "memory", connectorId: "matrix", provisioningKey: "memory", projectId: "project",
  agentProfileId: "profile", displayName: "Memory", conversationMode: "shared",
  allowedSubjectIds: ["@alice:example.test"], transportSecurity: "unencrypted_accepted",
};
const digest = messagingDeclarationSha256(declaration);

function delivery(): MessagingDeliveryRow {
  return {
    id: "delivery-1", delivery_group_id: "group-1", connector_id: "matrix", endpoint_id: "memory",
    external_conversation_id: "!room:example.test", connector_event_id: "$input:example.test",
    chunk_index: 0, chunk_count: 1,
    payload: { kind: "continue_in_wayang", session_id: "session/id", reason_code: "browser_handoff_required" },
    payload_sha256: "a".repeat(64), declaration_sha256: digest, state: "delivering", attempt_count: 1,
    claim_generation: 1, claim_id: "claim-1", worker_boot_id: "boot-1", claimed_at: 10,
    next_attempt_at: null, last_error_code: null, attestation_sha256: null, attestation_revision: null,
    attestation_observed_at: null, attestation_confidentiality: null, attested_human_subject_ids: [],
    connector_transaction_ids: [], remote_delivery_ids: [], created_at: 1, updated_at: 10,
    delivered_at: null, failed_at: null, withheld_at: null,
  };
}

function endpoint(): MessagingEndpointRow {
  return {
    endpoint_id: "memory", connector_id: "matrix", provisioning_key: "memory", project_id: "project",
    agent_profile_id: "profile", declaration_sha256: digest, external_conversation_id: "!room:example.test",
    active_session_id: "session/id", revision: 2, created_at: 1, updated_at: 2,
  };
}

test("delivery persists fresh authority before deterministic send and exact ack", async () => {
  const calls: string[] = [];
  let available: MessagingDeliveryRow | null = delivery();
  let sentBody = "";
  let sentTransaction = "";
  const store: MatrixDeliveryStorePort = {
    recoverPriorBoot() { calls.push("recover"); return []; },
    claimNextDue() { const row = available; available = null; calls.push("claim"); return row; },
    getEndpoint: endpoint,
    persistAttestation(input) {
      calls.push("persist"); assert.equal(input.participantSnapshot.observedAt, 10);
      return { ...delivery(), connector_transaction_ids: [...input.connectorTransactionIds], attestation_sha256: "b".repeat(64) };
    },
    persistRemoteProgress(input) {
      calls.push("progress");
      return { ...delivery(), connector_transaction_ids: [input.connectorTransactionId], remote_delivery_ids: [input.remoteDeliveryId] };
    },
    acknowledge(input) { calls.push("ack"); assert.deepEqual(input.remoteDeliveryIds, ["$remote:example.test"]); return { ...delivery(), state: "delivered" }; },
    retry() { throw new Error("unexpected retry"); },
    withhold() { throw new Error("unexpected withhold"); },
    fail() { throw new Error("unexpected fail"); },
  };
  const worker = new MatrixDeliveryWorker({
    declarations: [declaration], namespace, wayangBaseUrl: "https://wayang.test",
    client: { async sendText(_room, _sender, transactionId, body) {
      calls.push("send"); sentBody = body; sentTransaction = transactionId; return "$remote:example.test";
    } },
    attestations: { async attest() { return {
      connectorId: "matrix", externalConversationId: "!room:example.test",
      joinedHumanSubjectIds: ["@alice:example.test"], complete: true, observedAt: 10,
      revision: "membership-1", confidentiality: "server_visible",
    }; } },
    store, now: () => 10, bootId: () => "boot-1",
  });
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(calls, ["claim", "persist", "send", "progress", "ack"]);
  assert.equal(sentBody, "Continue in Wayang: https://wayang.test/sessions/session%2Fid");
  assert.equal(sentTransaction, deriveMatrixDeliveryTransactionId("delivery-1", 0, 0));
  await worker.close();
});

test("multi-subchunk delivery re-attests before each send and preserves a sent prefix on membership drift", async () => {
  let current: MessagingDeliveryRow = {
    ...delivery(), payload: { kind: "final", text: "x".repeat(180) }, payload_sha256: "c".repeat(64),
  };
  let claims = 0;
  let attestations = 0;
  let sends = 0;
  let withheldRemoteIds: readonly string[] = [];
  const store: MatrixDeliveryStorePort = {
    recoverPriorBoot() { return []; },
    claimNextDue() { return claims++ === 0 ? structuredClone(current) : null; },
    getEndpoint: endpoint,
    persistAttestation(input) {
      current = {
        ...current, connector_transaction_ids: [...input.connectorTransactionIds],
        attestation_sha256: "d".repeat(64), attestation_revision: input.participantSnapshot.revision,
        attestation_observed_at: input.participantSnapshot.observedAt,
        attestation_confidentiality: "server_visible",
        attested_human_subject_ids: [...input.participantSnapshot.joinedHumanSubjectIds],
      };
      return structuredClone(current);
    },
    persistRemoteProgress(input) {
      assert.equal(input.expectedSubchunkIndex, current.remote_delivery_ids.length);
      current.remote_delivery_ids = [...current.remote_delivery_ids, input.remoteDeliveryId];
      return structuredClone(current);
    },
    acknowledge() { throw new Error("membership drift must prevent acknowledgement"); },
    retry() { throw new Error("membership drift must not retry transport"); },
    withhold() { withheldRemoteIds = [...current.remote_delivery_ids]; return [structuredClone(current)]; },
    fail() { throw new Error("membership drift must withhold"); },
  };
  const worker = new MatrixDeliveryWorker({
    declarations: [declaration], namespace, wayangBaseUrl: "https://wayang.test", chunkBytes: 64,
    client: { async sendText() { sends++; return `$remote-${sends}:example.test`; } },
    attestations: { async attest() {
      attestations++;
      return {
        connectorId: "matrix", externalConversationId: "!room:example.test",
        joinedHumanSubjectIds: attestations === 1 ? ["@alice:example.test"] : ["@alice:example.test", "@mallory:example.test"],
        complete: true, observedAt: 10, revision: `membership-${attestations}`, confidentiality: "server_visible",
      };
    } },
    store, now: () => 10, bootId: () => "boot-1",
  });
  assert.equal(await worker.runOnce(), true);
  assert.equal(attestations, 2);
  assert.equal(sends, 1);
  assert.equal(withheldRemoteIds.length, 1);
  assert.equal(worker.status().code, "policy_withheld");
  await worker.close();
});

test("startup recovers prior boot before its first claim", () => {
  const calls: string[] = [];
  const timers: Array<() => void> = [];
  const worker = new MatrixDeliveryWorker({
    declarations: [declaration], namespace, wayangBaseUrl: "https://wayang.test",
    client: { async sendText() { return "$remote:example.test"; } },
    attestations: { async attest() { throw new Error("unused"); } },
    store: {
      recoverPriorBoot() { calls.push("recover"); return []; }, claimNextDue() { calls.push("claim"); return null; },
      getEndpoint: endpoint, persistAttestation() { throw new Error(); }, persistRemoteProgress() { throw new Error(); },
      acknowledge() { throw new Error(); },
      retry() { throw new Error(); }, withhold() { throw new Error(); }, fail() { throw new Error(); },
    },
    timer: { setTimeout(callback) { timers.push(callback); return callback; }, clearTimeout() {} },
    bootId: () => "fresh-boot",
  });
  worker.start();
  assert.deepEqual(calls, ["recover"]);
  assert.equal(timers.length, 1);
});
