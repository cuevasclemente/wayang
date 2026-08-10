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

test("capability-bound runtime exposes explicit browser tools without a download permit protocol", async () => {
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
    assert.deepEqual(runtime.tools.map((tool) => tool.name), [
      "browser_status", "browser_open", "browser_navigate", "browser_snapshot", "browser_dom_snapshot",
      "browser_query_selector", "browser_click_selector", "browser_fill_selector", "browser_extract_links",
      "browser_accessibility_snapshot", "browser_click", "browser_type_public", "browser_wait_for_user",
      "browser_resume_status", "browser_close",
    ]);
    const navigateTool = runtime.toolForName("browser_navigate");
    assert.ok(navigateTool);
    const navigate = await (navigateTool.execute as any)("navigate", { url: "https://example.invalid/path" });
    assert.match(navigate.content[0].text, /navigate/);
    assert.deepEqual(browserOps, ["navigate"]);
    assert.equal(runtime.toolForName("protected_browser"), undefined);
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
    const navigateTool = runtime.toolForName("browser_navigate");
    const statusTool = runtime.toolForName("browser_status");
    assert.ok(navigateTool && statusTool);
    await assert.rejects(() => (navigateTool.execute as any)("navigate", { url: "https://example.invalid" }), /synthetic coordinator denial/);
    assert.equal(runtime.preflight().allowed, false);
    await assert.rejects(() => (statusTool.execute as any)("stale", {}), /revoked/);
  } finally {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
