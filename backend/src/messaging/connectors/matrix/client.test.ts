import assert from "node:assert/strict";
import test from "node:test";
import { createMatrixAttestationAdapter } from "./attestation.js";
import { createMatrixCredentialAuthority } from "./auth.js";
import { chunkMatrixText, deriveMatrixDeliveryTransactionId, matrixHandoffUrl } from "./chunking.js";
import { createMatrixClient, MatrixClientError, type MatrixClient } from "./client.js";
import type { MatrixNamespace } from "./identifiers.js";

const namespace: MatrixNamespace = {
  serverName: "homeserver.invalid",
  senderLocalpart: "wayang_as",
  userPrefix: "wayang_user_",
  aliasPrefix: "wayang_room_",
};
const credentials = createMatrixCredentialAuthority(
  "synthetic-hs-token-not-secret",
  "synthetic-as-token-not-secret",
);

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), {
    ...init,
    status: init.status ?? 200,
    headers,
  });
}

test("injected-fetch client uses bearer headers, exact masquerading, bounded v3 paths, and no token URLs", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const injectedFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname.includes("/directory/room/")) return json({ room_id: "!room:homeserver.invalid" });
    if (url.pathname.endsWith("/createRoom")) return json({ room_id: "!room:homeserver.invalid" });
    if (url.pathname.includes("/join/")) return json({ room_id: "!room:homeserver.invalid" });
    if (url.pathname.endsWith("/joined_members")) return json({ joined: {
      "@alice:homeserver.invalid": { display_name: "Alice" },
      "@wayang_as:homeserver.invalid": {},
    } });
    if (url.pathname.endsWith("/state/m.room.encryption/")) return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
    if (url.pathname.includes("/send/m.room.message/")) return json({ event_id: "$sent:homeserver.invalid" });
    return json({});
  };
  const client = createMatrixClient({
    homeserverOrigin: "https://homeserver.invalid",
    serverName: namespace.serverName,
    asTokenAuthorizer: credentials.asTokenAuthorizer,
    fetch: injectedFetch,
  });
  const persona = `@wayang_user_${"a".repeat(64)}:homeserver.invalid`;
  await client.registerApplicationServiceUser(persona);
  await client.setDisplayName(persona, "Memory Agent");
  assert.equal(await client.resolveRoomAlias(`#wayang_room_${"b".repeat(64)}:homeserver.invalid`, persona), "!room:homeserver.invalid");
  assert.equal(await client.createPrivateRoom({
    creatorUserId: persona,
    canonicalAlias: `#wayang_room_${"b".repeat(64)}:homeserver.invalid`,
    name: "Memory Agent",
  }), "!room:homeserver.invalid");
  await client.inviteUser("!room:homeserver.invalid", persona, "@alice:homeserver.invalid");
  assert.equal(await client.joinRoom("!room:homeserver.invalid", persona), "!room:homeserver.invalid");
  assert.deepEqual(await client.getJoinedMembers("!room:homeserver.invalid", persona), [
    "@alice:homeserver.invalid", "@wayang_as:homeserver.invalid",
  ]);
  assert.equal(await client.hasRoomEncryptionState("!room:homeserver.invalid", persona), false);
  await client.setTyping("!room:homeserver.invalid", persona, true, 5_000);
  await client.setTyping("!room:homeserver.invalid", persona, false, 5_000);
  assert.equal(await client.sendText(
    "!room:homeserver.invalid", persona, `wayang.${"c".repeat(64)}`, "synthetic response",
  ), "$sent:homeserver.invalid");

  assert.equal(calls.length, 11);
  for (const call of calls) {
    assert.equal(call.url.origin, "https://homeserver.invalid");
    assert.equal(call.url.searchParams.has("access_token"), false);
    assert.equal(call.url.searchParams.has("as_token"), false);
    assert.equal(new Headers(call.init?.headers).get("authorization"), "Bearer synthetic-as-token-not-secret");
  }
  assert.equal(calls[0]!.url.searchParams.has("user_id"), false, "AS registration uses its defined request body");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    type: "m.login.application_service",
    username: persona.slice(1, persona.indexOf(":")),
    inhibit_login: true,
  });
  for (const call of calls.slice(1)) assert.equal(call.url.searchParams.get("user_id"), persona);
});

test("client rejects remote cleartext origins before resolving fetch", () => {
  assert.throws(() => createMatrixClient({
    homeserverOrigin: "http://homeserver.invalid",
    serverName: namespace.serverName,
    asTokenAuthorizer: credentials.asTokenAuthorizer,
    fetch: async () => { throw new Error("must not run"); },
  }), /HTTPS or loopback HTTP/);
});

test("client bounds response bytes and sanitizes remote errors", async () => {
  const oversized: typeof fetch = async () => new Response("x".repeat(2048), {
    status: 200, headers: { "content-length": "2048" },
  });
  const client = createMatrixClient({
    homeserverOrigin: "https://homeserver.invalid",
    serverName: namespace.serverName,
    asTokenAuthorizer: credentials.asTokenAuthorizer,
    fetch: oversized,
    maxResponseBytes: 1024,
  });
  await assert.rejects(
    client.getJoinedMembers("!room:homeserver.invalid", "@wayang_user_test:homeserver.invalid"),
    (error: unknown) => error instanceof MatrixClientError && error.code === "response_too_large"
      && !error.message.includes("synthetic-as-token"),
  );
});

test("encryption lookup treats only exact 404 M_NOT_FOUND as absent", async () => {
  const client = createMatrixClient({
    homeserverOrigin: "https://homeserver.invalid",
    serverName: namespace.serverName,
    asTokenAuthorizer: credentials.asTokenAuthorizer,
    fetch: async () => json({ errcode: "M_UNRECOGNIZED" }, { status: 404 }),
  });
  await assert.rejects(
    client.hasRoomEncryptionState("!room:homeserver.invalid", "@wayang_user_test:homeserver.invalid"),
    (error: unknown) => error instanceof MatrixClientError && error.matrixErrcode === "M_UNRECOGNIZED",
  );
});

test("membership attestation excludes only exact AS namespaces and never claims E2EE", async () => {
  const joined = [
    "@alice:homeserver.invalid",
    "@remote:foreign.invalid",
    "@wayang_as:homeserver.invalid",
    "@wayang_user_virtual:homeserver.invalid",
    "@wayang_user_virtual:foreign.invalid",
  ];
  const mock = {
    async getJoinedMembers() { return joined; },
    async hasRoomEncryptionState() { return false; },
  } as unknown as MatrixClient;
  const adapter = createMatrixAttestationAdapter(mock, namespace);
  const clear = await adapter.attest({
    roomId: "!room:homeserver.invalid",
    senderUserId: "@alice:homeserver.invalid",
    actingUserId: "@wayang_user_virtual:homeserver.invalid",
    observedAt: 100,
  });
  assert.equal(clear.confidentiality, "server_visible");
  assert.deepEqual(clear.joinedHumanSubjectIds, [
    "@alice:homeserver.invalid", "@remote:foreign.invalid", "@wayang_user_virtual:foreign.invalid",
  ]);
  assert.match(clear.revision, /^[a-f0-9]{64}$/u);

  const encryptedMock = {
    async getJoinedMembers() { return joined; },
    async hasRoomEncryptionState() { return true; },
  } as unknown as MatrixClient;
  const encrypted = await createMatrixAttestationAdapter(encryptedMock, namespace).attest({
    roomId: "!room:homeserver.invalid",
    senderUserId: "@alice:homeserver.invalid",
    actingUserId: "@wayang_user_virtual:homeserver.invalid",
    observedAt: 101,
  });
  assert.equal(encrypted.confidentiality, "unknown");
  assert.notEqual(encrypted.revision, clear.revision);
});

test("chunking is deterministic, UTF-8/grapheme safe, paragraph-preferring, and retry IDs are stable", () => {
  const family = "👨‍👩‍👧‍👦";
  const source = `First paragraph ${family}.\n\nSecond paragraph with café and 日本語.\n\nThird paragraph.`;
  const chunks = chunkMatrixText(source, 64);
  assert.equal(chunks.join(""), source);
  assert.deepEqual(chunkMatrixText(source, 64), chunks);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, "utf8") <= 64);
    assert.equal(chunk.includes("👨‍👩‍👧") && !chunk.includes(family), false, "family emoji must not split");
  }
  const first = deriveMatrixDeliveryTransactionId("delivery-1", 2, 3);
  assert.equal(first, deriveMatrixDeliveryTransactionId("delivery-1", 2, 3));
  assert.notEqual(first, deriveMatrixDeliveryTransactionId("delivery-1", 2, 4));
  assert.match(first, /^wayang\.[a-f0-9]{64}$/u);
  assert.equal(
    matrixHandoffUrl("https://wayang.invalid", "session/id with spaces"),
    "https://wayang.invalid/sessions/session%2Fid%20with%20spaces",
  );
  assert.throws(() => matrixHandoffUrl("http://wayang.invalid", "session-id"), /Invalid Wayang handoff/);
  assert.equal(matrixHandoffUrl("http://127.0.0.1:3456", "session-id"), "http://127.0.0.1:3456/sessions/session-id");
});
