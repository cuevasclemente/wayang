import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { BrowserCredentialsConfig } from "../config.js";
import { BwCliAdapter, CredentialBroker, buildBwChildEnvironment, isValidBitwardenItemId, maskCredentialIdentifier, type BitwardenAdapter } from "./credentials.js";
import type { BrowserCredentialContext } from "./manager.js";
import type { ProtectedBrowserBinding } from "./types.js";

const USER_CANARY = "synthetic-user-canary@example.test";
const PASSWORD_CANARY = "SYNTHETIC_PASSWORD_CANARY_9f2a";
const TOTP_CANARY = "731942";
const ITEM_ID_CANARY = "123e4567-e89b-42d3-a456-426614174000";
const SESSION_CANARY = "synthetic-session-key-canary";

function config(root: string, overrides: Partial<BrowserCredentialsConfig> = {}): BrowserCredentialsConfig {
  return {
    bwPath: "",
    unlockSocketPath: path.join(root, "credentials", "unlock.sock"),
    idleTimeoutMs: 60_000,
    choiceTtlMs: 1_000,
    maxCliOutputBytes: 1024 * 1024,
    cliTimeoutMs: 5_000,
    ...overrides,
  };
}

function protectedBinding(overrides: Partial<ProtectedBrowserBinding> = {}): ProtectedBrowserBinding {
  return {
    capabilityId: "wayang.protected-browser.v1",
    sourceSessionId: "synthetic-source-session",
    projectId: "synthetic-project",
    projectCwd: "/synthetic/project",
    agentProfileId: "synthetic-profile",
    associationRevision: 1,
    runtimeGeneration: "synthetic-runtime",
    processBootNonce: "synthetic-boot",
    controlGeneration: 5,
    ...overrides,
  };
}

function context(overrides: Partial<BrowserCredentialContext> = {}): BrowserCredentialContext {
  return {
    runtimeKey: "shared",
    targetId: "synthetic-target",
    documentIdentity: "synthetic-main-frame:synthetic-loader",
    url: "https://login.example.test/sign-in",
    origin: "https://login.example.test",
    ...overrides,
  };
}

class FakeAdapter implements BitwardenAdapter {
  readonly available = true;
  locks = 0;
  readonly item = {
    id: ITEM_ID_CANARY,
    name: "Synthetic example login",
    login: {
      username: USER_CANARY,
      password: PASSWORD_CANARY,
      totp: "otpauth://synthetic-seed-canary",
      uris: [{ uri: "https://login.example.test/account" }],
    },
  };

  async listItems() { return [this.item]; }
  async getItem() { return this.item; }
  async getTotp() { return TOTP_CANARY; }
  async lock() { this.locks += 1; }
}

test("origin-bound one-use choices fill opaque canaries without returning secrets or item ids", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-credential-broker-"));
  const adapter = new FakeAdapter();
  const broker = new CredentialBroker(config(root), adapter);
  try {
    broker.acceptUnlockKey(SESSION_CANARY);
    const matches = await broker.matches(context());
    assert.equal(matches.origin, context().origin);
    assert.equal(matches.choices.length, 1);
    const serializedMatches = JSON.stringify(matches);
    for (const canary of [USER_CANARY, PASSWORD_CANARY, TOTP_CANARY, ITEM_ID_CANARY, SESSION_CANARY]) {
      assert.equal(serializedMatches.includes(canary), false, canary);
    }
    assert.equal(maskCredentialIdentifier(USER_CANARY).includes(USER_CANARY), false);

    const loginChoice = matches.choices.find((choice) => choice.hasTotp && choice.label.includes("Synthetic"))!;
    let equalityChecked = false;
    const result = await broker.fill(loginChoice.choiceToken, "login", context(), async (values) => {
      equalityChecked = values.username === USER_CANARY && values.password === PASSWORD_CANARY;
      return ["username", "password"];
    });
    assert.equal(equalityChecked, true);
    assert.deepEqual(result, { filled: ["username", "password"] });
    const serializedResult = JSON.stringify(result);
    for (const canary of [USER_CANARY, PASSWORD_CANARY, ITEM_ID_CANARY, SESSION_CANARY]) assert.equal(serializedResult.includes(canary), false);
    await assert.rejects(() => broker.fill(loginChoice.choiceToken, "login", context(), async () => []), /already used|expired/i);

    adapter.item.name = PASSWORD_CANARY;
    const labelSafe = await broker.matches(context());
    assert.equal(labelSafe.choices[0].label, "Saved login");
    assert.equal(JSON.stringify(labelSafe).includes(PASSWORD_CANARY), false);

    const secondMatches = await broker.matches(context());
    const navigatedChoice = secondMatches.choices[0];
    await assert.rejects(
      () => broker.fill(navigatedChoice.choiceToken, "login", context({ origin: "https://other.example.test", url: "https://other.example.test/" }), async () => []),
      /no longer valid/i,
    );
  } finally {
    await broker.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("protected choices bind the exact capability, target, document, runtime/control generations and revoke without replay", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-credential-binding-"));
  const broker = new CredentialBroker(config(root), new FakeAdapter());
  const exact = protectedBinding();
  assert.equal("provider" in exact, false);
  assert.equal("model" in exact, false);
  const exactContext = context({ runtimeKey: "protected-runtime", capabilityBinding: exact });
  try {
    broker.acceptUnlockKey(SESSION_CANARY);
    const variants: BrowserCredentialContext[] = [
      context({ ...exactContext, targetId: "cross-target" }),
      context({ ...exactContext, documentIdentity: "synthetic-main-frame:stale-loader" }),
      context({ ...exactContext, origin: "https://other.example.test", url: "https://other.example.test/" }),
      context({ ...exactContext, capabilityBinding: protectedBinding({ sourceSessionId: "cross-session" }) }),
      context({ ...exactContext, capabilityBinding: protectedBinding({ projectId: "cross-project" }) }),
      context({ ...exactContext, capabilityBinding: protectedBinding({ agentProfileId: "cross-profile" }) }),
      context({ ...exactContext, capabilityBinding: protectedBinding({ associationRevision: 9 }) }),
      context({ ...exactContext, capabilityBinding: protectedBinding({ runtimeGeneration: "stale-runtime" }) }),
      context({ ...exactContext, capabilityBinding: protectedBinding({ controlGeneration: 6 }) }),
      context({ ...exactContext, capabilityBinding: undefined }),
    ];
    for (const drifted of variants) {
      const choice = (await broker.matches(exactContext)).choices[0];
      await assert.rejects(() => broker.fill(choice.choiceToken, "login", drifted, async () => []), /no longer valid/i);
      await assert.rejects(() => broker.fill(choice.choiceToken, "login", exactContext, async () => []), /already used|expired/i);
    }

    const revoked = (await broker.matches(exactContext)).choices[0];
    broker.revokeChoicesForProtectedBinding(protectedBinding({ controlGeneration: 99 }));
    await assert.rejects(() => broker.fill(revoked.choiceToken, "login", exactContext, async () => []), /already used|expired/i);
  } finally {
    await broker.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("TOTP is filled opaquely and explicit lock clears memory and invokes the adapter", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-credential-totp-"));
  const adapter = new FakeAdapter();
  const broker = new CredentialBroker(config(root), adapter);
  try {
    broker.acceptUnlockKey(SESSION_CANARY);
    const matches = await broker.matches(context());
    const token = matches.choices[0].choiceToken;
    let equalityChecked = false;
    const result = await broker.fill(token, "totp", context(), async (values) => {
      equalityChecked = values.totp === TOTP_CANARY;
      return ["totp"];
    });
    assert.equal(equalityChecked, true);
    assert.deepEqual(result, { filled: ["totp"] });
    assert.equal(JSON.stringify(result).includes(TOTP_CANARY), false);
    await broker.lock();
    assert.deepEqual(broker.status(), { available: true, unlocked: false });
    assert.equal(adapter.locks, 1);
  } finally {
    await broker.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("required credential fields fail closed and item IDs reject option-shaped/non-UUID values", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-credential-required-field-"));
  const broker = new CredentialBroker(config(root), new FakeAdapter());
  try {
    broker.acceptUnlockKey(SESSION_CANARY);
    const login = (await broker.matches(context())).choices[0];
    await assert.rejects(
      () => broker.fill(login.choiceToken, "login", context(), async () => ["username"]),
      /required password/i,
    );
    const totp = (await broker.matches(context())).choices[0];
    await assert.rejects(
      () => broker.fill(totp.choiceToken, "totp", context(), async () => []),
      /required code/i,
    );
    assert.equal(isValidBitwardenItemId(ITEM_ID_CANARY), true);
    for (const invalid of ["--help", "synthetic-item", "00000000-0000-0000-0000-000000000000"]) {
      assert.equal(isValidBitwardenItemId(invalid), false);
    }
  } finally {
    await broker.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bw child environment uses a strict allowlist", () => {
  const env = buildBwChildEnvironment({
    HOME: "/synthetic/home",
    PATH: "/synthetic/bin",
    HTTPS_PROXY: "http://synthetic-proxy.invalid",
    WAYANG_BROWSER_AGENT_TOKEN: "forbidden-token",
    OPENAI_API_KEY: "forbidden-provider-key",
    FORBIDDEN_ENV_CANARY: "forbidden-canary",
  }, SESSION_CANARY);
  assert.deepEqual(env, {
    HOME: "/synthetic/home",
    PATH: "/synthetic/bin",
    HTTPS_PROXY: "http://synthetic-proxy.invalid",
    BW_SESSION: SESSION_CANARY,
  });
});

test("private unlock socket is mode 0600 and retains the session only in broker memory", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-credential-socket-"));
  const broker = new CredentialBroker(config(root), new FakeAdapter());
  try {
    await broker.startUnlockSocket();
    assert.equal(fs.statSync(config(root).unlockSocketPath).mode & 0o777, 0o600);
    const reply = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = net.createConnection(config(root).unlockSocketPath);
      socket.once("connect", () => socket.end(SESSION_CANARY));
      socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      socket.once("error", reject);
      socket.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    assert.equal(reply, "ok\n");
    assert.equal(broker.status().unlocked, true);
  } finally {
    await broker.shutdown();
    assert.equal(fs.existsSync(config(root).unlockSocketPath), false);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fake bw executable receives exact commands in a synthetic HOME and adapter errors never include CLI output", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-fake-bw-"));
  const fakeBw = path.join(root, "fake-bw");
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.HOME !== ${JSON.stringify(root)} || process.env.BW_SESSION !== ${JSON.stringify(SESSION_CANARY)} || process.cwd() !== ${JSON.stringify(os.tmpdir())} || process.env.FORBIDDEN_ENV_CANARY) process.exit(41);
if (args.join(" ") === "list items --url https://login.example.test") console.log(JSON.stringify([{id:${JSON.stringify(ITEM_ID_CANARY)},name:"Synthetic",login:{username:${JSON.stringify(USER_CANARY)},password:${JSON.stringify(PASSWORD_CANARY)},totp:"seed",uris:[{uri:"https://login.example.test/"}]}}]));
else if (args.join(" ") === "get item ${ITEM_ID_CANARY}") console.log(JSON.stringify({id:${JSON.stringify(ITEM_ID_CANARY)},login:{username:${JSON.stringify(USER_CANARY)},password:${JSON.stringify(PASSWORD_CANARY)},uris:[{uri:"https://login.example.test/"}]}}));
else if (args.join(" ") === "get totp ${ITEM_ID_CANARY}") console.log(${JSON.stringify(TOTP_CANARY)});
else { console.error(${JSON.stringify(PASSWORD_CANARY)}); process.exit(42); }
`;
  fs.writeFileSync(fakeBw, script, { mode: 0o700 });
  const previousHome = process.env.HOME;
  const previousForbidden = process.env.FORBIDDEN_ENV_CANARY;
  process.env.HOME = root;
  process.env.FORBIDDEN_ENV_CANARY = "must-not-reach-bw";
  try {
    const adapter = new BwCliAdapter(config(root, { bwPath: fakeBw }));
    assert.equal(adapter.available, true);
    assert.equal((await adapter.listItems(context().origin, SESSION_CANARY)).length, 1);
    assert.equal((await adapter.getItem(ITEM_ID_CANARY, SESSION_CANARY)).id, ITEM_ID_CANARY);
    assert.equal(await adapter.getTotp(ITEM_ID_CANARY, SESSION_CANARY), TOTP_CANARY);
    await assert.rejects(
      adapter.getItem("unexpected-item", SESSION_CANARY),
      (error: unknown) => error instanceof Error && !error.message.includes(PASSWORD_CANARY) && /invalid/i.test(error.message),
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousForbidden === undefined) delete process.env.FORBIDDEN_ENV_CANARY;
    else process.env.FORBIDDEN_ENV_CANARY = previousForbidden;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
