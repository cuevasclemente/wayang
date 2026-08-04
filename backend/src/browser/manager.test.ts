import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { close, init } from "../db.js";
import { createProject } from "../projects.js";
import { createSession } from "../sessions.js";
import {
  allowAgentAfterCredentialFill,
  assertBrowserAgentControl,
  browserAccessibilitySnapshot,
  browserDomSnapshot,
  browserSnapshot,
  clickBrowser,
  clickBrowserSelector,
  fillBrowserCredential,
  fillBrowserSelector,
  getBrowserCredentialContext,
  getBrowserStatus,
  getChromiumCandidates,
  getChromiumHostArchitecture,
  getPlaywrightCacheRoot,
  getPlaywrightChromiumCandidates,
  getPublicBrowserStatus,
  getSystemChromiumCandidates,
  isSensitiveFieldDescriptor,
  queryBrowserSelector,
  recordBrowserCredentialFill,
  redactKnownCredentialValues,
  registerBrowserStopHook,
  redactSensitiveValue,
  selectActivePageTarget,
  selectPageTarget,
  setBrowserControlMode,
  startBrowser,
  stopAllBrowsers,
  stopBrowser,
  typePublicBrowser,
  navigateBrowser,
  toPublicBrowserState,
  sanitizeBrowserUrl,
} from "./manager.js";

function reversibleRepresentations(value: string): string[] {
  const component = encodeURIComponent(value);
  const uri = encodeURI(value);
  const form = new URLSearchParams({ value }).toString().slice("value=".length);
  const lowerPercentHex = component.replace(/%[0-9A-F]{2}/g, (triplet) => triplet.toLowerCase());
  return [
    value,
    component,
    lowerPercentHex,
    uri,
    form,
    Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("base64url"),
  ];
}

async function localPageServer(t: TestContext, handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("shared browser scope reuses one private data-dir profile while explicit scopes remain isolated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-browser-profile-test-"));
  const dataDir = path.join(root, "data");
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  fs.mkdirSync(projectA);
  fs.mkdirSync(projectB);
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dataDir;
  init();
  try {
    createProject({ cwd: projectA });
    createProject({ cwd: projectB });
    const durableA = createSession(projectA);
    const durableB = createSession(projectB);
    const sharedA = getBrowserStatus({ projectCwd: projectA });
    const sharedB = getBrowserStatus({ projectCwd: projectB });
    assert.equal(sharedA.key, "shared");
    assert.equal(sharedB.key, sharedA.key);
    assert.equal(sharedA.profile.profileDir, path.join(dataDir, "browser-workbench", "profiles", "shared"));
    assert.equal(sharedB.profile.profileDir, sharedA.profile.profileDir);
    assert.equal(sharedA.profile.persistence, "shared");

    const projectScopedA = getBrowserStatus({ projectCwd: projectA, persistence: "project" });
    const projectScopedB = getBrowserStatus({ projectCwd: projectB, persistence: "project" });
    assert.notEqual(projectScopedA.key, projectScopedB.key);
    assert.match(projectScopedA.profile.profileDir, /\.pi\/browser-workbench\/profiles/);

    assert.throws(
      () => getBrowserStatus({ projectCwd: projectB, sessionId: durableA.id, persistence: "session" }),
      /does not match the durable session cwd/,
    );
    const sessionA = getBrowserStatus({ projectCwd: projectA, sessionId: durableA.id, persistence: "session" });
    const sessionB = getBrowserStatus({ projectCwd: projectB, sessionId: durableB.id, persistence: "session" });
    assert.notEqual(sessionA.key, sessionB.key);
    assert.equal(sessionA.projectCwd, fs.realpathSync(projectA));
    assert.equal(
      sessionA.profile.profileDir.startsWith(path.join(projectA, ".pi", "browser-workbench", "profiles")),
      true,
    );
  } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public browser state omits runtime paths, ports, target ids, generations, and child logs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-browser-public-state-"));
  try {
    const internal = getBrowserStatus({ projectCwd: root, persistence: "project" });
    internal.cdpPort = 43210;
    internal.vncPort = 43211;
    internal.display = ":123";
    internal.activeTargetId = "target-canary";
    internal.logs.push("child-log-canary");
    const publicState = toPublicBrowserState(internal);
    const serialized = JSON.stringify(publicState);
    for (const canary of [internal.profile.profileDir, ":123", "target-canary", "child-log-canary", "controlGeneration"]) {
      assert.equal(serialized.includes(canary), false, canary);
    }
    for (const key of ["cdpPort", "vncPort", "display", "logs", "activeTargetId", "controlGeneration"]) {
      assert.equal(key in publicState, false, key);
    }
    assert.deepEqual(publicState.profile, { persistence: "project" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sensitive field detection and value redaction cover password, OTP, card, recovery, and PIN fields", () => {
  for (const descriptor of [
    { type: "password" },
    { autocomplete: "one-time-code" },
    { name: "credit_card_number" },
    { id: "recovery-code" },
    { ariaLabel: "Security PIN" },
  ]) assert.equal(isSensitiveFieldDescriptor(descriptor), true);
  assert.equal(isSensitiveFieldDescriptor({ type: "email", name: "public-email" }), false);
  assert.equal(redactSensitiveValue("prefix SECRET_CANARY suffix", ["SECRET_CANARY"]), "prefix [REDACTED] suffix");
  assert.equal(redactSensitiveValue("SECRET_CANARY", [], true), "[REDACTED]");
});

test("known credential redaction removes raw, URI, form, base64, and base64url representations without changing unrelated text", () => {
  const canary = "Synthetic user+tag@example.test /?=%!";
  const representations = reversibleRepresentations(canary);
  const input = {
    title: `unrelated-title ${representations.join(" | ")}`,
    url: `/account/${representations[1]}/${representations[4]}/${representations[5]}/${representations[6]}`,
    nested: { text: `unrelated-body ${representations.join(" ")}` },
  };
  const redacted = redactKnownCredentialValues(input, [canary]);
  const serialized = JSON.stringify(redacted);
  for (const representation of representations) assert.equal(serialized.includes(representation), false, representation);
  assert.match(redacted.title, /unrelated-title/);
  assert.match(redacted.nested.text, /unrelated-body/);
  assert.match(serialized, /REDACTED/);
});

test("agent pause gate is enforced and control generation changes across handoff", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-browser-control-"));
  try {
    const lookup = { projectCwd: root, persistence: "project" as const };
    const initial = assertBrowserAgentControl(lookup);
    const paused = setBrowserControlMode(lookup, "user", "synthetic sensitive step");
    assert.ok(paused.controlGeneration > initial);
    assert.throws(() => assertBrowserAgentControl(lookup), /paused/i);
    const resumed = setBrowserControlMode(lookup, "agent");
    assert.ok(resumed.controlGeneration > paused.controlGeneration);
    assert.doesNotThrow(() => assertBrowserAgentControl(lookup));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DOM, selector, and accessibility outputs redact sensitive canaries and public fill is rejected", { timeout: 45_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-browser-redaction-"));
  const lookup = { projectCwd: root, persistence: "project" as const };
  const previousTransport = process.env.WAYANG_BROWSER_TRANSPORT;
  process.env.WAYANG_BROWSER_TRANSPORT = "cdp";
  t.after(async () => {
    await stopBrowser(lookup).catch(() => undefined);
    if (previousTransport === undefined) delete process.env.WAYANG_BROWSER_TRANSPORT;
    else process.env.WAYANG_BROWSER_TRANSPORT = previousTransport;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const started = await startBrowser(lookup);
  assert.equal(started.status, "running", started.lastError);
  const password = "SYNTHETIC_DOM_PASSWORD_CANARY";
  const otp = "482951";
  const card = "4111111111111111";
  const html = `<input id="password" type="password" value="${password}"><input id="otp" autocomplete="one-time-code" value="${otp}"><input id="card-number" value="${card}">`;
  await navigateBrowser(lookup, `data:text/html,${encodeURIComponent(html)}`);

  const outputs = [
    await browserDomSnapshot(lookup),
    await queryBrowserSelector(lookup, "input"),
    await browserAccessibilitySnapshot(lookup),
  ];
  const serialized = JSON.stringify(outputs);
  for (const [outputIndex, output] of outputs.entries()) {
    const value = JSON.stringify(output);
    for (const [kind, canary] of [["password", password], ["otp", otp], ["card", card]] as const) {
      assert.equal(value.includes(canary), false, `${kind} leaked from output ${outputIndex}`);
    }
  }
  assert.match(serialized, /REDACTED/);
  await assert.rejects(() => fillBrowserSelector(lookup, "#password", "public-text"), /sensitive field/i);
  await clickBrowserSelector(lookup, "#otp");
  await assert.rejects(() => typePublicBrowser(lookup, "public-text"), /sensitive field/i);
});

test("credential gate follows document identity, unions sequential fills, redacts public state, and blocks every agent mutation", { timeout: 45_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-credential-inspection-"));
  const lookup = { projectCwd: root, persistence: "project" as const };
  const username = "Known User+tag@example.test";
  const password = "P@ss word:/?=%!";
  const totp = "593 104!";
  const knownValues = [username, password, totp];
  const allRepresentations = knownValues.flatMap(reversibleRepresentations);
  const exposedRepresentations = allRepresentations.join(" | ");
  const baseUrl = await localPageServer(t, (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url?.startsWith("/readonly")) return void res.end('<input id="password" type="password" readonly>');
    if (req.url?.startsWith("/ambiguous-totp")) return void res.end('<input autocomplete="one-time-code"><input name="otp">');
    if (req.url?.startsWith("/next")) return void res.end("<main>next page</main>");
    res.end(`<title>unrelated-title ${exposedRepresentations}</title>
      <main id="representations">unrelated-body ${exposedRepresentations}</main>
      <input id="username" autocomplete="username"><input id="password" type="password"><input id="otp" autocomplete="one-time-code">
      <button id="push" onclick="history.pushState({}, '', location.pathname + '/pushed')">push</button>
      <button id="replace" onclick="history.replaceState({}, '', location.pathname + '/replaced')">replace</button>
      <button id="hash" onclick="location.hash = 'same-document'">hash</button>
      <button id="failed" onclick="try { location.href = 'http://['; } catch {}">failed</button>`);
  });
  t.after(async () => {
    await stopBrowser(lookup).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await startBrowser(lookup);
  await navigateBrowser(lookup, `${baseUrl}/login/${encodeURIComponent(username)}`);
  setBrowserControlMode(lookup, "paused", "ordinary pause status test");
  assert.equal(getPublicBrowserStatus(lookup, "agent").activeUrl, undefined);
  assert.equal(getPublicBrowserStatus(lookup, "agent").activeTitle, undefined);
  setBrowserControlMode(lookup, "agent");

  const loginContext = await getBrowserCredentialContext(lookup);
  assert.deepEqual(await fillBrowserCredential(lookup, { username, password }, loginContext), ["username", "password"]);
  recordBrowserCredentialFill(lookup, loginContext, { username, password });
  const totpContext = await getBrowserCredentialContext(lookup);
  assert.equal(totpContext.documentIdentity, loginContext.documentIdentity);
  assert.deepEqual(await fillBrowserCredential(lookup, { totp }, totpContext), ["totp"]);
  recordBrowserCredentialFill(lookup, totpContext, { totp });

  const blockedStatus = getPublicBrowserStatus(lookup, "agent");
  assert.equal(blockedStatus.activeUrl, undefined);
  assert.equal(blockedStatus.activeTitle, undefined);
  assert.equal(blockedStatus.credentialInspection, "blocked");
  const postFillRuntime = fs.readFileSync(getBrowserStatus(lookup).profile.runtimePath, "utf8");
  for (const representation of allRepresentations) assert.equal(postFillRuntime.includes(representation), false, representation);
  assert.throws(() => setBrowserControlMode(lookup, "agent"), /UI-only credential route/i);

  const allowed = await allowAgentAfterCredentialFill(lookup);
  const generation = allowed.controlGeneration;
  const publicAfterAllow = JSON.stringify(getPublicBrowserStatus(lookup, "agent"));
  for (const representation of allRepresentations) assert.equal(publicAfterAllow.includes(representation), false, representation);
  assert.match(publicAfterAllow, /REDACTED/);
  assert.match(publicAfterAllow, /unrelated-title/);

  await assert.rejects(() => browserSnapshot(lookup, "screenshot", generation), /screenshots remain blocked/i);
  await assert.rejects(() => clickBrowserSelector(lookup, "#push", 0, generation), /mutations remain blocked/i);
  await assert.rejects(() => fillBrowserSelector(lookup, "#username", "changed", 0, generation), /mutations remain blocked/i);
  await assert.rejects(() => navigateBrowser(lookup, `${baseUrl}/next`, generation), /mutations remain blocked/i);

  const assertSameDocumentGate = async () => {
    assert.equal(getPublicBrowserStatus(lookup, "agent").credentialInspection, "text-allowed");
    await assert.rejects(() => browserSnapshot(lookup, "screenshot", generation), /screenshots remain blocked/i);
    const inspected = JSON.stringify(await browserDomSnapshot(lookup, { includeText: true }, generation));
    for (const representation of allRepresentations) assert.equal(inspected.includes(representation), false, representation);
    assert.match(inspected, /unrelated-body/);
  };
  await clickBrowserSelector(lookup, "#push");
  await assertSameDocumentGate();
  await clickBrowserSelector(lookup, "#replace");
  await assertSameDocumentGate();
  await clickBrowserSelector(lookup, "#hash");
  await assertSameDocumentGate();
  const sameDocumentUrl = (await getBrowserCredentialContext(lookup)).url.split("#", 1)[0];
  await navigateBrowser(lookup, `${sameDocumentUrl}#page-navigate-same-document`);
  await assertSameDocumentGate();
  await navigateBrowser(lookup, "http://[").catch(() => undefined);
  await assertSameDocumentGate();
  await clickBrowserSelector(lookup, "#failed");
  await assertSameDocumentGate();

  const redactedInspections = JSON.stringify([
    await browserSnapshot(lookup, "text", generation),
    await browserDomSnapshot(lookup, {}, generation),
    await queryBrowserSelector(lookup, "input", {}, generation),
  ]);
  for (const representation of allRepresentations) assert.equal(redactedInspections.includes(representation), false, representation);
  assert.match(redactedInspections, /REDACTED/);
  assert.match(redactedInspections, /unrelated-body/);

  const queryCanary = "RUNTIME_QUERY_CANARY";
  await navigateBrowser(lookup, `${baseUrl}/next?token=${queryCanary}#fragment-canary`);
  const screenshot = await browserSnapshot(lookup, "screenshot", generation);
  assert.ok(screenshot.screenshot?.startsWith("data:image/jpeg;base64,"));
  const agentState = getPublicBrowserStatus(lookup, "agent");
  assert.equal(agentState.credentialInspection, undefined);
  assert.equal(agentState.activeUrl, `${baseUrl}/next`);
  const persistedRecord = JSON.parse(fs.readFileSync(getBrowserStatus(lookup).profile.runtimePath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.entries(persistedRecord).filter(([, value]) => JSON.stringify(value).includes(queryCanary)).map(([key]) => key), []);
  assert.deepEqual(Object.entries(persistedRecord).filter(([, value]) => JSON.stringify(value).includes("fragment-canary")).map(([key]) => key), []);

  await navigateBrowser(lookup, `${baseUrl}/readonly`, generation);
  const readonlyContext = await getBrowserCredentialContext(lookup);
  await assert.rejects(() => fillBrowserCredential(lookup, { password }, readonlyContext), /exactly one eligible password field/i);
  await navigateBrowser(lookup, `${baseUrl}/ambiguous-totp`, generation);
  const ambiguousTotpContext = await getBrowserCredentialContext(lookup);
  await assert.rejects(() => fillBrowserCredential(lookup, { totp }, ambiguousTotpContext), /exactly one eligible verification-code field/i);
});

test("in-flight pause suppresses results and queued mutation never executes after generation changes", { timeout: 45_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-control-race-"));
  const lookup = { projectCwd: root, persistence: "project" as const };
  const baseUrl = await localPageServer(t, (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const send = () => res.end('<input id="marker" value="original">');
    if (req.url?.startsWith("/slow")) setTimeout(send, 300);
    else send();
  });
  t.after(async () => {
    await stopBrowser(lookup).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });
  await startBrowser(lookup);
  await navigateBrowser(lookup, `${baseUrl}/initial`);
  const generation = assertBrowserAgentControl(lookup);
  const navigating = navigateBrowser(lookup, `${baseUrl}/slow`, generation);
  const queuedFill = fillBrowserSelector(lookup, "#marker", "changed", 0, generation);
  await new Promise((resolve) => setTimeout(resolve, 60));
  setBrowserControlMode(lookup, "user", "synthetic in-flight pause");
  await assert.rejects(navigating, /control changed/i);
  await assert.rejects(queuedFill, /control changed/i);
  setBrowserControlMode(lookup, "agent");
  const marker = await queryBrowserSelector(lookup, "#marker");
  assert.equal(marker.elements[0]?.value, "original");
});

test("stopAllBrowsers preserves explicit persistence and browser lifecycle invokes credential locks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-stop-all-scope-"));
  const projectLookup = { projectCwd: path.join(root, "project"), persistence: "project" as const };
  const sessionLookup = { projectCwd: path.join(root, "project"), persistence: "session" as const };
  fs.mkdirSync(projectLookup.projectCwd, { recursive: true });
  let locks = 0;
  const unregister = registerBrowserStopHook(async () => { locks += 1; });
  try {
    setBrowserControlMode(projectLookup, "paused", "scope test");
    setBrowserControlMode(sessionLookup, "paused", "scope test");
    const projectBefore = JSON.parse(fs.readFileSync(getBrowserStatus(projectLookup).profile.runtimePath, "utf8")).updatedAt;
    const sessionBefore = JSON.parse(fs.readFileSync(getBrowserStatus(sessionLookup).profile.runtimePath, "utf8")).updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await stopAllBrowsers();
    const projectAfter = JSON.parse(fs.readFileSync(getBrowserStatus(projectLookup).profile.runtimePath, "utf8")).updatedAt;
    const sessionAfter = JSON.parse(fs.readFileSync(getBrowserStatus(sessionLookup).profile.runtimePath, "utf8")).updatedAt;
    assert.ok(projectAfter > projectBefore);
    assert.ok(sessionAfter > sessionBefore);
    assert.ok(locks >= 2);
  } finally {
    unregister();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser URL sanitizer removes userinfo, query, and fragment", () => {
  assert.equal(sanitizeBrowserUrl("https://user:pass@example.test/path?q=secret#fragment"), "https://example.test/path");
  assert.equal(sanitizeBrowserUrl("data:text/plain,secret"), "data:");
});

test("active page selection uses one uniquely visible target and otherwise preserves tracked target", () => {
  const targets = [
    { id: "background", type: "page", url: "https://background.example", webSocketDebuggerUrl: "ws://background" },
    { id: "active", type: "page", url: "https://active.example", webSocketDebuggerUrl: "ws://active" },
  ];
  assert.equal(selectActivePageTarget(targets, ["background"], "active")?.id, "background");
  assert.equal(selectActivePageTarget(targets, [], "active")?.id, "active");
  assert.equal(selectActivePageTarget(targets, ["background", "active"], "active")?.id, "active");
  assert.equal(selectPageTarget(targets, undefined, "https://active.example")?.id, "active");
});

const SYNTHETIC_HOME = "/synthetic/home";

test("Chromium candidates preserve configured, Playwright, then system precedence", () => {
  assert.deepEqual(
    getChromiumCandidates("/configured/chrome", "linux", "x64", SYNTHETIC_HOME, ["chromium-1234"]),
    [
      "/configured/chrome",
      "/synthetic/home/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      "/synthetic/home/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/opt/google/chrome/chrome",
    ],
  );
});

test("macOS uses the Playwright cache under Library/Caches", () => {
  assert.equal(getPlaywrightCacheRoot("darwin", SYNTHETIC_HOME), "/synthetic/home/Library/Caches/ms-playwright");
});

test("macOS system candidates include system and per-user Chrome and Chromium applications", () => {
  assert.deepEqual(getSystemChromiumCandidates("darwin", SYNTHETIC_HOME), [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/synthetic/home/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/synthetic/home/Applications/Chromium.app/Contents/MacOS/Chromium",
  ]);
});

test("macOS x64 processes on Apple Silicon use only arm64 Playwright candidates", () => {
  assert.equal(getChromiumHostArchitecture("darwin", "x64", ["Virtual CPU", "Apple M2 Max"]), "arm64");
  const candidates = getChromiumCandidates(
    undefined,
    "darwin",
    "x64",
    SYNTHETIC_HOME,
    ["chromium-1234", "chromium_headless_shell-1234"],
    ["Virtual CPU", "Apple M2 Max"],
  );

  assert.ok(candidates.some((candidate) => candidate.includes("chrome-mac-arm64")));
  assert.ok(candidates.some((candidate) => candidate.includes("chrome-headless-shell-mac-arm64")));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-mac-x64")));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-headless-shell-mac-x64")));
});

test("macOS x64 processes on Intel use only x64 Playwright candidates", () => {
  assert.equal(getChromiumHostArchitecture("darwin", "x64", ["Intel(R) Core(TM) i7"]), "x64");
  const candidates = getChromiumCandidates(
    undefined,
    "darwin",
    "x64",
    SYNTHETIC_HOME,
    ["chromium-1234", "chromium_headless_shell-1234"],
    ["Intel(R) Core(TM) i7"],
  );

  assert.ok(candidates.some((candidate) => candidate.includes("chrome-mac-x64")));
  assert.ok(candidates.some((candidate) => candidate.includes("chrome-headless-shell-mac-x64")));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-mac-arm64")));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-headless-shell-mac-arm64")));
});

test("macOS with unknown process architecture and CPU probes both Playwright architectures", () => {
  assert.equal(getChromiumHostArchitecture("darwin", "riscv64", ["Unknown CPU"]), "riscv64");
  const candidates = getChromiumCandidates(
    undefined,
    "darwin",
    "riscv64",
    SYNTHETIC_HOME,
    ["chromium-1234", "chromium_headless_shell-1234"],
    ["Unknown CPU"],
  );

  assert.ok(candidates.some((candidate) => candidate.includes("chrome-mac-arm64")));
  assert.ok(candidates.some((candidate) => candidate.includes("chrome-mac-x64")));
  assert.ok(candidates.some((candidate) => candidate.includes("chrome-headless-shell-mac-arm64")));
  assert.ok(candidates.some((candidate) => candidate.includes("chrome-headless-shell-mac-x64")));
});

test("Linux Chromium candidates preserve the process architecture and ignore CPU model strings", () => {
  assert.equal(getChromiumHostArchitecture("linux", "x64", ["Apple M2 Max"]), "x64");
  assert.deepEqual(
    getChromiumCandidates(undefined, "linux", "x64", SYNTHETIC_HOME, ["chromium-1234"], ["Apple M2 Max"]),
    [
      "/synthetic/home/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      "/synthetic/home/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/opt/google/chrome/chrome",
    ],
  );
});

test("Linux Playwright headless-shell entries produce no candidates", () => {
  assert.deepEqual(
    getPlaywrightChromiumCandidates("linux", "x64", SYNTHETIC_HOME, ["chromium_headless_shell-1234"]),
    [],
  );
});

test("macOS Playwright candidates include only arm64 layouts when arm64 is requested", () => {
  const candidates = getPlaywrightChromiumCandidates(
    "darwin",
    "arm64",
    SYNTHETIC_HOME,
    ["chromium-1234", "chromium_headless_shell-1234"],
  );
  const chromiumArm64 = "/synthetic/home/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  const shellArm64 = "/synthetic/home/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";

  assert.ok(candidates.includes(chromiumArm64));
  assert.ok(candidates.includes(shellArm64));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-mac-x64")));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-headless-shell-mac-x64")));
});

test("macOS Playwright candidates include only x64 layouts when x64 is requested", () => {
  const candidates = getPlaywrightChromiumCandidates(
    "darwin",
    "x64",
    SYNTHETIC_HOME,
    ["chromium-1234", "chromium_headless_shell-1234"],
  );
  const chromiumX64 = "/synthetic/home/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  const shellX64 = "/synthetic/home/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-x64/chrome-headless-shell";

  assert.ok(candidates.includes(chromiumX64));
  assert.ok(candidates.includes(shellX64));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-mac-arm64")));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-headless-shell-mac-arm64")));
});

test("macOS Playwright Chromium entries retain the legacy Chromium app layout", () => {
  assert.ok(
    getPlaywrightChromiumCandidates("darwin", "arm64", SYNTHETIC_HOME, ["chromium-1234"]).includes(
      "/synthetic/home/Library/Caches/ms-playwright/chromium-1234/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    ),
  );
});

test("Playwright cache entries are ordered by newest revision across Chromium products", () => {
  const candidates = getPlaywrightChromiumCandidates(
    "darwin",
    "arm64",
    SYNTHETIC_HOME,
    ["chromium-1233", "chromium_headless_shell-1234"],
  );

  assert.match(candidates[0], /chromium_headless_shell-1234/);
  assert.ok(candidates.findIndex((candidate) => candidate.includes("chromium-1233")) > 0);
});

test("Playwright cache entries prefer full Chromium over headless shell at the same revision", () => {
  const candidates = getPlaywrightChromiumCandidates(
    "darwin",
    "arm64",
    SYNTHETIC_HOME,
    ["chromium_headless_shell-1234", "chromium-1234"],
  );
  const chromiumIndex = candidates.findIndex((candidate) => candidate.includes("chromium-1234"));
  const shellIndex = candidates.findIndex((candidate) => candidate.includes("chromium_headless_shell-1234"));

  assert.ok(chromiumIndex >= 0);
  assert.ok(shellIndex >= 0);
  assert.ok(chromiumIndex < shellIndex);
});

test("Linux retains its Playwright cache root and Chromium layouts", () => {
  assert.equal(getPlaywrightCacheRoot("linux", SYNTHETIC_HOME), "/synthetic/home/.cache/ms-playwright");
  assert.deepEqual(getPlaywrightChromiumCandidates("linux", "arm64", SYNTHETIC_HOME, ["chromium-1234"]), [
    "/synthetic/home/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    "/synthetic/home/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
  ]);
});
