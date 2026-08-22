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

test("tracked supervised deployment template standardizes named profiles on auto transport", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const template = fs.readFileSync(path.join(repoRoot, "deploy", "60-browser-transport.auto.conf"), "utf8");
  const deprecatedBundledTemplate = fs.readFileSync(path.join(repoRoot, "deploy", "60-browser-profiles.auto.conf"), "utf8");
  assert.doesNotMatch(template, /^Environment=WAYANG_STANDARD_BROWSER_PROFILE_HOSTS=/m);
  assert.match(template, /^Environment=WAYANG_BROWSER_TRANSPORT=auto$/m);
  assert.doesNotMatch(template, /^Environment=WAYANG_BROWSER_TRANSPORT=cdp$/m);
  assert.doesNotMatch(deprecatedBundledTemplate, /^Environment=/m);
});

test("production gate-on startup accepts gate-off schema 7 only after complete browser composition", { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-browser-production-activation-"));
  const dataDir = path.join(root, "data");
  const home = path.join(root, "home");
  const piDir = path.join(root, "pi");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(piDir, { recursive: true, mode: 0o700 });
  const syntheticBin = path.join(root, "bin");
  fs.mkdirSync(syntheticBin, { mode: 0o700 });
  for (const command of ["Xvfb", "x11vnc"]) {
    fs.writeFileSync(path.join(syntheticBin, command), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  }
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
  const gateOffStore = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(gateOffStore.schema_version, 7);
  assert.deepEqual(gateOffStore.browserProfiles, []);
  assert.deepEqual(gateOffStore.projectBrowserDefaults, []);
  assert.deepEqual(gateOffStore.sessionBrowserStates, []);
  assert.deepEqual(gateOffStore.browserCleanups, []);
  assert.deepEqual(gateOffStore.transcriptRecoveryJournal, []);

  const port = await freePort();
  const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: backendDir,
    env: {
      PATH: `${syntheticBin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
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
    assert.match(
      stdout,
      process.platform === "linux"
        ? /\[browser\] transport requested=auto selected=vnc full_browser_available=yes chromium=/
        : /\[browser\] transport requested=auto selected=cdp-screencast full_browser_available=no chromium=/,
    );
  } finally {
    await stopChild(child);
  }

  const migrated = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(migrated.schema_version, 7);
  assert.ok(Array.isArray(migrated.browserProfiles));
  assert.deepEqual(migrated.transcriptRecoveryJournal, []);
  const backups = fs.readdirSync(dataDir).filter((name) => name.startsWith("store.json.backup-v"));
  assert.equal(backups.length, 0, "current schema 7 requires no migration rewrite");
  fs.rmSync(root, { recursive: true, force: true });
});

test("production startup fails clearly when explicit VNC dependencies are unavailable", { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-browser-vnc-required-"));
  const emptyBin = path.join(root, "bin");
  const home = path.join(root, "home");
  const piDir = path.join(root, "pi");
  fs.mkdirSync(emptyBin, { mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(piDir, { mode: 0o700 });
  const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: backendDir,
    env: {
      PATH: emptyBin,
      HOME: home,
      USER: "synthetic-wayang",
      LOGNAME: "synthetic-wayang",
      TMPDIR: os.tmpdir(),
      NODE_ENV: "test",
      PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: piDir,
      WAYANG_HOST: "127.0.0.1",
      WAYANG_PORT: String(await freePort()),
      WAYANG_DATA_DIR: path.join(root, "data"),
      WAYANG_AUTH_ENABLED: "0",
      WAYANG_MESSAGING_ENABLED: "0",
      WAYANG_AUTO_SESSION_TITLE: "off",
      WAYANG_AUTO_SESSION_TITLE_PROTECTED: "off",
      WAYANG_BROWSER_TRANSPORT: "vnc",
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-65_536); });
  child.stderr!.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-65_536); });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("explicit VNC startup did not terminate")), 20_000);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.notEqual(result.code, 0);
    assert.match(stderr, /WAYANG_BROWSER_TRANSPORT=vnc requires Linux with executable Xvfb and x11vnc dependencies/);
    assert.doesNotMatch(stdout, /\[wayang\] listening on/);
  } finally {
    await stopChild(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
