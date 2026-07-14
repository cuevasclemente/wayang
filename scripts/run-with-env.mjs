#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "./lib/config.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const separator = process.argv.indexOf("--");
if (separator < 0 || separator === process.argv.length - 1) {
  console.error("Usage: node scripts/run-with-env.mjs -- command [args...]");
  process.exit(2);
}

const env = { ...process.env };
const envPath = resolve(root, ".env");
if (existsSync(envPath)) {
  const parsed = parseEnv(readFileSync(envPath, "utf8"), envPath);
  for (const [key, value] of parsed.values) {
    if (env[key] === undefined) env[key] = value;
  }
}

const [command, ...args] = process.argv.slice(separator + 1);
const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.on("error", (error) => {
  console.error(`Unable to start ${command}: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.exitCode = 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal] || 0);
  else process.exitCode = code ?? 1;
});
