import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadMatrixMessagingConfig, type MatrixConfigFileSystem } from "./config.js";

function document(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    matrix: {
      homeserverOrigin: "https://homeserver.invalid",
      serverName: "homeserver.invalid",
      applicationServiceId: "wayang",
      senderLocalpart: "wayang_as",
      userPrefix: "wayang_user_",
      aliasPrefix: "wayang_room_",
      hsToken: "synthetic-hs-token-not-secret",
      asToken: "synthetic-as-token-not-secret",
    },
    wayangBaseUrl: "https://wayang.invalid",
    endpoints: [{
      endpointId: "memory-agent",
      connectorId: "matrix",
      provisioningKey: "memory-agent",
      projectId: "11111111-1111-4111-8111-111111111111",
      agentProfileId: "22222222-2222-4222-8222-222222222222",
      displayName: "Memory Agent",
      conversationMode: "shared",
      allowedSubjectIds: ["@alice:homeserver.invalid"],
      transportSecurity: "unencrypted_accepted",
    }],
    ...overrides,
  };
}

function withPrivateConfig(value: unknown, fn: (filePath: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-matrix-config-"));
  const filePath = path.join(directory, "messaging.json");
  try {
    fs.writeFileSync(filePath, JSON.stringify(value), { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    fn(filePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("disabled Matrix configuration is inert and does not touch its path", () => {
  const unavailable = new Proxy({}, {
    get() { throw new Error("filesystem must remain inert"); },
  }) as MatrixConfigFileSystem;
  assert.deepEqual(loadMatrixMessagingConfig({
    WAYANG_MESSAGING_ENABLED: "0",
    WAYANG_MESSAGING_CONFIG_PATH: "/does/not/exist",
  }, { fileSystem: unavailable }), { enabled: false });
  assert.deepEqual(loadMatrixMessagingConfig({}, { fileSystem: unavailable }), { enabled: false });
});

test("loads an exact owner-private Matrix configuration without serializing tokens", () => withPrivateConfig(document(), (filePath) => {
  let authorized = false;
  const loaded = loadMatrixMessagingConfig({
    WAYANG_MESSAGING_ENABLED: "1",
    WAYANG_MESSAGING_CONFIG_PATH: filePath,
  }, {
    authorizeDeclarations(declarations) {
      authorized = declarations.length === 1;
    },
  });
  assert.equal(loaded.enabled, true);
  if (!loaded.enabled) return;
  assert.equal(loaded.homeserverOrigin, "https://homeserver.invalid");
  assert.equal(loaded.endpoints[0]?.connectorId, "matrix");
  assert.equal(authorized, true);
  const serialized = JSON.stringify(loaded);
  assert.equal(serialized.includes("synthetic-hs-token"), false);
  assert.equal(serialized.includes("synthetic-as-token"), false);
  assert.equal(loaded.hsTokenVerifier.verify("synthetic-hs-token-not-secret"), true);
  assert.equal(loaded.hsTokenVerifier.verify("wrong-synthetic-token"), false);
}));

test("rejects non-private files, symlinks, unknown schema fields, and namespace subjects", () => {
  withPrivateConfig(document(), (filePath) => {
    fs.chmodSync(filePath, 0o640);
    assert.throws(() => loadMatrixMessagingConfig({
      WAYANG_MESSAGING_ENABLED: "1", WAYANG_MESSAGING_CONFIG_PATH: filePath,
    }), /unsafe/);
  });
  withPrivateConfig(document(), (filePath) => {
    const link = `${filePath}.link`;
    fs.symlinkSync(filePath, link);
    assert.throws(() => loadMatrixMessagingConfig({
      WAYANG_MESSAGING_ENABLED: "1", WAYANG_MESSAGING_CONFIG_PATH: link,
    }), /canonical|unsafe/);
  });
  const insecureRemote = document();
  insecureRemote.matrix.homeserverOrigin = "http://homeserver.invalid";
  withPrivateConfig(insecureRemote, (filePath) => {
    assert.throws(() => loadMatrixMessagingConfig({
      WAYANG_MESSAGING_ENABLED: "1", WAYANG_MESSAGING_CONFIG_PATH: filePath,
    }), /homeserver origin/);
  });
  withPrivateConfig({ ...document(), surprise: true }, (filePath) => {
    assert.throws(() => loadMatrixMessagingConfig({
      WAYANG_MESSAGING_ENABLED: "1", WAYANG_MESSAGING_CONFIG_PATH: filePath,
    }), /unknown or missing/);
  });
  const managed = document();
  (managed.endpoints[0]!.allowedSubjectIds as string[]) = ["@wayang_user_intruder:homeserver.invalid"];
  withPrivateConfig(managed, (filePath) => {
    assert.throws(() => loadMatrixMessagingConfig({
      WAYANG_MESSAGING_ENABLED: "1", WAYANG_MESSAGING_CONFIG_PATH: filePath,
    }), /Application Service user/);
  });
});

test("rejects duplicate immutable Project/Profile pairs even with distinct endpoint identities", () => {
  const value = document();
  value.endpoints.push({
    ...value.endpoints[0]!, endpointId: "second", provisioningKey: "second",
  });
  withPrivateConfig(value, (filePath) => {
    assert.throws(() => loadMatrixMessagingConfig({
      WAYANG_MESSAGING_ENABLED: "1", WAYANG_MESSAGING_CONFIG_PATH: filePath,
    }), /Duplicate messaging endpoint for exact Project\/Profile pair/);
  });
});
