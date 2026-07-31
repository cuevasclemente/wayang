import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getRegisteredAttachment, prepareAttachments, readRegisteredAttachment } from "./attachments.js";
import { getSessionAttachmentRoot, LEGACY_ATTACHMENT_ROOT } from "./protected-artifacts.js";

test("uploads use a private full-session subtree and never the legacy shared root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-attachments-"));
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  try {
    const result = prepareAttachments(sessionId, [
      {
        name: "synthetic note",
        mimeType: "text/plain",
        data: Buffer.from("SYNTHETIC_ATTACHMENT_CANARY\n").toString("base64"),
      },
    ]);
    assert.equal(result.count, 1);
    assert.equal(result.images.length, 0);
    assert.equal(result.attachmentIds.length, 1);
    assert.match(result.notes[0]!, new RegExp(`attachment_id="${result.attachmentIds[0]}"`));
    const registered = getRegisteredAttachment(sessionId, result.attachmentIds[0]!);
    assert.equal(registered?.displayName, "synthetic_note.txt");
    assert.equal(registered?.sourceBytes, Buffer.byteLength("SYNTHETIC_ATTACHMENT_CANARY\n"));
    assert.match(registered?.sourceSha256 ?? "", /^[a-f0-9]{64}$/);

    const sessionRoot = getSessionAttachmentRoot(sessionId);
    const entries = fs.readdirSync(sessionRoot);
    assert.equal(entries.length, 1);
    const file = path.join(sessionRoot, entries[0]!);
    assert.match(result.notes[0]!, new RegExp(sessionId));
    assert.equal(fs.readFileSync(file, "utf8"), "SYNTHETIC_ATTACHMENT_CANARY\n");
    assert.equal(readRegisteredAttachment(sessionId, result.attachmentIds[0]!, 1024).bytes.toString("utf8"), "SYNTHETIC_ATTACHMENT_CANARY\n");
    assert.equal(getRegisteredAttachment("another-session", result.attachmentIds[0]!), undefined);
    assert.throws(() => readRegisteredAttachment("another-session", result.attachmentIds[0]!, 1024), /not registered/);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.dirname(sessionRoot)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(sessionRoot).mode & 0o777, 0o700);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    assert.equal(file.startsWith(`${LEGACY_ATTACHMENT_ROOT}${path.sep}`), false);
  } finally {
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registered attachment IDs fail closed if the upload is replaced", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-attachments-replaced-"));
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  const sessionId = "12345678-1234-4234-8234-123456789abd";
  try {
    const result = prepareAttachments(sessionId, [{
      name: "audio.mp3",
      mimeType: "audio/mpeg",
      data: Buffer.from("ID3SYNTHETIC").toString("base64"),
    }]);
    const sessionRoot = getSessionAttachmentRoot(sessionId);
    const file = path.join(sessionRoot, fs.readdirSync(sessionRoot)[0]!);
    fs.renameSync(file, `${file}.original`);
    fs.writeFileSync(file, "ID3REPLACED", { mode: 0o600 });
    assert.throws(() => readRegisteredAttachment(sessionId, result.attachmentIds[0]!, 1024), /changed after upload/);
  } finally {
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid attachment session ids fail before storage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-attachments-invalid-"));
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  try {
    assert.throws(() => prepareAttachments("../cross-session", [{
      name: "note.txt",
      mimeType: "text/plain",
      data: Buffer.from("synthetic").toString("base64"),
    }]), /Invalid attachment session id/);
  } finally {
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
