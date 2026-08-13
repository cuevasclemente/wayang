import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { CapabilityBoundProtectedBrowser } from "../browser/protected-browser.js";
import { close as closeStore, init as initStore } from "../db.js";
import { PROTECTED_BROWSER_CAPABILITY_ID, type ProtectedBrowserAuthoritySnapshot, type ProtectedBrowserBinding } from "../browser/types.js";
import {
  attachSelectedProtectedViewer,
  protectedBrowserSelectionInput,
  validateProtectedBrowserBodySelection,
  validateProtectedBrowserSelection,
} from "./protected-browser.js";

const syntheticDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-routes-"));
const previousDataDir = process.env.WAYANG_DATA_DIR;
process.env.WAYANG_DATA_DIR = syntheticDataDir;
initStore();
test.after(() => {
  closeStore();
  if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
  else process.env.WAYANG_DATA_DIR = previousDataDir;
  fs.rmSync(syntheticDataDir, { recursive: true, force: true });
});

const binding: ProtectedBrowserBinding = {
  capabilityId: PROTECTED_BROWSER_CAPABILITY_ID,
  sourceSessionId: "synthetic-protected-session",
  projectId: "synthetic-protected-project",
  projectCwd: "/synthetic/protected-project",
  agentProfileId: "synthetic-protected-profile",
  associationRevision: 1,
  runtimeGeneration: "synthetic-runtime-generation",
  processBootNonce: "synthetic-process-boot",
  controlGeneration: 5,
};

test("protected route selection requires the exact bound session and project", () => {
  const selected = validateProtectedBrowserSelection({ binding }, {
    sourceSessionId: binding.sourceSessionId,
    targetSessionId: binding.sourceSessionId,
    projectCwd: binding.projectCwd,
    transport: "http",
  });
  assert.deepEqual(selected.binding, binding);
  assert.notEqual(selected.binding, binding, "the route retains its own immutable selection copy");

  assert.throws(() => validateProtectedBrowserSelection({ binding }, {
    sourceSessionId: binding.sourceSessionId,
    targetSessionId: "other-session",
    projectCwd: binding.projectCwd,
    transport: "http",
  }), /exact bound session/i);
  assert.throws(() => validateProtectedBrowserSelection({ binding }, {
    sourceSessionId: "other-source",
    targetSessionId: binding.sourceSessionId,
    projectCwd: binding.projectCwd,
    transport: "http",
  }), /source binding/i);
  assert.throws(() => validateProtectedBrowserSelection({ binding }, {
    targetSessionId: binding.sourceSessionId,
    projectCwd: "/synthetic/other-project",
    transport: "vnc",
  }), /project binding/i);
  assert.throws(() => validateProtectedBrowserSelection({ binding }, {
    targetSessionId: binding.sourceSessionId,
    projectCwd: binding.projectCwd,
    transport: "vnc",
  }), /VNC transport is unavailable/i);
});

test("protected HTTP and CDP selection reject every caller persistence or scope selector", () => {
  for (const transport of ["http", "cdp"] as const) {
    for (const value of ["shared", "project", "session", "unknown", ""] as const) {
      for (const selector of ["persistence", "scope"] as const) {
        const request = {
          url: `/api/browser/status?session_id=${encodeURIComponent(binding.sourceSessionId)}&${selector}=${encodeURIComponent(value)}`,
          headers: {},
        } as IncomingMessage;
        const input = protectedBrowserSelectionInput(request, transport);
        assert.throws(
          () => validateProtectedBrowserSelection({ binding }, input),
          /backend-issued only/i,
          `${transport} accepted ${selector}=${value}`,
        );
      }
    }
  }
});

test("protected CDP query selection rejects duplicate persistence and scope selectors", () => {
  for (const query of [
    "persistence=shared&persistence=project",
    "persistence=project&persistence=session",
    "scope=shared&scope=unknown",
    "scope=session&scope=project",
    "persistence=project&scope=session",
  ]) {
    const request = {
      url: `/ws/browser?session_id=${encodeURIComponent(binding.sourceSessionId)}&${query}`,
      headers: {},
    } as IncomingMessage;
    const input = protectedBrowserSelectionInput(request, "cdp");
    assert.throws(
      () => validateProtectedBrowserSelection({ binding }, input),
      /backend-issued only/i,
      `CDP selection accepted ${query}`,
    );
  }
});

test("protected HTTP bodies cross-check every target alias and reject scope selectors", () => {
  for (const body of [
    { sessionId: binding.sourceSessionId },
    { session_id: binding.sourceSessionId },
    { projectCwd: binding.projectCwd },
    { project_cwd: binding.projectCwd },
    {
      sessionId: binding.sourceSessionId,
      session_id: binding.sourceSessionId,
      projectCwd: binding.projectCwd,
      project_cwd: binding.projectCwd,
    },
  ]) assert.doesNotThrow(() => validateProtectedBrowserBodySelection(body, { binding }));

  for (const body of [
    { sessionId: "other-session" },
    { session_id: "other-session" },
    { sessionId: binding.sourceSessionId, session_id: "other-session" },
    { projectCwd: "/synthetic/other-project" },
    { project_cwd: "/synthetic/other-project" },
    { projectCwd: binding.projectCwd, project_cwd: "/synthetic/other-project" },
  ]) assert.throws(() => validateProtectedBrowserBodySelection(body, { binding }), /body does not match/i);

  for (const value of ["shared", "project", "session", "unknown", ""] as const) {
    assert.throws(() => validateProtectedBrowserBodySelection({ persistence: value }, { binding }), /backend-issued only/i);
    assert.throws(() => validateProtectedBrowserBodySelection({ scope: value }, { binding }), /backend-issued only/i);
  }
});

test("protected route selection rejects malformed or non-capability bindings", () => {
  assert.throws(() => validateProtectedBrowserSelection({ binding: { ...binding, capabilityId: "wrong" } as any }, {
    targetSessionId: binding.sourceSessionId,
    transport: "cdp",
  }), /capability authority/i);
  assert.throws(() => validateProtectedBrowserSelection({ binding: { ...binding, controlGeneration: -1 } }, {
    targetSessionId: binding.sourceSessionId,
    transport: "http",
  }), /invalid/i);
  for (const staleTupleField of [{ provider: "stale-provider" }, { model: "stale-model" }]) {
    assert.throws(() => validateProtectedBrowserSelection({ binding: { ...binding, ...staleTupleField } as any }, {
      targetSessionId: binding.sourceSessionId,
      transport: "http",
    }), /invalid/i);
  }
});

test("upgraded protected CDP viewer dispatch reauthorizes every message and closes on revocation", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-route-viewer-"));
  let current: ProtectedBrowserAuthoritySnapshot = {
    ...binding,
    authorized: true,
    privacyMode: "protected",
    sourceSessionDurable: true,
    sourceQuarantined: false,
    profileEnabled: true,
    projectAllowsProfile: true,
  };
  const browser = new CapabilityBoundProtectedBrowser({
    dataDir,
    binding,
    authority: { resolve() { return { ...current }; } },
    backend: { async execute() { return { value: null }; }, stop() {} },
  });
  let dispatches = 0;
  let transportCloses = 0;
  const transport = {
    dispatch() { dispatches += 1; },
    close() { transportCloses += 1; },
    onMessage() { return () => undefined; },
  };
  const syntheticSocket: { readyState: number; send(): void; close(): void } = {
    readyState: 1,
    send() {},
    close() { syntheticSocket.readyState = 3; },
  };
  const fakeWs = syntheticSocket as unknown as WebSocket;
  try {
    const integration = {
      select() { return { binding }; },
      resolve() { return { browser }; },
      openViewer() { return transport; },
    };
    await assert.rejects(
      attachSelectedProtectedViewer(fakeWs, { binding }, "vnc", integration),
      /VNC transport is unavailable/i,
    );
    const viewer = await attachSelectedProtectedViewer(fakeWs, { binding }, "cdp", integration);
    await viewer.handleMessage(Buffer.from("one"), false);
    await viewer.handleMessage(Buffer.from("two"), true);
    assert.equal(dispatches, 2);

    current = { ...current, authorized: false };
    await assert.rejects(viewer.handleMessage(Buffer.from("denied"), true), /authority changed/i);
    assert.equal(dispatches, 2, "revoked message never reached the upgraded transport");
    await browser.revoke();
    assert.equal(transportCloses, 1);
    assert.equal(syntheticSocket.readyState, 3, "the already-upgraded CDP websocket closes on revocation");
  } finally {
    await browser.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
