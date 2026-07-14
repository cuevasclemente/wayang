#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "./lib/config.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const env = { ...process.env };
const envPath = resolve(root, ".env");
if (existsSync(envPath)) {
  for (const [key, value] of parseEnv(readFileSync(envPath, "utf8"), envPath).values) {
    if (env[key] === undefined) env[key] = value;
  }
}

const backendEnv = {
  ...env,
  // The Vite frontend is the browser-facing origin in development. Override
  // any production public origin loaded from .env for this local process.
  WAYANG_PUBLIC_ORIGIN: "http://127.0.0.1:5173",
};

const children = [
  spawn("npm", ["--prefix", "backend", "run", "dev"], { cwd: root, env: backendEnv, stdio: "inherit" }),
  spawn("npm", ["--prefix", "frontend", "run", "dev"], { cwd: root, env, stdio: "inherit" }),
];
let stopping = false;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill(signal);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stop(signal));

for (const child of children) {
  child.on("error", (error) => {
    console.error(`Development process failed to start: ${error.message}`);
    process.exitCode = 1;
    stop();
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      process.exitCode = signal ? 1 : (code ?? 1);
      stop();
    }
  });
}

Promise.all(children.map((child) => new Promise((done) => child.once("close", done)))).then(() => {
  if (process.exitCode === undefined) process.exitCode = 0;
});
