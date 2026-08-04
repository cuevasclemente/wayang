import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { close, init } from "./db.js";

const LOCK_NAME = "store.json.lock";

function syntheticRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wayang-single-writer-"));
}

function exitedChildPid(): number {
  const result = spawnSync(process.execPath, ["--eval", "process.stdout.write(String(process.pid))"], {
    encoding: "utf-8",
    env: {},
  });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout);
}

function runChildInit(dataDir: string, closeExplicitly = true): { status: number | null; stderr: string } {
  const dbUrl = new URL("./db.ts", import.meta.url).href;
  const source = `
    import { init, close } from ${JSON.stringify(dbUrl)};
    try {
      init();
      ${closeExplicitly ? "close();" : ""}
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 23;
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: path.dirname(new URL("../package.json", import.meta.url).pathname),
    encoding: "utf-8",
    env: {
      HOME: path.join(path.dirname(dataDir), "synthetic-home"),
      WAYANG_DATA_DIR: dataDir,
      PI_OFFLINE: "1",
    },
    timeout: 10_000,
  });
  return { status: result.status, stderr: result.stderr };
}

function withDataDir(fn: (root: string, dataDir: string) => void): void {
  const root = syntheticRoot();
  const dataDir = path.join(root, "data");
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dataDir;
  close();
  try {
    fn(root, dataDir);
  } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a canonical store rejects a second live process while repeated local init remains safe", () => withDataDir((root, dataDir) => {
  init();
  init();

  const lockPath = path.join(dataDir, LOCK_NAME);
  assert.equal(fs.existsSync(lockPath), true);
  if (process.platform !== "win32") assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);

  const alias = path.join(root, "data-alias");
  fs.symlinkSync(dataDir, alias, "dir");
  const contender = runChildInit(alias);
  assert.equal(contender.status, 23);
  assert.match(contender.stderr, /already owned by live backend PID/);
  assert.equal(fs.existsSync(lockPath), true);
}));

test("a well-formed lock whose PID is no longer live is recovered exclusively", () => withDataDir((_root, dataDir) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, LOCK_NAME);
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: exitedChildPid(),
    nonce: "11111111-1111-4111-8111-111111111111",
    started_at: 1,
  })}\n`, { mode: 0o600 });

  init();
  const current = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid: number; nonce: string };
  assert.equal(current.pid, process.pid);
  assert.notEqual(current.nonce, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(fs.readdirSync(dataDir).filter((name) => name.includes(".stale.")), []);

  close();
  assert.equal(fs.existsSync(lockPath), false);
}));

test("close never removes a lock that no longer belongs to this process instance", () => withDataDir((_root, dataDir) => {
  init();
  const lockPath = path.join(dataDir, LOCK_NAME);
  const displacedPath = path.join(dataDir, "displaced-owned-lock");
  fs.renameSync(lockPath, displacedPath);
  const replacement = `${JSON.stringify({
    pid: process.pid,
    nonce: "22222222-2222-4222-8222-222222222222",
    started_at: Date.now(),
  })}\n`;
  fs.writeFileSync(lockPath, replacement, { mode: 0o600 });

  assert.throws(() => close(), /ownership lock was lost/);
  assert.equal(fs.readFileSync(lockPath, "utf-8"), replacement);
}));

test("normal process exit releases an owned lock", () => withDataDir((root) => {
  const childData = path.join(root, "exit-release-data");
  const child = runChildInit(childData, false);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.existsSync(path.join(childData, LOCK_NAME)), false);
}));

test("independent synthetic data directories can be initialized concurrently", () => withDataDir((root) => {
  init();
  const independent = runChildInit(path.join(root, "independent-data"));
  assert.equal(independent.status, 0, independent.stderr);
}));
