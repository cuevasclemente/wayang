#!/usr/bin/env node
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { diagnoseCapabilityApprovalMetadata } from "./lib/capability-approval.mjs";
import { diagnoseLinuxUserBus } from "./lib/doctor.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
let failures = 0;
let warnings = 0;

function ok(message) { console.log(`ok    ${message}`); }
function warn(message) { warnings += 1; console.log(`warn  ${message}`); }
function fail(message) { failures += 1; console.log(`FAIL  ${message}`); }

function executable(name) {
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  return null;
}

function version(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8", env: process.env });
  return result.status === 0 ? `${result.stdout || result.stderr}`.trim().split(/\r?\n/)[0] : null;
}

const CI_TESTED_NODE_MAJORS = new Set([22, 26]);

function parseNodeVersion(versionString) {
  const [major, minor, patch] = versionString.replace(/^v/, "").split(".").map(Number);
  return { major, minor, patch };
}

function atLeastNode(versionString) {
  const { major, minor } = parseNodeVersion(versionString);
  return major > 22 || (major === 22 && minor >= 19);
}

console.log(`Wayang doctor (${process.platform}/${process.arch})`);
if (process.platform === "linux" || process.platform === "darwin") ok("supported operating system");
else fail("v0.1 supports Linux and macOS only");

if (atLeastNode(process.version)) {
  const { major } = parseNodeVersion(process.version);
  ok(`Node ${process.version} (module ABI ${process.versions.modules}; minimum 22.19.0)`);
  if (!CI_TESTED_NODE_MAJORS.has(major)) {
    warn(`Node ${major} satisfies the engine range but CI currently covers majors 22 and 26`);
  }
} else fail(`Node ${process.version} is too old; install Node >=22.19.0`);

for (const command of ["npm", "git", "make"]) {
  const path = executable(command);
  if (!path) fail(`${command} is not available on PATH`);
  else ok(`${command}: ${version(path) || path}`);
}

const compiler = executable("cc") || executable("clang") || executable("gcc");
const python = executable("python3") || executable("python");
if (compiler && python) ok("native addon build tools are available");
else warn("native addon fallback builds may need a C/C++ toolchain and Python 3");

if (process.platform === "linux") {
  const sandboxCommands = ["bwrap", "socat", "rg"];
  const missing = sandboxCommands.filter((command) => !executable(command));
  const supportedArch = process.arch === "x64" || process.arch === "arm64";
  if (missing.length === 0 && supportedArch) ok("per-exec bash sandbox prerequisites are available");
  else warn(`bash will be removed from Wayang sessions because sandbox prerequisites are unavailable${missing.length ? ` (missing: ${missing.join(", ")})` : " (requires x64 or arm64)"}`);
} else if (process.platform === "darwin") {
  if (existsSync("/usr/bin/sandbox-exec")) ok("per-exec bash sandbox prerequisite is available");
  else warn("bash will be removed from Wayang sessions because sandbox-exec is unavailable");
}

const userBusDiagnostic = diagnoseLinuxUserBus();
if (userBusDiagnostic?.level === "ok") ok(userBusDiagnostic.message);
else if (userBusDiagnostic?.level === "warn") warn(userBusDiagnostic.message);

for (const [directory, requiredBinary] of [["backend", "tsx"], ["frontend", "vite"], ["e2e", "playwright"]]) {
  if (existsSync(join(root, directory, "node_modules", ".bin", requiredBinary))) ok(`${directory} dependencies installed`);
  else warn(`${directory} development dependencies absent (run make install)`);
}

if (existsSync(join(root, "backend", "node_modules", "better-sqlite3"))) {
  const nativeCheck = spawnSync(process.execPath, ["--input-type=module", "-e", "import Database from 'better-sqlite3'; const db=new Database(':memory:'); db.close();"], {
    cwd: join(root, "backend"), encoding: "utf8", env: process.env,
  });
  if (nativeCheck.status === 0) ok("better-sqlite3 native binding loads for this Node runtime");
  else fail("better-sqlite3 native binding is unavailable; use Node 22 LTS or install native build prerequisites and reinstall");
}

const envFile = join(root, ".env");
if (existsSync(envFile)) {
  const mode = statSync(envFile).mode & 0o777;
  if (process.platform !== "win32" && mode !== 0o600) warn(`.env exists but mode is ${mode.toString(8)}; run chmod 600 .env`);
  else ok("private .env exists with mode 0600 (contents not inspected)");
} else warn(".env is not configured (run make configure)");

const piDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const authFile = join(piDir, "auth.json");
if (existsSync(authFile)) ok("pi auth storage exists (contents not inspected)");
else warn("pi auth storage not found; use make pi-login or configure an API key in .env");

const capabilityApproval = diagnoseCapabilityApprovalMetadata();
if (capabilityApproval.pin.ok) {
  ok("command-guard identity PIN metadata is owner-only and safe (contents not inspected)");
} else {
  warn(`workspace capability approval PIN metadata is unavailable or unsafe (${capabilityApproval.pin.reason}); provision the PIN outside Wayang`);
}
if (capabilityApproval.state.ok) {
  ok("workspace capability approval cooldown metadata is owner-only and safe (contents not inspected)");
} else {
  warn(`workspace capability approval cooldown metadata is unavailable or unsafe (${capabilityApproval.state.reason}); run make setup-capability-approval after provisioning the identity PIN`);
}

const providerVariables = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY",
  "XAI_API_KEY", "FIREWORKS_API_KEY",
];
const presentProviders = providerVariables.filter((name) => Boolean(process.env[name]));
if (presentProviders.length > 0) ok(`provider environment present: ${presentProviders.join(", ")} (values hidden)`);

const chromium = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"].find(executable);
if (process.env.WAYANG_CHROMIUM_PATH) ok("WAYANG_CHROMIUM_PATH is present (value hidden; not inspected)");
else if (chromium) ok(`optional Chromium browser found: ${chromium}`);
else warn("optional browser workbench requires Chromium/Chrome or WAYANG_CHROMIUM_PATH");

if (existsSync(join(root, "backend", "dist", "index.js")) && existsSync(join(root, "frontend", "dist", "index.html"))) {
  ok("production build output exists");
} else warn("production build output is absent or incomplete (run make build)");

console.log(`\nDoctor completed with ${failures} failure(s), ${warnings} warning(s).`);
if (failures > 0) process.exitCode = 1;
