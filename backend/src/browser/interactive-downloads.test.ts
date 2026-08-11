import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ManagedChromiumRuntime } from "./manager.js";
import {
  InteractiveBrowserDownloadPublisher,
  MAX_INTERACTIVE_BROWSER_DOWNLOAD_BYTES,
  MAX_INTERACTIVE_BROWSER_DOWNLOADS,
} from "./interactive-downloads.js";

const browserIntegrationTest = process.env.WAYANG_BROWSER_INTEGRATION === "1" ? test : test.skip;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-interactive-downloads-"));
  const staging = path.join(root, "private", "downloads");
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  return { root, staging, project, publisher: new InteractiveBrowserDownloadPublisher(staging, project) };
}

function begin(publisher: InteractiveBrowserDownloadPublisher, guid: string, name = "transcript.txt") {
  return publisher.begin({ frameId: "frame", guid, url: "https://notes.granola.ai/download", suggestedFilename: name });
}

test("completed downloads publish exclusively as bounded ordinary Project files", async () => {
  const f = fixture();
  try {
    assert.deepEqual(begin(f.publisher, "guid_one"), { accepted: true });
    const body = "synthetic transcript\n";
    fs.writeFileSync(path.join(f.staging, "guid_one"), body, { mode: 0o600 });
    let checks = 0;
    const result = await f.publisher.progress({
      guid: "guid_one", state: "completed", totalBytes: Buffer.byteLength(body), receivedBytes: Buffer.byteLength(body),
    }, async () => { checks += 1; });
    assert.equal(result.cancel, false);
    assert.equal(checks, 1);
    assert.equal(result.state?.relativePath, ".wayang/browser-downloads/transcript.txt");
    assert.equal(fs.readFileSync(path.join(f.project, result.state!.relativePath!), "utf8"), body);
    assert.equal(fs.existsSync(path.join(f.staging, "guid_one")), false);
    assert.equal(fs.statSync(path.join(f.project, result.state!.relativePath!)).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("download publication sanitizes names, preserves existing files, and rejects non-HTTPS sources", async () => {
  const f = fixture();
  try {
    const output = path.join(f.project, ".wayang", "browser-downloads");
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "transcript.txt"), "existing", { mode: 0o600 });
    assert.deepEqual(begin(f.publisher, "guid_two", "../transcript.txt"), { accepted: true });
    fs.writeFileSync(path.join(f.staging, "guid_two"), "new", { mode: 0o600 });
    const result = await f.publisher.progress({ guid: "guid_two", state: "completed", totalBytes: 3, receivedBytes: 3 }, async () => undefined);
    assert.equal(result.state?.relativePath, ".wayang/browser-downloads/transcript-1.txt");
    assert.equal(fs.readFileSync(path.join(output, "transcript.txt"), "utf8"), "existing");
    assert.equal(fs.readFileSync(path.join(output, "transcript-1.txt"), "utf8"), "new");
    assert.deepEqual(f.publisher.begin({ frameId: "frame", guid: "guid_http", url: "http://example.test/file", suggestedFilename: "x" }), {
      accepted: false, reason: "unsafe_source",
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("count and byte ceilings cancel before publication", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < MAX_INTERACTIVE_BROWSER_DOWNLOADS; index += 1) {
      assert.equal(begin(f.publisher, `guid_${index}`).accepted, true);
    }
    assert.deepEqual(begin(f.publisher, "guid_over_count"), { accepted: false, reason: "count_quota" });
    const oversized = await f.publisher.progress({
      guid: "guid_0",
      state: "inProgress",
      totalBytes: MAX_INTERACTIVE_BROWSER_DOWNLOAD_BYTES + 1,
      receivedBytes: MAX_INTERACTIVE_BROWSER_DOWNLOAD_BYTES + 1,
    }, async () => undefined);
    assert.equal(oversized.cancel, true);
    assert.equal(oversized.state?.reason, "file_quota");
    assert.equal(fs.existsSync(path.join(f.project, ".wayang", "browser-downloads", "transcript.txt")), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("distinct valid-GUID unsafe-source events consume the monotonic observation bound", () => {
  const f = fixture();
  try {
    for (let index = 0; index < MAX_INTERACTIVE_BROWSER_DOWNLOADS - 1; index += 1) {
      assert.deepEqual(f.publisher.begin({
        frameId: "frame",
        guid: `unsafe_${index}`,
        url: "http://example.test/file",
        suggestedFilename: "unsafe.txt",
      }), { accepted: false, reason: "unsafe_source" });
    }
    assert.deepEqual(f.publisher.begin({
      frameId: "frame", guid: "unsafe_0", url: "http://example.test/repeated", suggestedFilename: "unsafe.txt",
    }), { accepted: false, reason: "unsafe_source" });
    assert.equal(begin(f.publisher, "valid_after_unsafe").accepted, true);
    assert.deepEqual(begin(f.publisher, "valid_over_quota"), { accepted: false, reason: "count_quota" });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("completed events with inconsistent byte totals are never published", async () => {
  const f = fixture();
  try {
    begin(f.publisher, "guid_partial", "partial.txt");
    fs.writeFileSync(path.join(f.staging, "guid_partial"), "part", { mode: 0o600 });
    const result = await f.publisher.progress({
      guid: "guid_partial", state: "completed", totalBytes: 8, receivedBytes: 4,
    }, async () => undefined);
    assert.equal(result.cancel, true);
    assert.equal(result.state?.reason, "publication_failed");
    assert.equal(fs.existsSync(path.join(f.project, ".wayang", "browser-downloads", "partial.txt")), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("sequential zero-byte downloads and restart state cannot reset the count bound", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < MAX_INTERACTIVE_BROWSER_DOWNLOADS; index += 1) {
      const guid = `zero_${index}`;
      assert.equal(begin(f.publisher, guid, `zero-${index}.txt`).accepted, true);
      fs.writeFileSync(path.join(f.staging, guid), Buffer.alloc(0), { mode: 0o600 });
      await f.publisher.progress({ guid, state: "completed", totalBytes: 0, receivedBytes: 0 }, async () => undefined);
    }
    assert.deepEqual(begin(f.publisher, "zero_over"), { accepted: false, reason: "count_quota" });
    const restarted = new InteractiveBrowserDownloadPublisher(path.join(f.root, "second-staging"), f.project);
    assert.deepEqual(begin(restarted, "restart_over"), { accepted: false, reason: "count_quota" });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("unsafe publication directory entries fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-interactive-downloads-unsafe-"));
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  fs.mkdirSync(path.join(project, ".wayang"), { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(project, ".wayang", "browser-downloads"));
  try {
    assert.throws(
      () => new InteractiveBrowserDownloadPublisher(path.join(root, "staging"), project),
      /unsafe|escaped/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("authority loss or lease revocation never publishes partial files", async () => {
  const f = fixture();
  try {
    begin(f.publisher, "guid_denied");
    fs.writeFileSync(path.join(f.staging, "guid_denied"), "secret", { mode: 0o600 });
    await assert.rejects(
      () => f.publisher.progress({ guid: "guid_denied", state: "completed", totalBytes: 6, receivedBytes: 6 }, async () => { throw new Error("revoked"); }),
      /revoked/,
    );
    assert.equal(fs.existsSync(path.join(f.project, ".wayang", "browser-downloads", "transcript.txt")), false);
    begin(f.publisher, "guid_pending");
    fs.writeFileSync(path.join(f.staging, "guid_pending"), "partial", { mode: 0o600 });
    f.publisher.revoke();
    assert.equal(fs.existsSync(path.join(f.staging, "guid_pending")), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

browserIntegrationTest("real managed Chromium publishes a bounded blob download from an HTTPS document", { timeout: 60_000 }, async (t) => {
  const f = fixture();
  const publisher = f.publisher;
  let runtime!: ManagedChromiumRuntime;
  runtime = new ManagedChromiumRuntime({
    profileDir: path.join(f.root, "profile"),
    downloadsDir: f.staging,
    downloadBehavior: "allowAndName",
    workingDirectory: f.project,
    onDownloadWillBegin(event) {
      const decision = publisher.begin(event);
      if (!decision.accepted) void runtime.cancelDownload(event.guid).catch(() => undefined);
    },
    onDownloadProgress(event) {
      void publisher.progress(event, async () => undefined).then((result) => {
        if (result.cancel) return runtime.cancelDownload(event.guid);
      }).catch(() => runtime.cancelDownload(event.guid).catch(() => undefined));
    },
  });
  t.after(async () => {
    await runtime.stop().catch(() => undefined);
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  await runtime.start();
  const attachment = await runtime.attachPageCdpViewer();
  try {
    await attachment.cdp.send("Page.navigate", { url: "https://example.com/" });
    const readyDeadline = Date.now() + 20_000;
    while (Date.now() < readyDeadline) {
      const document = await attachment.cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (document?.result?.value === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const location = await attachment.cdp.send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
    if (typeof location?.result?.value !== "string" || !location.result.value.startsWith("https://")) {
      t.skip("HTTPS fixture was unreachable from managed Chromium");
      return;
    }
    await attachment.cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const url = URL.createObjectURL(new Blob(['synthetic managed browser download\\n'], { type: 'text/plain' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'managed-transcript.txt';
        document.body.appendChild(anchor);
        anchor.click();
      })()`,
      awaitPromise: true,
    });
  } finally {
    attachment.close();
  }
  const destination = path.join(f.project, ".wayang", "browser-downloads", "managed-transcript.txt");
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(destination) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    fs.existsSync(destination),
    true,
    `download was not published: ${JSON.stringify(publisher.latest)} staging=${JSON.stringify(fs.existsSync(f.staging) ? fs.readdirSync(f.staging) : [])}`,
  );
  assert.equal(fs.readFileSync(destination, "utf8"), "synthetic managed browser download\n");
});
