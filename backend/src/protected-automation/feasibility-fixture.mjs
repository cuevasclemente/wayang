import * as fs from "node:fs";
import * as http from "node:http";
import { spawn, spawnSync } from "node:child_process";

const MAX_FRAME_BYTES = 64 * 1024;

function writeFrame(fd, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > MAX_FRAME_BYTES) throw new Error("frame too large");
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  fs.writeSync(fd, frame);
}

async function readFrame(fd) {
  const stream = fs.createReadStream("/dev/null", { fd, autoClose: false });
  let pending = Buffer.alloc(0);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RPC frame timeout")), 2_000);
    const finish = (operation) => {
      clearTimeout(timer);
      stream.destroy();
      operation();
    };
    stream.on("error", (error) => finish(() => reject(error)));
    stream.on("end", () => finish(() => reject(new Error("RPC fd closed"))));
    stream.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.byteLength < 4) return;
      const length = pending.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) return finish(() => reject(new Error("RPC frame too large")));
      if (pending.byteLength < 4 + length) return;
      const trailing = pending.byteLength - 4 - length;
      if (trailing !== 0) return finish(() => reject(new Error("RPC trailing bytes")));
      try {
        const value = JSON.parse(pending.subarray(4).toString("utf8"));
        finish(() => resolve(value));
      } catch {
        finish(() => reject(new Error("RPC invalid JSON")));
      }
    });
  });
}

function tryRead(file) {
  try {
    fs.readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

function tryWrite(file, value) {
  try {
    fs.writeFileSync(file, value, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function tryExec(command, args = []) {
  const result = spawnSync(command, args, { stdio: "ignore", timeout: 1_000 });
  return {
    succeeded: result.status === 0,
    errorCode: result.error && typeof result.error === "object" ? result.error.code ?? "error" : null,
  };
}

async function proxyProbe(target) {
  const rawProxy = process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!rawProxy) return { configured: false, reached: false };
  const proxy = new URL(rawProxy);
  const headers = {};
  if (proxy.username) {
    const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    headers["proxy-authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
  }
  const body = await new Promise((resolve, reject) => {
    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: "GET",
      path: target,
      headers,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > 1_024) request.destroy(new Error("proxy response too large"));
        else chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.setTimeout(2_000, () => request.destroy(new Error("proxy request timeout")));
    request.once("error", reject);
    request.end();
  });
  return { configured: true, reached: body === "synthetic-ok" };
}

async function runProbe() {
  const project = process.env.WAYANG_AUTOMATION_PROJECT_DIR;
  const run = process.env.WAYANG_AUTOMATION_RUN_DIR;
  const state = process.env.WAYANG_AUTOMATION_STATE_DIR;
  const snapshot = process.env.WAYANG_AUTOMATION_SNAPSHOT_DIR;
  const canary = process.env.WAYANG_AUTOMATION_CANARY;
  const outside = process.env.WAYANG_AUTOMATION_OUTSIDE_WRITE;
  const target = process.env.WAYANG_AUTOMATION_PROXY_TARGET;
  if (![project, run, state, snapshot, canary, outside, target].every(Boolean)) {
    throw new Error("synthetic fixture environment is incomplete");
  }

  let rpc = { ok: false, error: "RPC unavailable" };
  try {
    const request = await readFrame(3);
    writeFrame(3, { id: request.id, ok: true, result: { echoed: request.params?.value } });
    rpc = { ok: request.method === "synthetic.echo" && request.params?.value === "bounded" };
  } catch (error) {
    rpc = { ok: false, error: error instanceof Error ? error.message : "RPC failed" };
  }

  const result = {
    canaryHidden: !tryRead(canary),
    snapshotReadable: tryRead(`${snapshot}/feasibility-fixture.mjs`),
    projectWrite: tryWrite(`${project}/project-output.txt`, "project"),
    runWrite: tryWrite(`${run}/run-output.txt`, "run"),
    stateWrite: tryWrite(`${state}/state-output.txt`, "state"),
    snapshotWriteDenied: !tryWrite(`${snapshot}/snapshot-write.txt`, "blocked"),
    outsideWriteDenied: !tryWrite(outside, "blocked"),
    proxy: await proxyProbe(target),
    rpc,
    exec: {
      binSh: tryExec("/bin/sh", ["-c", "exit 0"]),
      usrBinEnv: tryExec("/usr/bin/env"),
      unrelated: tryExec("/usr/bin/true"),
      wrapperShell: tryExec(process.env.WAYANG_AUTOMATION_WRAPPER_SHELL),
    },
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function runHeartbeat() {
  const heartbeat = process.env.WAYANG_AUTOMATION_HEARTBEAT;
  if (!heartbeat) throw new Error("heartbeat path is missing");
  setInterval(() => fs.appendFileSync(heartbeat, "."), 25);
}

function runDescendantParent() {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "heartbeat"], {
    env: { PATH: process.env.PATH ?? "", WAYANG_AUTOMATION_HEARTBEAT: process.env.WAYANG_AUTOMATION_HEARTBEAT },
    shell: false,
    stdio: "ignore",
  });
  child.unref();
  process.stdout.write("ready\n");
  setInterval(() => {}, 1_000);
}

const mode = process.argv[2];
if (mode === "probe") await runProbe();
else if (mode === "heartbeat") runHeartbeat();
else if (mode === "descendant-parent") runDescendantParent();
else throw new Error("unknown synthetic fixture mode");
