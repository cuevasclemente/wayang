import { defineConfig } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, "..");
const backendPort = Number.parseInt(process.env.WAYANG_E2E_BACKEND_PORT || "18787", 10);
const frontendPort = Number.parseInt(process.env.WAYANG_E2E_FRONTEND_PORT || "15173", 10);
const host = "127.0.0.1";
// playwright re-imports this config in every worker process. mkdtempSync
// would create a fresh dir per worker, decoupling the backend's data dir
// from the test workers' view. Only create the temp dir once per main
// process run; workers reuse it via the env var.
const tempRoot =
  process.env.WAYANG_E2E_TEMP_ROOT ||
  fs.mkdtempSync(path.join(os.tmpdir(), "wayang-e2e-"));
process.env.WAYANG_E2E_TEMP_ROOT = tempRoot;
const backendUrl = `http://${host}:${backendPort}`;
const frontendUrl = `http://${host}:${frontendPort}`;
const piAgentDir = path.join(tempRoot, "pi-agent");
const piSessionsDir = path.join(piAgentDir, "sessions");
const dataDir = path.join(tempRoot, "web-ui-data");
const syntheticHome = path.join(tempRoot, "home");
const productionMode = process.env.WAYANG_E2E_PRODUCTION === "1";
fs.mkdirSync(piSessionsDir, { recursive: true });
fs.mkdirSync(syntheticHome, { recursive: true, mode: 0o700 });

// Web servers receive an explicit, secret-free environment allowlist. Never
// forward the parent agent's provider tokens, credential broker variables, or
// production Wayang/session paths into synthetic browser tests.
const allowedEnvironmentNames = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "XDG_RUNTIME_DIR",
  "CI",
] as const;
const allowedEnvironment = Object.fromEntries(
  allowedEnvironmentNames.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]),
);

// Expose paths to test workers via process.env so tests can synthesize
// pi session files in the same directory the backend reads from.
process.env.WAYANG_E2E_PI_SESSIONS_DIR = piSessionsDir;
process.env.WAYANG_E2E_PI_AGENT_DIR = piAgentDir;
process.env.WAYANG_E2E_DATA_DIR = dataDir;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  outputDir: path.join(tempRoot, "playwright-results"),
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL: frontendUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
  webServer: [
    {
      command: productionMode ? "npm run build && npm start" : "npm run dev:e2e",
      cwd: path.join(repoRoot, "backend"),
      url: `${backendUrl}/healthz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...allowedEnvironment,
        // Force NODE_ENV=development so vite/tsx are available; some shells
        // export NODE_ENV=production which makes `npm run dev` fail because
        // devDependencies (vite, tsx) get pruned.
        NODE_ENV: "development",
        HOME: syntheticHome,
        USER: "wayang-e2e",
        LOGNAME: "wayang-e2e",
        WAYANG_HOST: host,
        WAYANG_PORT: String(backendPort),
        WAYANG_PUBLIC_ORIGIN: frontendUrl,
        WAYANG_DATA_DIR: dataDir,
        // pi reads PI_CODING_AGENT_DIR to find its agent root; sessions live
        // under <agentDir>/sessions. PI_CODING_AGENT_SESSION_DIR only affects
        // the `--session-dir` CLI flag, not SessionManager.listAll().
        PI_CODING_AGENT_DIR: piAgentDir,
        PI_CODING_AGENT_SESSION_DIR: piSessionsDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
    },
    {
      command: productionMode
        ? `npm run build && npm run preview -- --host ${host} --port ${frontendPort}`
        : `npm run dev -- --host ${host} --port ${frontendPort}`,
      cwd: path.join(repoRoot, "frontend"),
      url: `${frontendUrl}/healthz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...allowedEnvironment,
        NODE_ENV: "development",
        VITE_WAYANG_BACKEND_URL: backendUrl,
        VITE_WAYANG_LATENCY_PROFILE: "1",
      },
    },
  ],
});
