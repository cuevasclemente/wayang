import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { close, init } from "../db.js";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("synthetic server did not allocate a port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000)),
  ]);
  if (!stopped) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

test("production gate-on startup composes before backup-first schema-6 migration", { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-browser-production-activation-"));
  const dataDir = path.join(root, "data");
  const home = path.join(root, "home");
  const piDir = path.join(root, "pi");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(piDir, { recursive: true, mode: 0o700 });
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dataDir;
  try {
    init();
    close();
  } finally {
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
  }
  const storePath = path.join(dataDir, "store.json");
  assert.equal(JSON.parse(fs.readFileSync(storePath, "utf8")).schema_version, 5);

  const port = await freePort();
  const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: backendDir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      USER: "synthetic-wayang",
      LOGNAME: "synthetic-wayang",
      TMPDIR: os.tmpdir(),
      NODE_ENV: "test",
      PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: piDir,
      WAYANG_HOST: "127.0.0.1",
      WAYANG_PORT: String(port),
      WAYANG_DATA_DIR: dataDir,
      WAYANG_AUTH_ENABLED: "0",
      WAYANG_MESSAGING_ENABLED: "0",
      WAYANG_AUTO_SESSION_TITLE: "off",
      WAYANG_AUTO_SESSION_TITLE_PROTECTED: "off",
      WAYANG_STANDARD_BROWSER_PROFILE_HOSTS: "1",
      WAYANG_BROWSER_TRANSPORT: "cdp",
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-65_536); });
  child.stderr!.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-65_536); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("synthetic production startup timed out")), 30_000);
      const inspect = () => {
        if (!stdout.includes(`[wayang] listening on http://127.0.0.1:${port}`)) return;
        clearTimeout(timer);
        resolve();
      };
      child.stdout!.on("data", inspect);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`synthetic production startup exited early (${code ?? signal}); ${stderr.slice(-2_000)}`));
      });
      inspect();
    });
  } finally {
    await stopChild(child);
  }

  const migrated = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(migrated.schema_version, 6);
  assert.ok(Array.isArray(migrated.browserProfiles));
  const backups = fs.readdirSync(dataDir).filter((name) => name.startsWith("store.json.backup-v5-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.statSync(path.join(dataDir, backups[0]!)).mode & 0o777, 0o600);
  fs.rmSync(root, { recursive: true, force: true });
});
