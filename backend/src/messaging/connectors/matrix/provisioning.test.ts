import assert from "node:assert/strict";
import test from "node:test";
import type { MessagingEndpointDeclaration } from "../../contracts.js";
import { messagingDeclarationSha256 } from "../../store.js";
import type { MessagingEndpointRow } from "../../store-types.js";
import { MatrixClientError, type MatrixClient } from "./client.js";
import { deriveMatrixCanonicalAlias, deriveMatrixPersonaUserId, type MatrixNamespace } from "./identifiers.js";
import { MatrixProvisioningService, type MatrixProvisioningStorePort } from "./provisioning.js";

const namespace: MatrixNamespace = { serverName: "example.test", senderLocalpart: "as", userPrefix: "u_", aliasPrefix: "r_" };
const declaration: MessagingEndpointDeclaration = {
  endpointId: "memory", connectorId: "matrix", provisioningKey: "memory", projectId: "project",
  agentProfileId: "profile", displayName: "Memory", conversationMode: "shared",
  allowedSubjectIds: ["@alice:example.test"], transportSecurity: "unencrypted_accepted",
};

function row(): MessagingEndpointRow {
  return {
    endpoint_id: "memory", connector_id: "matrix", provisioning_key: "memory", project_id: "project",
    agent_profile_id: "profile", declaration_sha256: messagingDeclarationSha256(declaration),
    external_conversation_id: null, active_session_id: null, revision: 1, created_at: 1, updated_at: 1,
  };
}

test("provisioning recovers ambiguous create and binds before connector membership effects", async () => {
  const calls: string[] = [];
  let membershipReads = 0;
  const persona = deriveMatrixPersonaUserId("profile", namespace);
  const alias = deriveMatrixCanonicalAlias("memory", namespace);
  const client = {
    async registerApplicationServiceUser() { calls.push("register"); throw new MatrixClientError("http_error", { status: 400, matrixErrcode: "M_USER_IN_USE" }); },
    async setDisplayName() { calls.push("profile"); },
    async resolveRoomAlias() { calls.push("resolve"); return "!room:example.test"; },
    async createPrivateRoom() { calls.push("create"); throw new MatrixClientError("timeout"); },
    async joinRoom() { calls.push("join"); return "!room:example.test"; },
    async inviteUser() { calls.push("invite"); },
    async getJoinedMembers() { calls.push("members"); return ++membershipReads === 1 ? [persona] : [persona, "@alice:example.test"]; },
    async hasRoomEncryptionState() { calls.push("encryption"); return false; },
  } as unknown as MatrixClient;
  let stored = row();
  const store: MatrixProvisioningStorePort = {
    getEndpoint: () => structuredClone(stored),
    bindConversation(input) {
      calls.push("bind");
      assert.equal(input.expectedRevision, 1);
      stored = { ...stored, external_conversation_id: input.externalConversationId, revision: 2 };
      return structuredClone(stored);
    },
  };
  const service = new MatrixProvisioningService({ namespace, declarations: [declaration], client, store, now: () => 10 });
  const result = await service.ensureEndpoint("memory");
  assert.equal(result.personaUserId, persona);
  assert.equal(result.canonicalAlias, alias);
  assert.equal(result.status.code, "ready");
  assert.ok(calls.indexOf("bind") < calls.indexOf("join"));
  assert.ok(calls.indexOf("bind") < calls.indexOf("invite"));
  assert.deepEqual(calls.slice(0, 5), ["register", "profile", "create", "resolve", "bind"]);
});

test("encrypted-required declarations remain blocked without homeserver effects", async () => {
  let calls = 0;
  const client = new Proxy({}, { get: () => async () => { calls++; } }) as unknown as MatrixClient;
  const encrypted = { ...declaration, transportSecurity: "encrypted_required" as const };
  const service = new MatrixProvisioningService({
    namespace, declarations: [encrypted], client,
    store: { getEndpoint: row, bindConversation: () => { throw new Error("must not bind"); } },
  });
  await assert.rejects(service.ensureEndpoint("memory"), /E2EE/);
  assert.equal(calls, 0);
  assert.equal(service.getStatus("memory").code, "encrypted_required");
});
