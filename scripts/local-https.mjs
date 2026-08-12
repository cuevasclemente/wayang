#!/usr/bin/env node
import { constants, accessSync, existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "./lib/config.mjs";
import {
  buildLocalHttpsCaddyfile,
  localHttpsCaddyEnvironment,
  localHttpsEffectiveValues,
  localHttpsSettings,
} from "./lib/local-https.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const envPath = resolve(root, ".env");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const checkOnly = args.has("--check");

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/local-https.mjs [--check | --dry-run]

Validate or run the foreground Caddy local-HTTPS proxy described by Wayang's
non-secret .env networking/auth settings. Caddy is never installed or daemonized.`);
  process.exit(0);
}
if ([...args].some((arg) => !["--check", "--dry-run"].includes(arg)) || (dryRun && checkOnly)) {
  console.error("Unknown or incompatible option. Use --help for usage.");
  process.exit(2);
}

function executable(candidate) {
  if (!candidate || !isAbsolute(candidate)) return false;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findCaddy(environment) {
  const candidates = (environment.PATH || "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, "caddy"));
  for (const candidate of [...candidates, "/opt/homebrew/bin/caddy", "/usr/local/bin/caddy", "/usr/bin/caddy"]) {
    if (executable(candidate)) return candidate;
  }
  throw new Error("Caddy executable not found. Install Caddy using your platform's normal package manager, then rerun this command");
}

function deployment() {
  if (!existsSync(envPath)) throw new Error("Wayang .env is not configured; run make configure in a local terminal");
  const text = readFileSync(envPath, "utf8");
  const values = parseEnv(text, envPath).values;
  return localHttpsSettings(localHttpsEffectiveValues(values));
}

function validateCaddy(caddy, config, environment) {
  const result = spawnSync(caddy, ["validate", "--config", "-", "--adapter", "caddyfile"], {
    cwd: root,
    env: environment,
    input: config,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Caddy rejected the generated configuration (status ${result.status ?? "unknown"})`);
}

async function runCaddy(caddy, config, environment) {
  const child = spawn(caddy, ["run", "--config", "-", "--adapter", "caddyfile"], {
    cwd: root,
    env: environment,
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin.end(config);
  const forward = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const outcome = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  if (outcome.code !== 0) {
    throw new Error(`Caddy exited ${outcome.signal ? `with signal ${outcome.signal}` : `with status ${outcome.code}`}`);
  }
}

async function main() {
  if (dryRun) {
    console.log("Local HTTPS proxy dry-run: writes nothing, starts nothing, and does not read .env.");
    console.log("After make configure enables built-in auth, loopback bind, and an exact HTTPS public origin on an unprivileged port, this command validates and runs Caddy in the foreground.");
    console.log("Caddy installation, password entry, local-CA trust, DNS, and process supervision remain human-managed.");
    return;
  }

  const settings = deployment();
  const environment = localHttpsCaddyEnvironment();
  const caddy = findCaddy(environment);
  const config = buildLocalHttpsCaddyfile(settings);
  validateCaddy(caddy, config, environment);
  console.log(`Local HTTPS proxy configuration is valid for ${settings.publicOrigin}.`);
  if (checkOnly) return;
  console.log("Starting Caddy in the foreground. Press Ctrl-C to stop it.");
  await runCaddy(caddy, config, environment);
}

main().catch((error) => {
  console.error(`Local HTTPS proxy failed: ${error.message}`);
  process.exitCode = 1;
});
