import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createPasswordHash,
  isLoopbackHost,
  normalizeCompanionUrl,
  normalizePublicOrigin,
  parseEnv,
  promptForCompanionUrl,
  recommendCompanionUrl,
  updateEnv,
  writePrivateAtomic,
} from "../lib/config.mjs";

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
  assert.equal(isLoopbackHost("127.42.3.4"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("127.0.0.999"), false);
  assert.equal(isLoopbackHost("127.0.0.1.example"), false);
  assert.equal(isLoopbackHost("127.00.00.01"), false);
  assert.equal(normalizePublicOrigin("https://wayang.example"), "https://wayang.example");
  assert.throws(() => normalizePublicOrigin("not a URL"), {
    message: "Public browser origin must be an absolute http(s) origin",
  });
  assert.throws(() => normalizePublicOrigin("https://wayang.example/path"), {
    message: "Public browser origin must not contain credentials, a path, query, or fragment",
  });
  assert.throws(() => normalizePublicOrigin("javascript:alert(1)"), {
    message: "Public browser origin must not contain credentials, a path, query, or fragment",
  });
});

test("companion URL recommendations follow the authorized browser authority", () => {
  assert.equal(recommendCompanionUrl({ publicOrigin: "https://wayang.example", port: 8787 }), "https://wayang.example");
  assert.equal(recommendCompanionUrl({ publicOrigin: "", port: 9000 }), "http://127.0.0.1:9000");
  const validCompanionUrls = [
    ["http://wayang-host.test:8787", "http://wayang-host.test:8787"],
    ["https://wayang.example/", "https://wayang.example"],
    ["http://[::1]:8787", "http://[::1]:8787"],
    ["https://[2001:db8::1]/", "https://[2001:db8::1]"],
  ];
  for (const [value, expected] of validCompanionUrls) {
    assert.equal(normalizeCompanionUrl(value), expected, JSON.stringify(value));
  }
  const invalidCompanionUrls = [
    "http://example.com:",
    "http://example.com:/",
    "http://[::1]:",
    "http://example.com\u0001",
    "http://example.com\u007f",
    "https://wayang.example\\",
    "https://wayang .example",
    "https://wayang.example ",
    "https://wayang.example\t",
    "https://wayang.example\n",
    "https://wayang.example\r",
    "http://user:password@example.com",
    "https://wayang.example?mode=1",
    "https://wayang.example#section",
    "http://@example.com",
    "http://:@example.com",
    "https://wayang.example/path",
    "https://wayang.example?",
    "https://wayang.example#",
    "https://wayang.example/a/..",
    "file:///tmp/wayang",
  ];
  for (const value of invalidCompanionUrls) {
    assert.throws(() => normalizeCompanionUrl(value), /companion/i, JSON.stringify(value));
  }
});

test("companion URL recommendations use the selected loopback bind host", () => {
  assert.equal(
    recommendCompanionUrl({ publicOrigin: "https://wayang.example", host: "::1", port: 9000 }),
    "https://wayang.example",
  );

  const loopbackHosts = [
    ["::1", "http://[::1]:9000"],
    ["[::1]", "http://[::1]:9000"],
    ["localhost", "http://localhost:9000"],
    ["127.42.3.4", "http://127.42.3.4:9000"],
  ];
  for (const [host, expected] of loopbackHosts) {
    assert.equal(recommendCompanionUrl({ publicOrigin: "", host, port: 9000 }), expected, host);
  }

  for (const host of ["", "0.0.0.0", "::", "[::]", "192.0.2.1", "*", "127.0.0.999"]) {
    assert.equal(
      recommendCompanionUrl({ publicOrigin: "", host, port: 9000 }),
      "http://127.0.0.1:9000",
      host,
    );
  }
});

test("companion URL literal-syntax error names rejected characters", () => {
  assert.throws(() => normalizeCompanionUrl("https://wayang.example\\"), {
    message: "Companion tool backend URL must not contain credentials, a path, query, fragment, control characters, or backslashes",
  });
});

test("companion prompt uses the public origin as its fallback", async () => {
  let prompt;
  const result = await promptForCompanionUrl({
    publicOrigin: "https://wayang.example",
    port: 8787,
    existingValue: "",
    ask: async (...args) => {
      prompt = args;
      return args[1];
    },
    notice: () => assert.fail("unexpected notice"),
  });

  assert.deepEqual(prompt, ["Companion pi-tool backend URL", "https://wayang.example"]);
  assert.equal(result, "https://wayang.example");
});

test("companion prompt recommends loopback when no public origin is configured", async () => {
  let prompt;
  const result = await promptForCompanionUrl({
    publicOrigin: "",
    port: 9000,
    existingValue: "",
    ask: async (...args) => {
      prompt = args;
      return args[1];
    },
    notice: () => assert.fail("unexpected notice"),
  });

  assert.deepEqual(prompt, ["Companion pi-tool backend URL", "http://127.0.0.1:9000"]);
  assert.equal(result, "http://127.0.0.1:9000");
});

test("companion prompt brackets an IPv6 loopback fallback", async () => {
  let prompt;
  const result = await promptForCompanionUrl({
    publicOrigin: "",
    host: "::1",
    port: 9000,
    existingValue: "",
    ask: async (...args) => {
      prompt = args;
      return args[1];
    },
    notice: () => assert.fail("unexpected notice"),
  });

  assert.deepEqual(prompt, ["Companion pi-tool backend URL", "http://[::1]:9000"]);
  assert.equal(result, "http://[::1]:9000");
});

test("companion prompt normalizes and preserves a valid explicit override", async () => {
  let prompt;
  const notices = [];
  const result = await promptForCompanionUrl({
    publicOrigin: "https://wayang.example",
    port: 8787,
    existingValue: "https://tools.example/",
    ask: async (...args) => {
      prompt = args;
      return args[1];
    },
    notice: (message) => notices.push(message),
  });

  assert.deepEqual(prompt, ["Companion pi-tool backend URL", "https://tools.example"]);
  assert.equal(result, "https://tools.example");
  assert.equal(notices.length, 1);
});

test("companion prompt does not warn for an equivalent trailing-slash origin", async () => {
  const notices = [];
  await promptForCompanionUrl({
    publicOrigin: "https://wayang.example",
    port: 8787,
    existingValue: "https://wayang.example/",
    ask: async (_label, fallback) => fallback,
    notice: (message) => notices.push(message),
  });

  assert.deepEqual(notices, []);
});

test("companion prompt mismatch notice contains only the safe recommendation", async () => {
  const notices = [];
  await promptForCompanionUrl({
    publicOrigin: "https://wayang.example",
    port: 8787,
    existingValue: "https://tools.example",
    ask: async (_label, fallback) => fallback,
    notice: (message) => notices.push(message),
  });

  assert.deepEqual(notices, [
    "The recommended companion pi-tool backend URL for this configuration is https://wayang.example.",
  ]);
  assert.doesNotMatch(notices[0], /tools\.example/);
});

test("companion prompt replaces invalid existing values without displaying them", async () => {
  const invalidValues = [
    "http://user:password@example.com",
    "http://example.com\u001b[31m",
  ];

  for (const existingValue of invalidValues) {
    let prompt;
    const notices = [];
    const result = await promptForCompanionUrl({
      publicOrigin: "https://wayang.example",
      port: 8787,
      existingValue,
      ask: async (...args) => {
        prompt = args;
        return args[1];
      },
      notice: (message) => notices.push(message),
    });

    assert.deepEqual(notices, [
      "Existing WAYANG_URL is invalid and must be replaced; its value was not displayed.",
    ]);
    assert.deepEqual(prompt, ["Companion pi-tool backend URL", "https://wayang.example"]);
    assert.equal(result, "https://wayang.example");
    const displayed = [...notices, ...prompt].join("\n");
    assert.equal(displayed.includes(existingValue), false);
    assert.equal(displayed.includes("user"), false);
    assert.equal(displayed.includes("password"), false);
    assert.equal(displayed.includes("\u001b"), false);
  }
});

test("companion prompt rejects an invalid user response", async () => {
  let prompt;
  await assert.rejects(
    () => promptForCompanionUrl({
      publicOrigin: "https://wayang.example",
      port: 8787,
      existingValue: "",
      ask: async (...args) => {
        prompt = args;
        return "https://wayang.example/path";
      },
      notice: () => assert.fail("unexpected notice"),
    }),
    /Companion tool backend URL/,
  );
  assert.deepEqual(prompt, ["Companion pi-tool backend URL", "https://wayang.example"]);
});

test("configuration dry-run is non-interactive and secret-free", () => {
  const output = execFileSync(process.execPath, [join(root, "scripts", "configure.mjs"), "--dry-run"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH || "" },
  });
  assert.match(output, /writes nothing|not read or changed/i);
  assert.match(output, /companion pi-tool backend URL: http:\/\/127\.0\.0\.1:8787/i);
  assert.doesNotMatch(output, /Wren host bash|Finance export/i);
  assert.doesNotMatch(output, /API_KEY=.*[^\s]/);
});
