import assert from "node:assert/strict";
import test from "node:test";
import {
  closePiSessionAuthorities,
  piSessionHandleRequiresFreshRuntime,
  type PiSessionHandle,
} from "../pi-bridge.js";

test("Pi bridge fresh-runtime seam treats denied or unavailable automation preflight as stale", () => {
  const handle = (preflight?: () => { allowed: true } | { allowed: false; reason: string }) => ({
    protectedAutomationRuntime: preflight ? { preflight } as any : undefined,
  });

  assert.equal(piSessionHandleRequiresFreshRuntime(handle()), false);
  assert.equal(piSessionHandleRequiresFreshRuntime(handle(() => ({ allowed: true }))), false);
  assert.equal(piSessionHandleRequiresFreshRuntime(handle(() => ({ allowed: false, reason: "synthetic drift" }))), true);
  assert.equal(piSessionHandleRequiresFreshRuntime(handle(() => { throw new Error("synthetic unavailable preflight"); })), true);
  assert.equal(piSessionHandleRequiresFreshRuntime({ capabilityAuthorityDenied: true }), true);
});

test("Pi bridge authority-close seam closes the exact browser and automation runtimes once", async () => {
  let browserCloses = 0;
  let automationCloses = 0;
  let aborts = 0;
  const browserRuntime = {
    async detachAgentLease() { browserCloses += 1; },
    async closeSessionWorkspaces() { browserCloses += 1; },
    async revokeAuthority() { browserCloses += 1; },
  };
  const automationRuntime = {
    async close() { automationCloses += 1; },
  };
  const fakeSession: any = {
    clearQueue() { return { steering: [], followUp: [] }; },
    setActiveToolsByName() {},
    async abort() { aborts += 1; },
    _toolRegistry: new Map([
      ["protected_browser", { name: "protected_browser" }],
      ["protected_automation", { name: "protected_automation" }],
    ]),
    _toolDefinitions: new Map([
      ["protected_browser", {}],
      ["protected_automation", {}],
    ]),
    agent: { state: { tools: [] }, async beforeToolCall() { return undefined; } },
  };
  const handle = {
    id: "synthetic-protected-automation-lifecycle",
    session: fakeSession,
    runtimeGeneration: "captured-generation",
    bashMode: "sandboxed",
    protectedBrowserRuntime: browserRuntime,
    protectedAutomationRuntime: automationRuntime,
    interactiveTurns: new Map(),
  } as unknown as PiSessionHandle;

  await closePiSessionAuthorities(handle);
  await closePiSessionAuthorities(handle);

  assert.equal(handle.capabilityAuthorityDenied, true);
  assert.notEqual(handle.runtimeGeneration, "captured-generation");
  assert.equal(handle.protectedBrowserRuntime, undefined);
  assert.equal(handle.protectedAutomationRuntime, undefined);
  assert.equal(fakeSession._toolRegistry.has("protected_browser"), false);
  assert.equal(fakeSession._toolRegistry.has("protected_automation"), false);
  assert.equal(fakeSession._toolDefinitions.has("protected_browser"), false);
  assert.equal(fakeSession._toolDefinitions.has("protected_automation"), false);
  assert.equal(browserCloses, 1, "the captured browser runtime closes exactly once");
  assert.equal(automationCloses, 1, "the captured automation runtime closes exactly once");
  assert.equal(aborts, 1, "agent abort starts once with authority cleanup");
});
