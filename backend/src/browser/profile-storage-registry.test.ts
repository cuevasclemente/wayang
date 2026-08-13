import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  BrowserStorageOwnershipRegistry,
  assertBrowserStorageAncestorsSafe,
  resolveBrowserProfileStorageDescriptor,
} from "./profile-storage-registry.js";
import { browserProfileStorageIdentityDigest, type BrowserProfileRow } from "./profile-catalog-store.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-browser-storage-registry-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const source = { kind: "managed" as const, storage_key: "synthetic" };
  const profile: BrowserProfileRow = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Synthetic",
    storage_source: source,
    storage_identity_digest: browserProfileStorageIdentityDigest(dataDir, source),
    state: "active",
    revision: 1,
    created_at: 1,
    updated_at: 1,
  };
  return { root, dataDir, profile };
}

test("one canonical storage identity has at most one opener owner", () => {
  const f = fixture();
  try {
    const descriptor = resolveBrowserProfileStorageDescriptor(f.dataDir, f.profile);
    assertBrowserStorageAncestorsSafe(f.dataDir, descriptor);
    const registry = new BrowserStorageOwnershipRegistry();
    const first = registry.claim(descriptor, "host-a");
    const nested = registry.claim(descriptor, "host-a");
    assert.equal(registry.activeCount(), 1);
    assert.throws(() => registry.claim(descriptor, "host-b"), /already open/);
    nested.release();
    assert.equal(registry.isOpen(descriptor.identityDigest), true);
    first.release();
    assert.equal(registry.activeCount(), 0);
    const second = registry.claim(descriptor, "host-b");
    second.release();
    registry.close();
    assert.throws(() => registry.claim(descriptor, "host-c"), /closed/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("storage descriptor rejects digest drift and unsafe existing ancestors", () => {
  const f = fixture();
  try {
    assert.throws(
      () => resolveBrowserProfileStorageDescriptor(f.dataDir, { ...f.profile, storage_identity_digest: "0".repeat(64) }),
      /identity changed/,
    );
    const descriptor = resolveBrowserProfileStorageDescriptor(f.dataDir, f.profile);
    fs.mkdirSync(path.dirname(descriptor.root), { recursive: true, mode: 0o700 });
    fs.symlinkSync(f.dataDir, descriptor.root);
    assert.throws(() => assertBrowserStorageAncestorsSafe(f.dataDir, descriptor), /ancestor is unsafe/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
