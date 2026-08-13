import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ChromeTarget } from "./cdp.js";
import { createStandardBrowserHostBackendFactory, type StandardManagedChromiumPort } from "./standard-production.js";
import type { ManagedChromiumPageAttachment, ManagedChromiumRuntimeOptions } from "./manager.js";
import type { BrowserProfileRow } from "./profile-catalog-store.js";

class FakeManaged implements StandardManagedChromiumPort {
  running = false;
  targets: ChromeTarget[] = [{ id: "restored", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://synthetic" }];
  closed: string[] = [];
  attaches = 0;
  constructor(readonly options: ManagedChromiumRuntimeOptions) {}
  async start(authorize?: () => Promise<void>) { await authorize?.(); this.running = true; }
  async stop() { this.running = false; }
  async listPageTargets() { return this.targets.map((target) => ({ ...target })); }
  async createPageTarget(url = "about:blank") { const target = { id: "created", type: "page", url, webSocketDebuggerUrl: "ws://synthetic" }; this.targets.push(target); return target; }
  async closePageTarget(targetId: string) { this.closed.push(targetId); this.targets = this.targets.filter((target) => target.id !== targetId); }
  async attachTargetCdpViewer(): Promise<ManagedChromiumPageAttachment> { this.attaches += 1; throw new Error("synthetic attachment should not run"); }
}

const profile: BrowserProfileRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Synthetic",
  storage_source: { kind: "managed", storage_key: "synthetic" },
  storage_identity_digest: "a".repeat(64),
  state: "active",
  revision: 1,
  created_at: 1,
  updated_at: 1,
};

test("Standard production binds one exact profile root and explicit target lifecycle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-standard-production-"));
  try {
    let managed!: FakeManaged;
    const factory = createStandardBrowserHostBackendFactory({
      dataDir: root,
      managedFactory: (options) => { managed = new FakeManaged(options); return managed; },
    });
    const events: string[] = [];
    const backend = factory({
      profile,
      storage: { profileId: profile.id, root: path.join(root, "profile"), identityDigest: profile.storage_identity_digest },
      callbacks: {
        targetCreated: (target) => events.push(`created:${target.id}`),
        targetChanged: (target) => events.push(`changed:${target.id}`),
        targetDestroyed: (targetId) => events.push(`destroyed:${targetId}`),
        unexpectedExit: () => events.push("exit"),
      },
    });
    assert.equal(fs.existsSync(path.join(root, "profile")), false, "factory opened profile storage before host start");
    assert.equal(managed.options.profileDir, path.join(root, "profile"));
    assert.equal(managed.options.downloadsDir, path.join(root, "browser-profiles", "v1", "download-staging", profile.id));
    await backend.start(async () => undefined);
    assert.equal((await backend.listTargets())[0]?.id, "restored");
    assert.equal((await backend.createTarget("about:blank")).id, "created");
    await backend.closeTarget("created");
    managed.options.onTargetCreated?.({ id: "popup", type: "page", openerId: "restored", url: "https://popup.example" });
    managed.options.onTargetChanged?.({ id: "popup", type: "page", url: "https://changed.example" });
    managed.options.onTargetDestroyed?.("popup");
    assert.deepEqual(events, ["created:popup", "changed:popup", "destroyed:popup"]);
    await assert.rejects(
      () => backend.execute("restored", { kind: "navigate", url: "http://not-https.example" }, async () => undefined),
      /absolute HTTPS/,
    );
    assert.equal(managed.attaches, 0, "invalid navigation reached target CDP");
    await backend.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
