import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPasswordHash, isLoopbackHost, normalizePublicOrigin, parseEnv, updateEnv, writePrivateAtomic } from "../lib/config.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("strict parser treats shell syntax as inert text", () => {
  const marker = join(tmpdir(), `wayang-env-marker-${process.pid}`);
  const parsed = parseEnv(`SAFE=\"hello world\"\nDANGEROUS=$(touch ${marker})\n`);
  assert.equal(parsed.values.get("SAFE"), "hello world");
  assert.equal(parsed.values.get("DANGEROUS"), `$(touch ${marker})`);
  assert.throws(() => statSync(marker));
});

test("updates preserve comments and unknown values without exposing them", () => {
  const source = "# retained\nUNKNOWN=\"private-value\"\nWAYANG_PORT=\"8787\"\n";
  const updated = updateEnv(source, { WAYANG_PORT: "9000", WAYANG_HOST: "127.0.0.1" });
  assert.match(updated, /^# retained/m);
  assert.match(updated, /^UNKNOWN="private-value"$/m);
  assert.equal(parseEnv(updated).values.get("WAYANG_PORT"), "9000");
  assert.equal(parseEnv(updated).values.get("WAYANG_HOST"), "127.0.0.1");
});

test("atomic writer replaces the destination with mode 0600", () => {
  const directory = mkdtempSync(join(tmpdir(), "wayang-config-test-"));
  const file = join(directory, ".env");
  writePrivateAtomic(file, "WAYANG_PORT=\"8787\"\n");
  writePrivateAtomic(file, "WAYANG_PORT=\"9000\"\n");
  assert.equal(readFileSync(file, "utf8"), "WAYANG_PORT=\"9000\"\n");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("password records match the backend scrypt contract", async () => {
  const record = await createPasswordHash("correct horse battery staple");
  const [algorithm, version, n, r, p, length, encodedSalt, encodedHash] = record.split("$");
  assert.deepEqual([algorithm, version, n, r, p, length], ["scrypt", "1", "16384", "8", "1", "32"]);
  const derived = scryptSync("correct horse battery staple", Buffer.from(encodedSalt, "base64url"), 32, {
    N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  });
  assert.deepEqual(derived, Buffer.from(encodedHash, "base64url"));
});

test("loopback detection and public-origin validation reject ambiguous exposure", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(normalizePublicOrigin("https://wayang.example"), "https://wayang.example");
  assert.throws(() => normalizePublicOrigin("https://wayang.example/path"), /origin/i);
  assert.throws(() => normalizePublicOrigin("javascript:alert(1)"), /origin/i);
});

test("configuration dry-run is non-interactive and secret-free", () => {
  const output = execFileSync(process.execPath, [join(root, "scripts", "configure.mjs"), "--dry-run"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH || "" },
  });
  assert.match(output, /writes nothing|not read or changed/i);
  assert.doesNotMatch(output, /API_KEY=.*[^\s]/);
});
