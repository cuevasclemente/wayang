import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { CapabilityBoundProtectedBrowser } from "./protected-browser.js";
import { createProtectedBrowserToolRuntime } from "./protected-tools.js";
import type { ProtectedBrowserAuthoritySnapshot, ProtectedBrowserBinding } from "./types.js";

function binding(): ProtectedBrowserBinding {
  return {
    capabilityId: "wayang.protected-browser.v1",
    sourceSessionId: "source",
    projectId: "project",
    projectCwd: path.resolve("/synthetic/project"),
    agentProfileId: "profile",
    associationRevision: 1,
    runtimeGeneration: "generation",
    processBootNonce: "boot",
    controlGeneration: 1,
  };
}

function snapshot(exact: ProtectedBrowserBinding): ProtectedBrowserAuthoritySnapshot {
  return { ...exact, authorized: true, privacyMode: "protected", sourceSessionDurable: true, sourceQuarantined: false, profileEnabled: true, projectAllowsProfile: true };
}

test("protected tool exposes ordinary browser operations without a download permit protocol", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-tools-"));
  const exact = binding();
  const browserOps: string[] = [];
  const browser = new CapabilityBoundProtectedBrowser({
    dataDir: root,
    binding: exact,
    authority: { resolve: async () => snapshot(exact) },
    backend: {
      async execute(operation, context) {
        browserOps.push(operation.kind);
        if (!["status", "start", "stop"].includes(operation.kind)) await context.assertAuthorized("pre-cdp");
        return { value: { operation: operation.kind }, topLevelUrl: operation.kind === "navigate" ? operation.url : "https://example.invalid/" };
      },
      stop() {},
    },
  });
  const runtime = createProtectedBrowserToolRuntime({ browser });
  try {
    const navigate = await (runtime.tool.execute as any)("navigate", { operation: "navigate", url: "https://example.invalid/path" });
    assert.match(navigate.content[0].text, /navigate/);
    assert.deepEqual(browserOps, ["navigate"]);
    await assert.rejects(
      () => (runtime.tool.execute as any)("legacy", { operation: "arm_next_download" }),
      /validation|schema|union|operation/i,
    );
  } finally {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("protected tool latches denial after a browser coordinator failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-tools-denial-"));
  const exact = binding();
  const browser = new CapabilityBoundProtectedBrowser({
    dataDir: root,
    binding: exact,
    authority: { resolve: async () => snapshot(exact) },
    backend: { async execute() { throw new Error("synthetic coordinator denial"); }, stop() {} },
  });
  const runtime = createProtectedBrowserToolRuntime({ browser });
  try {
    await assert.rejects(() => (runtime.tool.execute as any)("navigate", { operation: "navigate", url: "https://example.invalid" }), /synthetic coordinator denial/);
    assert.equal(runtime.preflight().allowed, false);
    await assert.rejects(() => (runtime.tool.execute as any)("stale", { operation: "status" }), /revoked/);
  } finally {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
