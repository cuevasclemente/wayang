import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("credential unlock helper uses fake bw and a synthetic private socket without printing the session canary", { skip: process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "wayang-unlock-helper-"));
  const dataDir = join(home, "data");
  const socketDir = join(dataDir, "browser-credentials");
  const socketPath = join(socketDir, "unlock.sock");
  const fakeBw = join(home, "fake-bw");
  const sessionCanary = "SYNTHETIC_HELPER_SESSION_CANARY";
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  writeFileSync(fakeBw, `#!/usr/bin/env node\nif (process.argv.slice(2).join(" ") !== "unlock --raw" || process.cwd() !== ${JSON.stringify(tmpdir())} || process.env.FORBIDDEN_ENV_CANARY) process.exit(42);\nprocess.stdout.write(${JSON.stringify(sessionCanary + "\n")});\n`, { mode: 0o700 });

  let received = "";
  const server = createServer((socket) => {
    socket.on("data", (chunk) => { received += chunk.toString("utf8"); });
    socket.on("end", () => socket.end("ok\n"));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, "scripts", "browser-credentials-unlock.mjs")], {
        cwd: root,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH || "",
          HOME: home,
          WAYANG_DATA_DIR: dataDir,
          WAYANG_BITWARDEN_CLI_PATH: fakeBw,
          FORBIDDEN_ENV_CANARY: "must-not-reach-bw",
        },
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(received, sessionCanary);
    assert.equal(result.stdout.includes(sessionCanary), false);
    assert.equal(result.stderr.includes(sessionCanary), false);
    assert.match(result.stdout, /unlocked in memory/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
