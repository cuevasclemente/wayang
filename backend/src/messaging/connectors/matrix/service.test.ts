import assert from "node:assert/strict";
import test from "node:test";
import type { MessagingEndpointDeclaration, MessagingParticipantSnapshot } from "../../contracts.js";
import { messagingDeclarationSha256 } from "../../store.js";
import type { MessagingEndpointRow } from "../../store-types.js";
import type { MatrixAttestationAdapter } from "./attestation.js";
import type { MatrixNamespace } from "./identifiers.js";
import { MatrixApplicationService, type MatrixGatewayTransactionPort } from "./service.js";

const namespace: MatrixNamespace = { serverName: "example.test", senderLocalpart: "as", userPrefix: "u_", aliasPrefix: "r_" };
const declaration: MessagingEndpointDeclaration = {
  endpointId: "memory", connectorId: "matrix", provisioningKey: "memory", projectId: "project",
  agentProfileId: "profile", displayName: "Memory", conversationMode: "shared",
  allowedSubjectIds: ["@alice:example.test"], transportSecurity: "unencrypted_accepted",
};
const endpoint: MessagingEndpointRow = {
  endpoint_id: "memory", connector_id: "matrix", provisioning_key: "memory", project_id: "project",
  agent_profile_id: "profile", declaration_sha256: messagingDeclarationSha256(declaration),
  external_conversation_id: "!room:example.test", active_session_id: null, revision: 2, created_at: 1, updated_at: 2,
};
function body(): Uint8Array {
  return Buffer.from(JSON.stringify({ events: [{
    event_id: "$event:example.test", room_id: "!room:example.test", sender: "@alice:example.test",
    origin_server_ts: 1_000, type: "m.room.message", content: { msgtype: "m.text", body: "hello" },
  }] }));
}

test("transaction ingestion fetches fresh attestations and returns after atomic admission, before drain", async () => {
  const order: string[] = [];
  let completed: { canonicalTransactionSha256: string } | null = null;
  const gateway: MatrixGatewayTransactionPort = {
    lookupCompletedTransaction() { return completed; },
    hasDurableEvent() { return false; },
    async admitTransaction(input) {
      order.push("admit");
      assert.equal(input.children.length, 1);
      completed = { canonicalTransactionSha256: input.canonicalTransactionSha256 };
      return { duplicate: false, endpointIds: ["memory"] };
    },
    scheduleEndpointDrain(endpointId) { order.push(`drain:${endpointId}`); },
    async start() { order.push("recover"); }, async close() {},
  };
  const snapshot: MessagingParticipantSnapshot = {
    connectorId: "matrix", externalConversationId: "!room:example.test", senderSubjectId: "@alice:example.test",
    joinedHumanSubjectIds: ["@alice:example.test"], complete: true, observedAt: 1_000,
    revision: "membership", confidentiality: "server_visible",
  };
  let attestations = 0;
  const service = new MatrixApplicationService({
    namespace, declarations: [declaration], gateway,
    attestations: { async attest() { attestations++; order.push("attest"); return snapshot; } } as MatrixAttestationAdapter,
    provisioning: {
      async ensurePersona() { return null; }, async ensureAlias() { return null; },
      declarationForPersona() { return undefined; }, declarationForAlias() { return undefined; },
    },
    endpoints: { list: () => [endpoint] }, now: () => 1_000,
  });
  await service.start();
  const first = await service.ingestTransaction("txn-1", body());
  assert.equal(first.duplicate, false);
  assert.deepEqual(order, ["recover", "attest", "admit", "drain:memory"]);
  const duplicate = await service.ingestTransaction("txn-1", body());
  assert.equal(duplicate.duplicate, true);
  assert.equal(attestations, 1);
});

test("unknown user and alias queries do not provision lookalikes", async () => {
  let provisions = 0;
  const gateway: MatrixGatewayTransactionPort = {
    lookupCompletedTransaction: () => null, hasDurableEvent: () => false,
    admitTransaction: () => ({ duplicate: false, endpointIds: [] }), scheduleEndpointDrain() {}, async start() {}, async close() {},
  };
  const service = new MatrixApplicationService({
    namespace, declarations: [declaration], gateway,
    attestations: {} as MatrixAttestationAdapter,
    provisioning: {
      async ensurePersona() { provisions++; return null; },
      async ensureAlias() { provisions++; return null; },
      declarationForPersona() { return undefined; }, declarationForAlias() { return undefined; },
    }, endpoints: { list: () => [endpoint] }, now: () => 1_000,
  });
  await service.start();
  await assert.rejects(service.queryUser("@lookalike:foreign.test"), /not managed/);
  await assert.rejects(service.queryAlias("#lookalike:foreign.test"), /not managed/);
  assert.equal(provisions, 0, "foreign-server identifiers fail before provisioning");
});
