import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const DEFAULT_PATH = process.platform === "darwin" ? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const ENVIRONMENT_KEYS = new Set([
  "HOME", "TMPDIR", "PATH", "LANG", "LC_ALL", "TZ", "NO_COLOR",
  "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_TERMINAL_PROMPT", "GIT_ASKPASS", "SSH_ASKPASS",
  "GIT_NO_REPLACE_OBJECTS", "GIT_ATTR_NOSYSTEM",
]);

function absolute(value, name) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || /[\r\n]/.test(value)) throw new TypeError(`${name} must be a safe absolute path`);
  return value;
}

export async function resolveTrustedExecutable(name, searchPath = DEFAULT_PATH) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._+-]+$/.test(name)) throw new TypeError("executable name must be a basename");
  for (const directory of searchPath.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {}
  }
  throw new Error(`trusted executable ${name} was not found`);
}

export function createMinimalEnvironment({ home, tmpDir } = {}) {
  absolute(home, "home");
  absolute(tmpDir, "tmpDir");
  return Object.freeze({
    HOME: home,
    TMPDIR: tmpDir,
    PATH: DEFAULT_PATH,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig-disabled"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1",
  });
}

function safeArgv(executable, args) {
  absolute(executable, "executable");
  if (!Array.isArray(args) || args.length > 256) throw new TypeError("argv must contain at most 256 arguments");
  for (const argument of args) {
    if (typeof argument !== "string" || argument.includes("\0") || Buffer.byteLength(argument) > 16 * 1024) throw new TypeError("argv contains an invalid argument");
  }
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function truncateUtf8(buffer, maxBytes) {
  let end = Math.min(buffer.length, maxBytes);
  while (end > 0) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end)); }
    catch { end -= 1; }
  }
  return "";
}

export function redactOutput(value, { secrets = [] } = {}) {
  let result = String(value);
  for (const secret of [...new Set(secrets.filter((item) => typeof item === "string" && item.length >= 4))].sort((a, b) => b.length - a.length)) {
    result = result.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }
  result = result
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [REDACTED]")
    .replace(/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Za-z0-9_]*)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
  return result;
}

function terminate(child) {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {}
}

function kill(child) {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {}
}

async function runProcessCore({
  executable,
  args = [],
  cwd,
  environment,
  timeoutMs = 30_000,
  maxOutputBytes = 64 * 1024,
  redactionSecrets = [],
  parseStdout,
} = {}) {
  safeArgv(executable, args);
  absolute(cwd, "cwd");
  if (!environment || (Object.getPrototypeOf(environment) !== null && Object.getPrototypeOf(environment) !== Object.prototype)) throw new TypeError("a minimal environment object is required");
  const environmentKeys = Object.keys(environment);
  if (environmentKeys.length !== ENVIRONMENT_KEYS.size || environmentKeys.some((key) => !ENVIRONMENT_KEYS.has(key))) {
    throw new TypeError("process environment must contain exactly the minimal allowlist");
  }
  for (const key of ENVIRONMENT_KEYS) {
    if (typeof environment[key] !== "string" || environment[key].includes("\0") || /[\r\n]/.test(environment[key])) throw new TypeError(`invalid minimal environment value for ${key}`);
  }
  absolute(environment.HOME, "environment.HOME");
  absolute(environment.TMPDIR, "environment.TMPDIR");
  if (environment.PATH !== DEFAULT_PATH || environment.GIT_CONFIG_GLOBAL !== join(environment.HOME, ".gitconfig-disabled") ||
      environment.LANG !== "C" || environment.LC_ALL !== "C" || environment.TZ !== "UTC" || environment.NO_COLOR !== "1" ||
      environment.GIT_CONFIG_NOSYSTEM !== "1" || environment.GIT_TERMINAL_PROMPT !== "0" || environment.GIT_ASKPASS !== "" || environment.SSH_ASKPASS !== "" ||
      environment.GIT_NO_REPLACE_OBJECTS !== "1" || environment.GIT_ATTR_NOSYSTEM !== "1") {
    throw new TypeError("process environment fixed safety values were changed");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60 * 60 * 1000) throw new TypeError("invalid process timeout");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 256 || maxOutputBytes > 4 * 1024 * 1024) throw new TypeError("invalid output bound");
  if (parseStdout !== undefined && typeof parseStdout !== "function") throw new TypeError("parseStdout must be a trusted bounded parser");

  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...environment },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let retained = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let forcePromise;

    const stop = () => {
      terminate(child);
      if (!forcePromise) {
        forcePromise = new Promise((settled) => {
          setTimeout(() => {
            kill(child);
            setTimeout(settled, 25);
          }, 500);
        });
      }
    };
    const collect = (stream) => (chunk) => {
      const remaining = Math.max(0, maxOutputBytes - retained);
      const kept = chunk.subarray(0, remaining);
      retained += kept.length;
      if (stream === "stdout") stdout = Buffer.concat([stdout, kept]);
      else stderr = Buffer.concat([stderr, kept]);
      if (kept.length < chunk.length && !outputLimitExceeded) {
        outputLimitExceeded = true;
        stop();
      }
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", async (code, signal) => {
      clearTimeout(timeout);
      if (forcePromise) await forcePromise;
      let parsedStdout;
      try {
        parsedStdout = parseStdout && !outputLimitExceeded ? parseStdout(stdout) : undefined;
      } catch (error) {
        reject(error);
        return;
      }
      const redactedStdout = Buffer.from(redactOutput(stdout.toString("utf8"), { secrets: redactionSecrets }));
      const redactedStderr = Buffer.from(redactOutput(stderr.toString("utf8"), { secrets: redactionSecrets }));
      const redactionBounded = redactedStdout.length + redactedStderr.length > maxOutputBytes;
      const bounded = outputLimitExceeded || redactionBounded;
      const marker = bounded ? Buffer.from(outputLimitExceeded ? "\n[output truncated: limit exceeded]" : "\n[redacted output bounded]") : Buffer.alloc(0);
      const contentBudget = Math.max(0, maxOutputBytes - marker.length);
      const safeStdout = truncateUtf8(redactedStdout, contentBudget);
      const stderrBudget = Math.max(0, contentBudget - Buffer.byteLength(safeStdout));
      const safeStderr = truncateUtf8(redactedStderr, stderrBudget);
      resolve(Object.freeze({
        ok: code === 0 && !timedOut && !bounded,
        code,
        signal,
        timedOut,
        outputLimitExceeded: bounded,
        stdout: safeStdout,
        stderr: safeStderr + marker.toString("utf8"),
        parsedStdout,
      }));
    });
  });
}

export function runProcess(options = {}) {
  if (Object.hasOwn(options, "parseStdout")) throw new TypeError("machine-readable parsing is not available through the public process API");
  return runProcessCore(options);
}

// Internal trusted path for deterministic protocol adapters. Parsers return
// validated structured data; raw bytes never enter logs or public results.
export function runProcessParsed(options, parseStdout) {
  if (typeof parseStdout !== "function") throw new TypeError("a trusted bounded parser is required");
  return runProcessCore({ ...options, parseStdout });
}
