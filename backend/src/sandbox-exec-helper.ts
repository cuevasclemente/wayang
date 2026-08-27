import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { buildRestrictedSandboxEnv } from "./child-env.js";
import type { SandboxExecRequest } from "./sandbox-exec-protocol.js";

let started = false;

async function run(request: SandboxExecRequest): Promise<number> {
  // A helper file can be updated before its long-lived parent backend is
  // restarted. Treat that legacy missing field as deny-all so the transition
  // remains usable without silently enabling networking.
  const networkMode = request?.networkMode ?? "deny_all";
  if (
    !request
    || typeof request.command !== "string"
    || typeof request.cwd !== "string"
    || !request.config
    || !["host", "allow_all_proxy", "deny_all"].includes(networkMode)
  ) {
    throw new Error("Invalid sandbox execution request");
  }
  if (networkMode === "host" && process.platform !== "linux") {
    throw new Error("Host-network filesystem sandbox is supported only on Linux");
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-bash-"));
  const config = structuredClone(request.config);
  config.filesystem.allowWrite = [...config.filesystem.allowWrite, tempDir];
  process.env.CLAUDE_CODE_TMPDIR = tempDir;

  try {
    // Initialize SRT so its filesystem and credential policy is prepared.
    // Production host mode then uses SRT's live config update to remove the
    // allowlist field entirely. SRT interprets an absent allowedDomains field
    // as no network restriction, so Bubblewrap retains the host network
    // namespace while filesystem/PID/seccomp controls remain active.
    await SandboxManager.initialize(
      config,
      networkMode === "allow_all_proxy" ? async () => true : undefined,
    );
    if (networkMode === "host") {
      const hostConfig = structuredClone(config);
      Reflect.deleteProperty(hostConfig.network, "allowedDomains");
      SandboxManager.updateConfig(hostConfig);
    }
    // SRT deliberately places loopback in NO_PROXY for proxy mode. Clear both
    // spellings there so loopback/LAN/public destinations use proxy egress.
    // Host mode receives no proxy variables because the helper's strict child
    // environment excludes ambient deployment proxy settings.
    const command = networkMode === "allow_all_proxy"
      ? `export NO_PROXY='' no_proxy='';\n${request.command}`
      : request.command;
    const wrapped = await SandboxManager.wrapWithSandboxArgv(command, "/bin/bash", undefined, undefined, request.cwd);
    if (networkMode === "host") {
      const serializedArgv = wrapped.argv.join("\u0000");
      if (serializedArgv.includes("--unshare-net")
        || /(?:HTTP|HTTPS|ALL)_PROXY=|(?:http|https|all)_proxy=/.test(serializedArgv)) {
        throw new Error("Host-network compatibility check failed closed");
      }
    }
    const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd: request.cwd,
      env: buildRestrictedSandboxEnv(wrapped.env),
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
    });
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    SandboxManager.cleanupAfterCommand();
    // SRT 0.0.65 can wait indefinitely while concurrently closing its mux and
    // HTTP server after a proxied keep-alive request. This helper is already a
    // one-command process, so bound graceful cleanup; process exit reclaims any
    // remaining process-local proxy handles after the bridge teardown phase.
    let cleanupTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      SandboxManager.reset().catch(() => undefined),
      new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(resolve, 5_000);
      }),
    ]);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

process.on("message", (message: SandboxExecRequest) => {
  if (started) return;
  started = true;
  void run(message).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`Wayang sandbox failed closed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(125);
    },
  );
});
