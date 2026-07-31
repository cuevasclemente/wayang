#!/usr/bin/env node
import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { createConnection } from "node:net";

function executableOnPath(name) {
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {}
  }
  return null;
}

function resolveBw() {
  const configured = (process.env.WAYANG_BITWARDEN_CLI_PATH || "").trim();
  if (configured && !isAbsolute(configured)) throw new Error("Configured Bitwarden CLI path is not absolute");
  const executable = configured || executableOnPath("bw");
  if (!executable) throw new Error("Bitwarden CLI is unavailable");
  accessSync(executable, constants.X_OK);
  return realpathSync(executable);
}

const BW_ENV_ALLOWLIST = [
  "HOME", "PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "BITWARDENCLI_APPDATA_DIR",
  "LANG", "LC_ALL", "TZ", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
];

function unlock(executable) {
  return new Promise((resolve, reject) => {
    const env = {};
    for (const name of BW_ENV_ALLOWLIST) if (process.env[name] !== undefined) env[name] = process.env[name];
    const child = spawn(executable, ["unlock", "--raw"], {
      shell: false,
      stdio: ["inherit", "pipe", "inherit"],
      env,
      cwd: tmpdir(),
    });
    const chunks = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 4096) {
        child.kill("SIGKILL");
        reject(new Error("Bitwarden unlock output exceeded the safety limit"));
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => reject(new Error("Bitwarden CLI could not be started")));
    child.once("close", (code) => {
      if (code !== 0) reject(new Error("Bitwarden unlock failed"));
      else {
        const key = Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/g, "");
        if (Buffer.byteLength(key) < 8 || key.includes("\0")) reject(new Error("Bitwarden returned an invalid session key"));
        else resolve(key);
      }
    });
  });
}

function sendToBroker(socketPath, key) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const replies = [];
    let bytes = 0;
    socket.setTimeout(10_000, () => socket.destroy(new Error("Credential broker timed out")));
    socket.once("connect", () => socket.end(key));
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 64) socket.destroy(new Error("Unexpected credential broker response"));
      else replies.push(chunk);
    });
    socket.once("error", () => reject(new Error("Could not connect to the running Wayang credential broker")));
    socket.once("close", () => {
      if (Buffer.concat(replies).toString("utf8") === "ok\n") resolve();
      else reject(new Error("Wayang rejected the unlock session"));
    });
  });
}

try {
  const executable = resolveBw();
  const key = await unlock(executable);
  const dataDir = process.env.WAYANG_DATA_DIR || process.env.PI_WEB_UI_DATA_DIR || join(homedir(), ".wayang");
  await sendToBroker(join(dataDir, "browser-credentials", "unlock.sock"), key);
  console.log("Wayang browser credentials are unlocked in memory. Return to the Browser panel.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Credential unlock failed");
  process.exitCode = 1;
}
