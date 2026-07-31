import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  CapabilityBoundProtectedBrowser,
  assertProtectedBrowserBinding,
  ensureProtectedBrowserStorage,
  exactProtectedBrowserBindingEqual,
  type ProtectedBrowserAuthorityPort,
  type ProtectedBrowserBackendPort,
  type ProtectedBrowserCredentialPort,
} from "./protected-browser.js";
import {
  PROTECTED_BROWSER_CAPABILITY_ID,
  type ProtectedBrowserAuthorityCheckpoint,
  type ProtectedBrowserAuthoritySnapshot,
  type ProtectedBrowserBinding,
  type ProtectedBrowserOperation,
} from "./types.js";

function binding(overrides: Partial<ProtectedBrowserBinding> = {}): ProtectedBrowserBinding {
  return {
    capabilityId: PROTECTED_BROWSER_CAPABILITY_ID,
    sourceSessionId: "session-immutable-a",
    projectId: "project-immutable-a",
    projectCwd: path.resolve("/synthetic/protected-project"),
    agentProfileId: "profile-immutable-a",
    associationRevision: 11,
    runtimeGeneration: "runtime-generation-a",
    processBootNonce: "boot-nonce-a",
    controlGeneration: 7,
    ...overrides,
  };
}

function snapshot(exact: ProtectedBrowserBinding): ProtectedBrowserAuthoritySnapshot {
  return {
    ...exact,
    authorized: true,
    privacyMode: "protected",
    sourceSessionDurable: true,
    sourceQuarantined: false,
    profileEnabled: true,
    projectAllowsProfile: true,
  };
}

function fixture(options: {
  backend?: ProtectedBrowserBackendPort;
  resolveGate?: (checkpoint: ProtectedBrowserAuthorityCheckpoint) => Promise<void>;
  credentials?: ProtectedBrowserCredentialPort;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-browser-"));
  const initialBinding = binding();
  let current = snapshot(initialBinding);
  let proactiveRevoke: (() => void) | undefined;
  const checkpoints: ProtectedBrowserAuthorityCheckpoint[] = [];
  const authority: ProtectedBrowserAuthorityPort = {
    async resolve(_exact, checkpoint) {
      checkpoints.push(checkpoint);
      await options.resolveGate?.(checkpoint);
      return { ...current };
    },
    transitionControl(exact) {
      current = { ...current, controlGeneration: exact.controlGeneration + 1 };
      return { ...current };
    },
    subscribe(_exact, revoke) {
      proactiveRevoke = revoke;
      return () => { proactiveRevoke = undefined; };
    },
  };
  const dispatches: string[] = [];
  let stops = 0;
  const backend: ProtectedBrowserBackendPort = options.backend ?? {
    async execute(operation, context) {
      dispatches.push(operation.kind);
      if (!["status", "start", "stop"].includes(operation.kind)) await context.assertAuthorized("pre-cdp");
      return {
        value: { kind: operation.kind },
        topLevelUrl: ["status", "start", "stop"].includes(operation.kind)
          ? undefined
          : operation.kind === "navigate" ? operation.url : "https://current.example.test/page",
      };
    },
    stop() { stops += 1; },
  };
  const browser = new CapabilityBoundProtectedBrowser({
    dataDir: root,
    binding: initialBinding,
    authority,
    backend,
    credentials: options.credentials,
  });
  return {
    root,
    browser,
    authority,
    checkpoints,
    dispatches,
    get current() { return current; },
    set current(value: ProtectedBrowserAuthoritySnapshot) { current = value; },
    get proactiveRevoke() { return proactiveRevoke; },
    get stops() { return stops; },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test("protected storage is forced private and isolated by immutable project plus profile IDs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-storage-"));
  try {
    const first = ensureProtectedBrowserStorage(root, "project-id-a", "profile-id-a");
    const same = ensureProtectedBrowserStorage(root, "project-id-a", "profile-id-a");
    const otherProfile = ensureProtectedBrowserStorage(root, "project-id-a", "profile-id-b");
    const reregisteredProject = ensureProtectedBrowserStorage(root, "project-id-b", "profile-id-a");
    assert.deepEqual(same, first);
    assert.equal(first.persistence, "protected");
    assert.notEqual(first.rootDir, otherProfile.rootDir);
    assert.notEqual(first.rootDir, reregisteredProject.rootDir);
    assert.match(first.rootDir, /protected-browser\/v1\/project-/);
    assert.equal(first.rootDir.includes("synthetic/protected-project"), false);
    for (const directory of [first.rootDir, first.profileDir, first.artifactsDir, first.runtimeDir]) {
      assert.equal(fs.lstatSync(directory).isDirectory(), true);
      assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    }
    const projectRoot = path.join(root, "registered-project");
    fs.mkdirSync(projectRoot);
    assert.throws(
      () => ensureProtectedBrowserStorage(projectRoot, "project-id-a", "profile-id-a", projectRoot),
      /outside the project root/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generic operations reauthorize prequeue, dequeue, pre-CDP, and prerelease", async () => {
  const f = fixture();
  try {
    const result = await f.browser.execute<{ kind: string }>({ kind: "navigate", url: "https://example.test/arbitrary?q=1" });
    assert.deepEqual(result, { kind: "navigate" });
    assert.deepEqual(f.checkpoints, ["prequeue", "dequeue", "pre-cdp", "prerelease"]);
    assert.deepEqual(f.dispatches, ["navigate"]);
  } finally {
    await f.browser.close();
    f.cleanup();
  }
});

test("revocation during deferred viewer authority closes the raced handle exactly once", async () => {
  let releaseResolve!: () => void;
  const resolveBlocked = new Promise<void>((resolve) => { releaseResolve = resolve; });
  let enteredResolve!: () => void;
  const resolveEntered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const f = fixture({
    async resolveGate(checkpoint) {
      if (checkpoint !== "viewer-attach") return;
      enteredResolve();
      await resolveBlocked;
    },
  });
  let closes = 0;
  try {
    const registering = f.browser.registerViewer("cdp", () => { closes += 1; });
    await resolveEntered;
    const revoke = f.proactiveRevoke;
    assert.ok(revoke);
    revoke!();
    let cleanupSettled = false;
    const cleanup = f.browser.revoke().then(() => { cleanupSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cleanupSettled, false, "lease cleanup waits for a raced viewer attach to close");
    releaseResolve();
    await assert.rejects(registering, /revoked/i);
    await cleanup;
    assert.equal(closes, 1);
  } finally {
    releaseResolve();
    await f.browser.close();
    f.cleanup();
  }
});

test("revocation during deferred credential authority prevents publication and cleans the realm once", async () => {
  let releaseResolve!: () => void;
  const resolveBlocked = new Promise<void>((resolve) => { releaseResolve = resolve; });
  let enteredResolve!: () => void;
  const resolveEntered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  let begins = 0;
  let realmRevokes = 0;
  const f = fixture({
    async resolveGate(checkpoint) {
      if (checkpoint !== "credential-handoff") return;
      enteredResolve();
      await resolveBlocked;
    },
    credentials: {
      beginHandoff() {
        begins += 1;
        return { revoke() {} };
      },
      revokeLease() { realmRevokes += 1; },
    },
  });
  try {
    const handoff = f.browser.beginCredentialHandoff();
    await resolveEntered;
    const revoke = f.proactiveRevoke;
    assert.ok(revoke);
    revoke!();
    releaseResolve();
    await assert.rejects(handoff, /revoked/i);
    await f.browser.revoke();
    assert.equal(begins, 0);
    assert.equal(realmRevokes, 1);
  } finally {
    releaseResolve();
    await f.browser.close();
    f.cleanup();
  }
});

test("revocation during deferred credential broker handoff revokes the raced handle exactly once", async () => {
  let releaseBroker!: () => void;
  const brokerBlocked = new Promise<void>((resolve) => { releaseBroker = resolve; });
  let enteredBroker!: () => void;
  const brokerEntered = new Promise<void>((resolve) => { enteredBroker = resolve; });
  let handleRevokes = 0;
  const f = fixture({
    credentials: {
      async beginHandoff() {
        enteredBroker();
        await brokerBlocked;
        return { revoke() { handleRevokes += 1; } };
      },
      revokeLease() {},
    },
  });
  try {
    const handoff = f.browser.beginCredentialHandoff();
    await brokerEntered;
    const revoke = f.proactiveRevoke;
    assert.ok(revoke);
    revoke!();
    releaseBroker();
    await assert.rejects(handoff, /revoked/i);
    await f.browser.revoke();
    assert.equal(handleRevokes, 1);
  } finally {
    releaseBroker();
    await f.browser.close();
    f.cleanup();
  }
});

test("only HTTPS agent navigation is accepted and a resulting downgrade permanently revokes", async () => {
  const f = fixture({
    backend: {
      async execute(operation, context) {
        await context.assertAuthorized("pre-cdp");
        return { value: null, topLevelUrl: operation.kind === "navigate" ? "http://downgraded.example.test/" : undefined };
      },
      stop() {},
    },
  });
  try {
    await assert.rejects(() => f.browser.execute({ kind: "navigate", url: "http://example.test/" }), /requires HTTPS/i);
    await assert.rejects(() => f.browser.execute({ kind: "navigate", url: "data:text/plain,no" }), /requires HTTPS/i);
    await assert.rejects(() => f.browser.execute({ kind: "navigate", url: "https://example.test/" }), /neither HTTPS nor inert/i);
    assert.equal(f.browser.isRevoked, true);
    await assert.rejects(() => f.browser.execute({ kind: "status" }), /revoked/i);
  } finally {
    await f.browser.close();
    f.cleanup();
  }
});

test("click, selector, fill, and type results must attest an HTTPS or inert top-level document", async () => {
  const operations: ProtectedBrowserOperation[] = [
    { kind: "click", x: 10, y: 20 },
    { kind: "click_selector", selector: "#submit" },
    { kind: "query_selector", selector: "main" },
    { kind: "fill_selector", selector: "#public", text: "public text" },
    { kind: "type_public", text: "public text" },
  ];
  for (const operation of operations) {
    const f = fixture({
      backend: {
        async execute(_operation, context) {
          await context.assertAuthorized("pre-cdp");
          return { value: "must-not-release", topLevelUrl: "http://downgraded.example.test/" };
        },
        stop() {},
      },
    });
    try {
      await assert.rejects(() => f.browser.execute(operation), /neither HTTPS nor inert/i, operation.kind);
      assert.equal(f.browser.isRevoked, true, operation.kind);
    } finally {
      await f.browser.close();
      f.cleanup();
    }
  }
});

test("an asynchronous post-action redirect is checked before result release", async () => {
  const f = fixture({
    backend: {
      async execute(_operation, context) {
        await context.assertAuthorized("pre-cdp");
        await new Promise<void>((resolve) => setImmediate(resolve));
        return { value: "must-not-release", topLevelUrl: "data:text/html,redirected" };
      },
      stop() {},
    },
  });
  try {
    await assert.rejects(
      () => f.browser.execute({ kind: "click_selector", selector: "#redirect" }),
      /neither HTTPS nor inert/i,
    );
    assert.equal(f.browser.isRevoked, true);
  } finally {
    await f.browser.close();
    f.cleanup();
  }
});

test("inert startup document attestation is allowed for non-navigation CDP inspection", async () => {
  const f = fixture({
    backend: {
      async execute(_operation, context) {
        await context.assertAuthorized("pre-cdp");
        return { value: "inert", topLevelUrl: "about:blank" };
      },
      stop() {},
    },
  });
  try {
    assert.equal(await f.browser.execute({ kind: "snapshot" }), "inert");
    assert.equal(f.browser.isRevoked, false);
  } finally {
    await f.browser.close();
    f.cleanup();
  }
});

test("every CDP result must include top-level URL attestation", async () => {
  const f = fixture({
    backend: {
      async execute(_operation, context) {
        await context.assertAuthorized("pre-cdp");
        return { value: "unattested" };
      },
      stop() {},
    },
  });
  try {
    await assert.rejects(() => f.browser.execute({ kind: "accessibility" }), /omitted top-level URL attestation/i);
    assert.equal(f.browser.isRevoked, true);
  } finally {
    await f.browser.close();
    f.cleanup();
  }
});

test("authority drift after CDP dispatch suppresses the result at prerelease", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({
    backend: {
      async execute(_operation, context) {
        await context.assertAuthorized("pre-cdp");
        f.current = { ...f.current, runtimeGeneration: "drifted-after-cdp" };
        return { value: "must-not-release", topLevelUrl: "https://current.example.test/page" };
      },
      stop() {},
    },
  });
  try {
    await assert.rejects(() => f.browser.execute({ kind: "snapshot" }), /authority changed at prerelease/i);
    assert.equal(f.browser.isRevoked, true);
  } finally {
    await f.browser.close();
    f.cleanup();
  }
});

test("backend omission of the mandatory pre-CDP guard latches denial", async () => {
  const f = fixture({
    backend: {
      async execute() { return { value: "unsafe", topLevelUrl: "https://example.test/" }; },
      stop() {},
    },
  });
  try {
    await assert.rejects(() => f.browser.execute({ kind: "snapshot" }), /omitted the pre-CDP/i);
    assert.equal(f.browser.isRevoked, true);
  } finally {
    await f.browser.close();
    f.cleanup();
  }
});

test("every exact pair, association, runtime, and control drift fails closed", async () => {
  const variants: Array<[keyof ProtectedBrowserBinding, unknown]> = [
    ["sourceSessionId", "other-session"],
    ["projectId", "other-project"],
    ["projectCwd", path.resolve("/synthetic/other-project")],
    ["agentProfileId", "other-profile"],
    ["associationRevision", 101],
    ["runtimeGeneration", "other-runtime"],
    ["processBootNonce", "other-boot"],
    ["controlGeneration", 99],
  ];
  for (const [key, value] of variants) {
    const f = fixture();
    try {
      f.current = { ...f.current, [key]: value } as ProtectedBrowserAuthoritySnapshot;
      await assert.rejects(() => f.browser.execute({ kind: "status" }), /authority changed at prequeue/i, String(key));
      assert.equal(f.browser.isRevoked, true, String(key));
    } finally {
      await f.browser.close();
      f.cleanup();
    }
  }

  const deniedSnapshots: Partial<ProtectedBrowserAuthoritySnapshot>[] = [
    { authorized: false },
    { privacyMode: "standard" },
    { sourceSessionDurable: false },
    { sourceQuarantined: true },
    { profileEnabled: false },
    { projectAllowsProfile: false },
  ];
  for (const denied of deniedSnapshots) {
    const f = fixture();
    try {
      f.current = { ...f.current, ...denied };
      await assert.rejects(() => f.browser.execute({ kind: "status" }), /authority changed/);
      assert.equal(f.browser.isRevoked, true);
    } finally {
      await f.browser.close();
      f.cleanup();
    }
  }
});

test("restoring an old exact runtime lease cannot revive a denial-latched browser", async () => {
  const f = fixture();
  const original = { ...f.current };
  try {
    f.current = { ...f.current, runtimeGeneration: "drifted-runtime" };
    await assert.rejects(() => f.browser.execute({ kind: "status" }), /authority changed/);
    f.current = original;
    await assert.rejects(() => f.browser.execute({ kind: "status" }), /revoked/);
    assert.deepEqual(f.dispatches, []);
  } finally {
    await f.browser.close();
    f.cleanup();
  }
});

test("proactive revocation closes VNC, CDP, credentials, runtime, in-flight result, and queued work", async () => {
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let enteredFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
  const dispatched: string[] = [];
  let stopped = 0;
  let credentialRealmRevoked = 0;
  const f = fixture({
    backend: {
      async execute(operation) {
        dispatched.push(operation.kind);
        if (operation.kind === "start") {
          enteredFirst();
          await firstBlocked;
        }
        return { value: operation.kind };
      },
      stop() { stopped += 1; },
    },
    credentials: {
      revokeLease() { credentialRealmRevoked += 1; },
    },
  });
  let vncClosed = 0;
  let cdpClosed = 0;
  let credentialHandleRevoked = 0;
  try {
    await f.browser.registerViewer("vnc", () => { vncClosed += 1; });
    await f.browser.registerViewer("cdp", () => { cdpClosed += 1; });
    f.browser.registerCredentialHandle({ revoke() { credentialHandleRevoked += 1; } });
    const inFlight = f.browser.execute({ kind: "start" });
    await firstEntered;
    const queued = f.browser.execute({ kind: "stop" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(f.proactiveRevoke);
    f.proactiveRevoke!();
    assert.equal(credentialRealmRevoked, 1, "credential choices revoke in the denial turn");
    releaseFirst();
    await assert.rejects(inFlight, /revoked/i);
    await assert.rejects(queued, /revoked/i);
    await f.browser.revokeRealm();
    assert.deepEqual(dispatched, ["start"]);
    assert.equal(vncClosed, 1);
    assert.equal(cdpClosed, 1);
    assert.equal(credentialHandleRevoked, 1);
    assert.equal(credentialRealmRevoked, 1);
    assert.equal(stopped, 1, "proactive policy invalidation tears down the pair realm");
  } finally {
    releaseFirst();
    await f.browser.close();
    f.cleanup();
  }
});

test("full pair invalidation stops the realm after denial while lease revocation does not", async () => {
  let stopped = 0;
  let leaseRevoked = 0;
  let realmRevoked = 0;
  const f = fixture({
    backend: { async execute() { return { value: null }; }, stop() { stopped += 1; } },
    credentials: {
      revokeLease() { leaseRevoked += 1; },
      revokeRealm() { realmRevoked += 1; },
    },
  });
  try {
    await f.browser.revokeRealm();
    assert.equal(f.browser.isRevoked, true);
    assert.equal(leaseRevoked, 1);
    assert.equal(realmRevoked, 1);
    assert.equal(stopped, 1);
  } finally {
    await f.browser.close();
    f.cleanup();
  }
});

test("viewer input reauthorizes every message and credential handoff advances backend-owned control epochs", async () => {
  let credentialBegins = 0;
  let resumeChecks = 0;
  const f = fixture({
    credentials: {
      beginHandoff() {
        credentialBegins += 1;
        return { revoke() {} };
      },
      assertSafeResume() { resumeChecks += 1; },
      revokeLease() {},
    },
  });
  try {
    const viewer = await f.browser.registerViewer("cdp", () => undefined);
    let messages = 0;
    await f.browser.handleViewerMessage(viewer, async () => { messages += 1; });
    await f.browser.handleViewerMessage(viewer, async () => { messages += 1; });
    assert.equal(f.checkpoints.filter((stage) => stage === "viewer-message").length, 2);
    assert.equal(messages, 2);

    const before = f.browser.currentBinding.controlGeneration;
    await f.browser.beginCredentialHandoff();
    assert.equal(f.browser.mode, "user");
    assert.ok(f.browser.currentBinding.controlGeneration > before);
    await assert.rejects(() => f.browser.execute({ kind: "start" }), /paused/i);
    await f.browser.resumeAgentAfterCredentialHandoff();
    assert.equal(f.browser.mode, "agent");
    assert.ok(f.browser.currentBinding.controlGeneration > before + 1);
    assert.equal(credentialBegins, 1);
    assert.equal(resumeChecks, 1);
    await f.browser.execute({ kind: "status" });
  } finally {
    await f.browser.close();
    f.cleanup();
  }
});

test("bindings compare every authority field and operation objects reject hidden control payloads", async () => {
  const exact = binding();
  assert.equal(exactProtectedBrowserBindingEqual(exact, { ...exact }), true);
  assert.equal(exactProtectedBrowserBindingEqual(exact, { ...exact, runtimeGeneration: "other" }), false);
  assert.throws(
    () => assertProtectedBrowserBinding({ ...exact, provider: "stale-provider" } as any),
    /unsupported fields/i,
  );
  assert.throws(
    () => assertProtectedBrowserBinding({ ...exact, model: "stale-model" } as any),
    /unsupported fields/i,
  );
  const f = fixture();
  try {
    await assert.rejects(
      () => f.browser.execute({ kind: "status", provider: "smuggled" } as any),
      /unsupported fields/i,
    );
    await assert.rejects(
      () => f.browser.execute(Object.assign(Object.create({ kind: "status" }), {}) as any),
      /operation is invalid/i,
    );
    assert.deepEqual(f.dispatches, []);
  } finally {
    await f.browser.close();
    f.cleanup();
  }
});
