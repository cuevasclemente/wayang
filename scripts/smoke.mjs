#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
if (process.argv.includes("--dry-run")) {
  console.log("[dry-run] Would start the production backend on an isolated loopback port and request /healthz.");
  process.exit(0);
}
const entry = join(root, "backend", "dist", "index.js");
if (!existsSync(entry)) {
  console.error("Production backend is not built. Run make build first.");
  process.exit(1);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Unable to allocate smoke-test port"));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

const tempRoot = mkdtempSync(join(tmpdir(), "wayang-smoke-"));
mkdirSync(join(tempRoot, "home"), { mode: 0o700 });
const port = await freePort();
const env = {
  PATH: process.env.PATH || "",
  HOME: join(tempRoot, "home"),
  USER: "wayang-smoke",
  LOGNAME: "wayang-smoke",
  LANG: process.env.LANG || "C",
  NODE_ENV: "production",
  WAYANG_HOST: "127.0.0.1",
  WAYANG_PORT: String(port),
  WAYANG_DATA_DIR: join(tempRoot, "data"),
  WAYANG_AUTH_ENABLED: "0",
  PI_CODING_AGENT_DIR: join(tempRoot, "pi-agent"),
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
};
const child = spawn(process.execPath, [entry], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk) => { if (stderr.length < 4000) stderr += chunk.toString("utf8"); });

try {
  const deadline = Date.now() + 20_000;
  let response;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`backend exited with status ${child.exitCode}`);
    try {
      response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) break;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  if (!response?.ok) throw new Error("health check timed out");
  const body = await response.json();
  if (body.status !== "ok") throw new Error("health check returned an unexpected response");
  console.log("ok    isolated production /healthz smoke test");
} catch (error) {
  console.error(`Smoke test failed: ${error.message}`);
  if (stderr) console.error(stderr.trim());
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await new Promise((resolveClose) => {
    if (child.exitCode !== null) resolveClose();
    else child.once("close", resolveClose);
  });
}
