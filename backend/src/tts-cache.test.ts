import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { cleanupCache, getTtsCacheDir, readAudio, writeAudio } from "./tts-cache.js";

test("TTS cache stays inside private WAYANG_DATA_DIR and leaves HOME untouched", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-tts-cache-test-"));
  const syntheticHome = path.join(root, "home");
  const dataDir = path.join(root, "data");
  const realHomeCache = path.join(syntheticHome, ".wayang", "tts");
  const sentinel = path.join(realHomeCache, "must-remain.mp3");
  fs.mkdirSync(realHomeCache, { recursive: true });
  fs.writeFileSync(sentinel, "sentinel");

  const previousHome = process.env.HOME;
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.HOME = syntheticHome;
  process.env.WAYANG_DATA_DIR = dataDir;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(getTtsCacheDir(), path.join(dataDir, "tts"));
  const filename = await writeAudio(Buffer.from("audio"), "mp3");
  assert.deepEqual((await readAudio(filename))?.data, Buffer.from("audio"));
  assert.equal(await readAudio("../must-remain.mp3"), undefined);
  assert.equal(fs.existsSync(sentinel), true);

  if (process.platform !== "win32") {
    assert.equal(fs.statSync(getTtsCacheDir()).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(getTtsCacheDir(), filename)).mode & 0o777, 0o600);
  }

  const result = await cleanupCache({ maxAgeMs: -1, maxTotalBytes: 0 });
  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(sentinel), true);
});
