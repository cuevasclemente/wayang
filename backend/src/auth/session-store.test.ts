import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionStore } from "./session-store.js";

function fixture(now: () => number, passwordHash = "password-record", sessionSecret = "s".repeat(32)) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-auth-store-"));
  const filePath = path.join(dataDir, "nested", "auth-sessions.json");
  const store = new SessionStore({ filePath, passwordHash, sessionSecret, sessionLifetimeMs: 1_000, now });
  return { dataDir, filePath, store };
}

test("session store persists only opaque hashes with POSIX-private permissions", (t) => {
  let clock = 1_000;
  const { dataDir, filePath, store } = fixture(() => clock);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const created = store.create();
  const contents = fs.readFileSync(filePath, "utf8");
  assert.equal(contents.includes(created.token), false);
  assert.equal(contents.includes("password-record"), false);
  assert.equal(store.verify(created.token), true);
  assert.equal(store.verify("not-the-token"), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
  }

  store.revoke(created.token);
  assert.equal(store.verify(created.token), false);
  clock += 2_000;
});

test("expired sessions and password or session-secret changes invalidate tokens", (t) => {
  let clock = 5_000;
  const { dataDir, filePath, store } = fixture(() => clock);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const created = store.create();

  const changedPassword = new SessionStore({
    filePath,
    passwordHash: "different-password-record",
    sessionSecret: "s".repeat(32),
    sessionLifetimeMs: 1_000,
    now: () => clock,
  });
  assert.equal(changedPassword.verify(created.token), false);

  // Recreate under the original fingerprint, then check a secret rotation.
  const next = store.create();
  const changedSecret = new SessionStore({
    filePath,
    passwordHash: "password-record",
    sessionSecret: "t".repeat(32),
    sessionLifetimeMs: 1_000,
    now: () => clock,
  });
  assert.equal(changedSecret.verify(next.token), false);

  const expiring = store.create();
  clock += 1_001;
  assert.equal(store.verify(expiring.token), false);
});
