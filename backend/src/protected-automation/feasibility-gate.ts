import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  getDefaultWritePaths,
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

export type FeasibilityStatus = "PASS" | "FAIL" | "BLOCKED";

export interface FeasibilityCheck {
  id: string;
  status: FeasibilityStatus;
  detail: string;
}

export interface FeasibilityReport {
  verdict: "GO" | "NO-GO";
  platform: NodeJS.Platform;
  runtimeVersion: "0.0.65";
  checks: FeasibilityCheck[];
}

const MAX_CAPTURE_BYTES = 128 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const fixturePath = fileURLToPath(new URL("./feasibility-fixture.mjs", import.meta.url));

function canonical(target: string): string {
  try { return fs.realpathSync.native(target); } catch { return path.resolve(target); }
}

function uniqueExisting(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((candidate) => fs.existsSync(candidate)).map(canonical))];
}

function within(target: string, root: string): boolean {
  const relative = path.relative(canonical(root), canonical(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function resolveExecutable(name: string): string | null {
  for (const root of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!root) continue;
    const candidate = path.join(root, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return canonical(candidate);
    } catch { /* continue */ }
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function check(id: string, status: FeasibilityStatus, detail: string): FeasibilityCheck {
  return { id, status, detail };
}

function encodeFrame(value: unknown): Buffer<ArrayBufferLike> {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  assert.ok(body.byteLength <= MAX_FRAME_BYTES);
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

class OneFrameDecoder {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer<ArrayBufferLike>): unknown | undefined {
    if (this.pending.byteLength + chunk.byteLength > MAX_FRAME_BYTES + 4) throw new Error("RPC frame too large");
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.byteLength < 4) return undefined;
    const length = this.pending.readUInt32BE(0);
    if (length > MAX_FRAME_BYTES) throw new Error("RPC frame too large");
    if (this.pending.byteLength < length + 4) return undefined;
    if (this.pending.byteLength !== length + 4) throw new Error("RPC trailing bytes");
    return JSON.parse(this.pending.subarray(4).toString("utf8"));
  }
}

function terminateProcessGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  const force = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }, 500);
  force.unref();
}

async function spawnBounded(
  argv: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; rpcRequest?: unknown; timeoutMs: number; abortSignal?: AbortSignal },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; rpc?: unknown; timedOut: boolean; cancelled: boolean }> {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe", options.rpcRequest === undefined ? "ignore" : "pipe"],
  });
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let rpc: unknown;
  let captureFailure: Error | undefined;
  const decoder = new OneFrameDecoder();
  const append = (previous: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
    if (previous.byteLength + chunk.byteLength > MAX_CAPTURE_BYTES) throw new Error("child output exceeded bound");
    return Buffer.concat([previous, chunk]);
  };
  child.stdout?.on("data", (chunk: Buffer<ArrayBufferLike>) => {
    try { stdout = append(stdout, chunk); } catch (error) { captureFailure = error as Error; terminateProcessGroup(child); }
  });
  child.stderr?.on("data", (chunk: Buffer<ArrayBufferLike>) => {
    try { stderr = append(stderr, chunk); } catch (error) { captureFailure = error as Error; terminateProcessGroup(child); }
  });
  if (options.rpcRequest !== undefined) {
    const channel = child.stdio[3];
    if (!channel || typeof (channel as unknown as NodeJS.WritableStream).write !== "function") throw new Error("RPC fd unavailable");
    const rpcChannel = channel as unknown as NodeJS.ReadWriteStream;
    rpcChannel.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      try { rpc = decoder.push(chunk); } catch (error) { captureFailure = error as Error; terminateProcessGroup(child); }
    });
    rpcChannel.on("error", () => {
      rpc = { error: "RPC fd failed" };
    });
    try { rpcChannel.write(encodeFrame(options.rpcRequest)); }
    catch { rpc = { error: "RPC fd failed" }; }
  }
  let timedOut = false;
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    terminateProcessGroup(child);
  };
  options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (options.abortSignal?.aborted) onAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child);
  }, options.timeoutMs);
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    clearTimeout(timer);
    options.abortSignal?.removeEventListener("abort", onAbort);
  });
  if (captureFailure) throw captureFailure;
  return { ...outcome, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), rpc, timedOut, cancelled };
}

async function createSyntheticHttpServer(): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain", "content-length": "12", connection: "close" });
    response.end("synthetic-ok");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("synthetic server did not bind TCP");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function probeSandboxDescendantCleanup(
  argv: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  heartbeat: string,
  reason: "timeout" | "cancel",
): Promise<boolean> {
  const controller = new AbortController();
  const cancelTimer = reason === "cancel" ? setTimeout(() => controller.abort(), 1_000) : undefined;
  const outcome = await spawnBounded(argv, {
    cwd,
    env: environment,
    timeoutMs: reason === "timeout" ? 1_000 : 5_000,
    abortSignal: controller.signal,
  }).finally(() => { if (cancelTimer) clearTimeout(cancelTimer); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const first = fs.existsSync(heartbeat) ? fs.statSync(heartbeat).size : 0;
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = fs.existsSync(heartbeat) ? fs.statSync(heartbeat).size : 0;
  return (reason === "timeout" ? outcome.timedOut : outcome.cancelled) && first > 0 && first === second;
}

function packageRootForSandboxRuntime(): string {
  const entry = fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"));
  return canonical(path.resolve(path.dirname(entry), ".."));
}

export async function runProtectedAutomationFeasibilityGate(): Promise<FeasibilityReport> {
  const checks: FeasibilityCheck[] = [];
  if (process.platform !== "linux") {
    return {
      verdict: "NO-GO",
      platform: process.platform,
      runtimeVersion: "0.0.65",
      checks: [check("linux_host", "BLOCKED", "This focused spike must run on Linux; macOS remains a separate required host gate.")],
    };
  }

  const dependencies = SandboxManager.checkDependencies();
  if (dependencies.errors.length > 0) {
    return {
      verdict: "NO-GO",
      platform: process.platform,
      runtimeVersion: "0.0.65",
      checks: [check("sandbox_dependencies", "BLOCKED", dependencies.errors.join(", "))],
    };
  }
  checks.push(check("sandbox_dependencies", "PASS", dependencies.warnings.length === 0 ? "Linux sandbox dependencies are available." : dependencies.warnings.join(", ")));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-automation-feasibility-"));
  const project = path.join(root, "project");
  const snapshot = path.join(root, "snapshot");
  const run = path.join(root, "run");
  const state = path.join(root, "state");
  const unrelatedHome = path.join(root, "unrelated-home");
  for (const directory of [project, snapshot, run, state, unrelatedHome]) fs.mkdirSync(directory, { mode: 0o700 });
  const snapshotFixture = path.join(snapshot, "feasibility-fixture.mjs");
  fs.copyFileSync(fixturePath, snapshotFixture, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(snapshotFixture, 0o400);
  const canary = path.join(unrelatedHome, "canary.txt");
  fs.writeFileSync(canary, "SYNTHETIC_UNRELATED_HOME_CANARY\n", { mode: 0o600 });
  const outsideWrite = path.join(unrelatedHome, "outside-write.txt");
  const server = await createSyntheticHttpServer();

  const shell = canonical("/bin/bash");
  const socat = resolveExecutable("socat");
  const runtimePackageRoot = packageRootForSandboxRuntime();
  const libraryRoots = uniqueExisting(["/lib", "/lib64", "/usr/lib", "/usr/lib64", "/etc/ld.so.cache", "/usr/share/icu"]);
  const allowedRead = uniqueExisting([
    process.execPath,
    shell,
    ...(socat ? [socat] : []),
    runtimePackageRoot,
    ...libraryRoots,
    snapshot,
    project,
    run,
    state,
  ]);
  const config: SandboxRuntimeConfig = {
    network: {
      allowedDomains: ["127.0.0.1"],
      deniedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: ["/"],
      allowRead: allowedRead,
      allowWrite: [project, run, state],
      denyWrite: [snapshot, unrelatedHome],
      allowGitConfig: false,
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
  };

  const previousClaudeCodeTmpdir = process.env.CLAUDE_CODE_TMPDIR;
  try {
    process.env.CLAUDE_CODE_TMPDIR = run;
    await SandboxManager.initialize(config);
    const command = `${shellQuote(canonical(process.execPath))} ${shellQuote(snapshotFixture)} probe`;
    const descriptor = await SandboxManager.wrapWithSandboxArgv(command, shell, undefined, undefined, project);
    const descriptorText = descriptor.argv.join("\n");
    const outerShell = descriptor.argv.length >= 3 && canonical(descriptor.argv[0]!) === shell && descriptor.argv[1] === "-c";
    checks.push(check(
      "shell_free_backend_resolved_node",
      outerShell ? "FAIL" : "PASS",
      outerShell
        ? "Linux wrapWithSandboxArgv() returns a shell -c descriptor rather than backend-resolved Node argv."
        : "The sandbox descriptor does not add an outer shell.",
    ));
    checks.push(check(
      "exact_node_executable_view",
      "FAIL",
      "SRT requires a shell, socat, and its apply-seccomp runtime inside the read allow-back; the executable view cannot contain only backend-resolved Node.",
    ));
    const proxyInjected = /HTTP_PROXY|http_proxy/.test(descriptorText);
    checks.push(check(
      "proxy_without_shell_prelude",
      proxyInjected && descriptorText.includes("socat") ? "FAIL" : "BLOCKED",
      proxyInjected
        ? "Proxy variables are injected by bubblewrap, but Linux proxy setup runs shell-authored socat preludes before Node."
        : "Proxy injection was not present in the generated descriptor.",
    ));

    const defaultWritesOutsideExactRoots = getDefaultWritePaths().filter((candidate) =>
      ![project, run, state].some((allowed) => within(candidate, allowed))
      && !candidate.startsWith("/dev/"),
    );
    checks.push(check(
      "exact_write_allowlist",
      defaultWritesOutsideExactRoots.length === 0 ? "PASS" : "FAIL",
      defaultWritesOutsideExactRoots.length === 0
        ? "No SRT compatibility write roots extend the exact project/run/state roots."
        : `SRT unconditionally adds ${defaultWritesOutsideExactRoots.length} non-device compatibility write roots outside the exact project/run/state allowlist.`,
    ));

    const strictEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: unrelatedHome,
      LANG: "C.UTF-8",
      WAYANG_AUTOMATION_PROJECT_DIR: project,
      WAYANG_AUTOMATION_RUN_DIR: run,
      WAYANG_AUTOMATION_STATE_DIR: state,
      WAYANG_AUTOMATION_SNAPSHOT_DIR: snapshot,
      WAYANG_AUTOMATION_CANARY: canary,
      WAYANG_AUTOMATION_OUTSIDE_WRITE: outsideWrite,
      WAYANG_AUTOMATION_PROXY_TARGET: server.url,
      WAYANG_AUTOMATION_WRAPPER_SHELL: shell,
    };
    const execution = await spawnBounded(descriptor.argv, {
      cwd: project,
      env: strictEnv,
      rpcRequest: { id: 1, method: "synthetic.echo", params: { value: "bounded" } },
      timeoutMs: 10_000,
    });
    if (execution.code !== 0) {
      checks.push(check("root_deny_read_allowlist_runtime", "BLOCKED", `The restrictive synthetic child failed closed (exit ${execution.code}); stderr was ${execution.stderr.length} bounded bytes.`));
      checks.push(check("inherited_framed_extra_stdio", "BLOCKED", "The restrictive child did not reach the framed FD probe."));
      checks.push(check("forbidden_child_process_exec", "BLOCKED", "The restrictive child did not reach child_process probes."));
    } else {
      const line = execution.stdout.trim().split("\n").at(-1);
      const probe = JSON.parse(line ?? "null") as {
        canaryHidden: boolean;
        snapshotReadable: boolean;
        projectWrite: boolean;
        runWrite: boolean;
        stateWrite: boolean;
        snapshotWriteDenied: boolean;
        outsideWriteDenied: boolean;
        proxy: { configured: boolean; reached: boolean };
        rpc: { ok: boolean };
        exec: Record<"binSh" | "usrBinEnv" | "unrelated" | "wrapperShell", { succeeded: boolean }>;
      };
      const rootsPass = probe.canaryHidden && probe.snapshotReadable && probe.projectWrite && probe.runWrite
        && probe.stateWrite && probe.snapshotWriteDenied && probe.outsideWriteDenied;
      checks.push(check("root_deny_read_allowlist_runtime", rootsPass ? "PASS" : "FAIL", rootsPass
        ? "Synthetic unrelated-home canary was hidden; snapshot/project/run/state reads and exact writes behaved as configured."
        : "One or more root-deny/read-allow-back/write assertions failed."));
      const rpcPass = probe.rpc.ok && JSON.stringify(execution.rpc) === JSON.stringify({ id: 1, ok: true, result: { echoed: "bounded" } });
      checks.push(check("inherited_framed_extra_stdio", rpcPass ? "PASS" : "FAIL", rpcPass
        ? "A bounded 4-byte-length-prefixed JSON request/response round-tripped over inherited fd 3."
        : "Inherited fd 3 did not complete the bounded framed round-trip."));
      const listedBinariesDenied = !probe.exec.binSh.succeeded && !probe.exec.usrBinEnv.succeeded && !probe.exec.unrelated.succeeded;
      const wrapperShellHidden = !probe.exec.wrapperShell.succeeded;
      checks.push(check("forbidden_child_process_exec", listedBinariesDenied && wrapperShellHidden ? "PASS" : "FAIL",
        listedBinariesDenied && wrapperShellHidden
          ? "All synthetic child_process executable probes were denied."
          : `Listed binaries denied=${listedBinariesDenied}; SRT-required wrapper shell denied=${wrapperShellHidden}. Exact-Node-only execution is not enforced.`));
      checks.push(check("local_proxy_round_trip", probe.proxy.configured && probe.proxy.reached ? "PASS" : "FAIL",
        probe.proxy.configured && probe.proxy.reached
          ? "Node reached a synthetic host-loopback HTTP endpoint through injected proxy variables without Internet."
          : "The synthetic proxy round-trip failed."));
    }

    const descendantCommand = `${shellQuote(canonical(process.execPath))} ${shellQuote(snapshotFixture)} descendant-parent`;
    const descendantDescriptor = await SandboxManager.wrapWithSandboxArgv(descendantCommand, shell, undefined, undefined, project);
    const timeoutHeartbeat = path.join(state, "timeout-heartbeat.txt");
    const cancelHeartbeat = path.join(state, "cancel-heartbeat.txt");
    const timeoutCleanup = await probeSandboxDescendantCleanup(descendantDescriptor.argv, project, {
      ...strictEnv,
      WAYANG_AUTOMATION_HEARTBEAT: timeoutHeartbeat,
    }, timeoutHeartbeat, "timeout");
    const cancelCleanup = await probeSandboxDescendantCleanup(descendantDescriptor.argv, project, {
      ...strictEnv,
      WAYANG_AUTOMATION_HEARTBEAT: cancelHeartbeat,
    }, cancelHeartbeat, "cancel");
    checks.push(check("ordinary_descendant_timeout_cleanup", timeoutCleanup && cancelCleanup ? "PASS" : "FAIL", timeoutCleanup && cancelCleanup
      ? "The sandbox wrapper and ordinary Node descendant stopped after bounded timeout and cancellation TERM/KILL supervision; heartbeat writes ceased."
      : `Sandbox descendant cleanup failed (timeout=${timeoutCleanup}, cancellation=${cancelCleanup}).`));
    checks.push(check("no_pi_provider_or_protected_state", "PASS", "The spike used only synthetic temporary roots and a fresh allowlisted child environment; it did not construct Pi/model/session/provider facilities."));
  } catch (error) {
    checks.push(check("runtime_probe", "BLOCKED", error instanceof Error ? error.message : "runtime probe failed"));
  } finally {
    if (previousClaudeCodeTmpdir === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
    else process.env.CLAUDE_CODE_TMPDIR = previousClaudeCodeTmpdir;
    SandboxManager.cleanupAfterCommand();
    await Promise.race([
      SandboxManager.reset().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  const requiredIds = new Set([
    "shell_free_backend_resolved_node",
    "exact_node_executable_view",
    "exact_write_allowlist",
    "proxy_without_shell_prelude",
    "root_deny_read_allowlist_runtime",
    "ordinary_descendant_timeout_cleanup",
    "inherited_framed_extra_stdio",
    "forbidden_child_process_exec",
  ]);
  const required = checks.filter((item) => requiredIds.has(item.id));
  const verdict = required.length === requiredIds.size && required.every((item) => item.status === "PASS") ? "GO" : "NO-GO";
  return { verdict, platform: process.platform, runtimeVersion: "0.0.65", checks };
}
