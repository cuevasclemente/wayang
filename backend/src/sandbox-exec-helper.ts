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
    || !["allow_all_proxy", "deny_all"].includes(networkMode)
  ) {
    throw new Error("Invalid sandbox execution request");
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-bash-"));
  const config = structuredClone(request.config);
  config.filesystem.allowWrite = [...config.filesystem.allowWrite, tempDir];
  process.env.CLAUDE_CODE_TMPDIR = tempDir;

  try {
    // Production Wayang uses allow_all_proxy: its project boundary is
    // filesystem- and workflow-oriented rather than a destination allowlist.
    // deny_all is retained for fail-closed live-upgrade compatibility.
    await SandboxManager.initialize(
      config,
      networkMode === "allow_all_proxy" ? async () => true : undefined,
    );
    // SRT deliberately places loopback in NO_PROXY. In Wayang's selected
    // allow-all mode that would bypass the host proxy and target the empty
    // sandbox namespace instead. Clear both conventional spellings inside the
    // command shell so loopback/LAN/public destinations all use proxy egress.
    const command = networkMode === "allow_all_proxy"
      ? `export NO_PROXY='' no_proxy='';\n${request.command}`
      : request.command;
    const wrapped = await SandboxManager.wrapWithSandboxArgv(command, "/bin/bash", undefined, undefined, request.cwd);
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
