import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ManagedChromiumRuntimeOptions } from "./manager.js";
import { bootstrapProtectedBrowserProduction, type ProtectedManagedChromiumPort } from "./protected-production.js";
import type { ProtectedBrowserAuthoritySnapshot, ProtectedBrowserBinding } from "./types.js";

function binding(projectCwd: string): ProtectedBrowserBinding {
  return {
    capabilityId: "wayang.protected-browser.v1",
    sourceSessionId: "never-started-source",
    projectId: "never-started-project",
    projectCwd,
    agentProfileId: "never-started-profile",
    associationRevision: 1,
    runtimeGeneration: "never-started-generation",
    processBootNonce: "synthetic-boot",
    controlGeneration: 1,
  };
}

function allowed(exact: Readonly<ProtectedBrowserBinding>): ProtectedBrowserAuthoritySnapshot {
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

class NeverStartedManaged implements ProtectedManagedChromiumPort {
  running = false;
  starts = 0;
  stops = 0;
  constructor(readonly options: ManagedChromiumRuntimeOptions) {}
  async start(): Promise<void> { this.starts += 1; this.running = true; }
  async stop(): Promise<void> { this.stops += 1; this.running = false; }
  async cancelDownload(): Promise<void> {}
  async attachPageCdpViewer(): Promise<never> { throw new Error("never started"); }
}

test("closing a never-started production runtime performs one final ManagedChromium stop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-never-started-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project, { mode: 0o700 });
  const exact = binding(fs.realpathSync.native(project));
  let managed: NeverStartedManaged | undefined;
  const production = bootstrapProtectedBrowserProduction({
    dataDir: path.join(root, "data"),
    owner: { resolve() { return null; } },
    authorityResolver(current) { return allowed(current); },
    pairAuthorityResolver() { return true; },
    managedChromiumFactory(options) {
      managed = new NeverStartedManaged(options);
      return managed;
    },
    installFactory() { return () => undefined; },
    subscribePolicy() { return () => undefined; },
  });
  try {
    const runtime = await production.factory(exact);
    assert.ok(managed);
    assert.equal(managed.starts, 0);
    await runtime.close();
    assert.equal(managed.starts, 0);
    assert.equal(managed.stops, 0, "closing one runtime lease preserves the pair realm");
    await runtime.close();
    assert.equal(managed.stops, 0, "repeated lease close remains one-shot");
  } finally {
    await production.close();
    assert.equal(managed?.stops, 1, "bootstrap close performs one final pair-realm stop");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
