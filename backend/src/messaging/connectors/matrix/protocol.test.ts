import assert from "node:assert/strict";
import test from "node:test";
import { createMatrixCredentialAuthority, verifyMatrixInboundAuthorization } from "./auth.js";
import {
  assertDerivedMatrixCanonicalAlias,
  assertDerivedMatrixPersonaUserId,
  deriveMatrixCanonicalAlias,
  deriveMatrixPersonaUserId,
  isManagedMatrixUser,
  validateMatrixUserId,
  type MatrixNamespace,
} from "./identifiers.js";
import { filterMatrixEvent, parseMatrixTransaction } from "./events.js";

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

test("derives stable profile personas and provisioning aliases in the exact namespace", () => {
  const profileId = "22222222-2222-4222-8222-222222222222";
  const persona = deriveMatrixPersonaUserId(profileId, namespace);
  const alias = deriveMatrixCanonicalAlias("memory-agent", namespace);
  assert.match(persona, /^@wayang_user_[a-f0-9]{64}:homeserver\.invalid$/u);
  assert.match(alias, /^#wayang_room_[a-f0-9]{64}:homeserver\.invalid$/u);
  assert.equal(deriveMatrixPersonaUserId(profileId, namespace), persona);
  assert.equal(assertDerivedMatrixPersonaUserId(persona, profileId, namespace), persona);
  assert.equal(assertDerivedMatrixCanonicalAlias(alias, "memory-agent", namespace), alias);
  assert.equal(isManagedMatrixUser(persona, namespace), true);
  assert.equal(isManagedMatrixUser(persona.replace("homeserver.invalid", "foreign.invalid"), namespace), false);
  assert.throws(() => assertDerivedMatrixPersonaUserId(persona, "different-profile", namespace), /does not match/);
  assert.equal(validateMatrixUserId("@alice+phone/path:homeserver.invalid"), "@alice+phone/path:homeserver.invalid");
});

test("accepts one exact AS Bearer header and rejects ambiguity or query credentials", () => {
  assert.deepEqual(verifyMatrixInboundAuthorization({
    url: "/_matrix/app/v1/transactions/t1",
    authorization: "Bearer synthetic-hs-token-not-secret",
  }, credentials.hsTokenVerifier), { authorized: true });
  for (const request of [
    { url: "/_matrix/app/v1/transactions/t1" },
    { url: "/_matrix/app/v1/transactions/t1", authorization: ["Bearer synthetic-hs-token-not-secret", "Bearer other"] },
    { url: "/_matrix/app/v1/transactions/t1", authorization: "bearer synthetic-hs-token-not-secret" },
    { url: "/_matrix/app/v1/transactions/t1", authorization: "Bearer synthetic-hs-token-not-secret, Bearer other" },
    { url: "/_matrix/app/v1/transactions/t1?access_token=synthetic", authorization: "Bearer synthetic-hs-token-not-secret" },
    { url: "/_matrix/app/v1/transactions/t1?as_token=synthetic", authorization: "Bearer synthetic-hs-token-not-secret" },
    { url: "/_matrix/app/v1/transactions/t1", authorization: "Bearer wrong-synthetic-token" },
  ] as const) {
    assert.equal(verifyMatrixInboundAuthorization(request, credentials.hsTokenVerifier).authorized, false);
  }
});

function event(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "$event:homeserver.invalid",
    room_id: "!room:homeserver.invalid",
    sender: "@alice:homeserver.invalid",
    origin_server_ts: 1_800_000_000_000,
    type: "m.room.message",
    content: { msgtype: "m.text", body: "Hello Matrix" },
    ...overrides,
  };
}

const filterContext = { ...namespace, knownRoomIds: new Set(["!room:homeserver.invalid"]) };

test("strict transaction parsing is bounded, UTF-8 aware, and content-collision stable", () => {
  const body = Buffer.from(JSON.stringify({ events: [event()] }), "utf8");
  const parsed = parseMatrixTransaction("txn-1", body);
  assert.equal(parsed.events.length, 1);
  assert.match(parsed.canonicalSha256, /^[a-f0-9]{64}$/u);
  assert.equal(parseMatrixTransaction("txn-1", body).canonicalSha256, parsed.canonicalSha256);
  const changed = parseMatrixTransaction("txn-1", Buffer.from(JSON.stringify({
    events: [event({ content: { msgtype: "m.text", body: "changed" } })],
  })));
  assert.notEqual(changed.canonicalSha256, parsed.canonicalSha256);
  assert.throws(() => parseMatrixTransaction("txn-1", Buffer.from(JSON.stringify({ events: [], extra: true }))), /unknown fields/);
  assert.throws(() => parseMatrixTransaction("txn-1", Buffer.from('{"events":[],"events":[]}')), /strict UTF-8 JSON/);
  assert.throws(() => parseMatrixTransaction("txn-1", new Uint8Array([0xff, 0xfe])), /strict UTF-8/);
});

test("normalizes only unredacted m.room.message m.text and explicitly disposes every other path", () => {
  const accepted = filterMatrixEvent(event(), filterContext);
  assert.equal(accepted.code, "admissible_text");
  if (accepted.code === "admissible_text") {
    assert.deepEqual(accepted.event, {
      connectorId: "matrix",
      connectorEventId: "$event:homeserver.invalid",
      externalConversationId: "!room:homeserver.invalid",
      senderSubjectId: "@alice:homeserver.invalid",
      body: "Hello Matrix",
      occurredAt: 1_800_000_000_000,
    });
  }
  const reply = filterMatrixEvent(event({
    content: { msgtype: "m.text", body: "> quoted\n\nReply", "m.relates_to": { "m.in_reply_to": { event_id: "$prior" } } },
  }), filterContext);
  assert.equal(reply.code, "admissible_text");
  const cases: readonly [unknown, string][] = [
    [event({ room_id: "!unknown:homeserver.invalid" }), "unknown_room"],
    [event({ sender: "@wayang_as:homeserver.invalid" }), "self_echo"],
    [event({ sender: "@wayang_user_virtual:homeserver.invalid" }), "managed_sender"],
    [event({ type: "m.room.encrypted", content: { algorithm: "m.megolm.v1.aes-sha2" } }), "encrypted"],
    [event({ type: "m.reaction", content: {} }), "reaction"],
    [event({ type: "m.room.redaction", content: {} }), "redaction"],
    [event({ state_key: "", content: { msgtype: "m.text", body: "state" } }), "state_event"],
    [event({ unsigned: { redacted_because: {} } }), "redacted"],
    [event({ content: { msgtype: "m.text", body: "edited", "m.relates_to": { rel_type: "m.replace" } } }), "edit"],
    [event({ content: { msgtype: "m.notice", body: "notice" } }), "unsupported_message"],
    [event({ type: "m.room.topic", content: { topic: "topic" } }), "unsupported_event"],
    [{ malformed: true }, "malformed"],
  ];
  for (const [input, code] of cases) assert.equal(filterMatrixEvent(input, filterContext).code, code);
});
