import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex, Readable } from "node:stream";
import { ProtectedAutomationNeedsUserError } from "./attention.js";
import { isProtectedAutomationBrowserRpcMethod } from "./browser-protocol.js";
import type { ProtectedAutomationBrowserRequestPort } from "./browser-rpc.js";
import { resolveProtectedAutomationSnapshotSourceForExecution } from "./snapshots.js";
import {
  MAX_PROTECTED_AUTOMATION_BROWSER_FRAME_BYTES,
  MAX_PROTECTED_AUTOMATION_STDERR_BYTES,
  MAX_PROTECTED_AUTOMATION_STDOUT_BYTES,
  PROTECTED_AUTOMATION_TERM_GRACE_MS,
  type ProtectedAutomationRunnerJob,
  type ProtectedAutomationRunnerResult,
} from "./types.js";

const NODE_PATH = "/usr/bin/node";
const LDD_PATH = "/usr/bin/ldd";
const BWRAP_PATH = "/usr/bin/bwrap";
const SANDBOX_NODE_PATH = "/usr/bin/node";
const SANDBOX_SECCOMP_PATH = "/runtime/apply-seccomp";
const SANDBOX_SNAPSHOT_ROOT = "/snapshot";
const SANDBOX_PROJECT_ROOT = "/workspace";
const SANDBOX_RUN_ROOT = "/run/wayang-automation/run";
const SANDBOX_STATE_ROOT = "/run/wayang-automation/state";
const MAX_LDD_OUTPUT_BYTES = 1024 * 1024;
const MAX_BROWSER_REQUESTS = 64;
const MAX_BROWSER_TOTAL_BYTES = MAX_BROWSER_REQUESTS * (MAX_PROTECTED_AUTOMATION_BROWSER_FRAME_BYTES + 4);

type Bytes = Buffer<ArrayBufferLike>;

interface RuntimeBind {
  source: string;
  destination: string;
  sha256: string;
}

interface RuntimeClosure {
  binds: RuntimeBind[];
  seccompSource: string;
  seccompSha256: string;
  bwrapSource: string;
  bwrapSha256: string;
}

/** @deprecated Import ProtectedAutomationBrowserRequestPort from browser-rpc.ts. */
export interface ProtectedAutomationBrowserPort extends ProtectedAutomationBrowserRequestPort {}

export interface ProtectedAutomationRunnerOptions {
  runRoot: string;
  stateRoot: string;
  signal?: AbortSignal;
  browserPort?: ProtectedAutomationBrowserPort;
  /** A fresh durable exact-pair authority checkpoint immediately before spawn. */
  assertAuthorized(): void;
}

interface ElfInfo {
  interpreter: string | null;
  dynamic: boolean;
}

let closurePromise: Promise<RuntimeClosure> | null = null;

function inspectElf(bytes: Bytes): ElfInfo {
  if (bytes.length < 64 || bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1) {
    throw new Error("protected automation runtime is not a supported Linux ELF");
  }
  const programOffset = Number(bytes.readBigUInt64LE(32));
  const entrySize = bytes.readUInt16LE(54);
  const entryCount = bytes.readUInt16LE(56);
  if (!Number.isSafeInteger(programOffset) || entrySize < 56) throw new Error("protected automation ELF metadata is invalid");
  let interpreter: string | null = null;
  let dynamic = false;
  for (let index = 0; index < entryCount; index += 1) {
    const offset = programOffset + index * entrySize;
    if (offset + 56 > bytes.length) throw new Error("protected automation ELF metadata is truncated");
    const type = bytes.readUInt32LE(offset);
    if (type === 2) dynamic = true;
    if (type !== 3) continue;
    const contentOffset = Number(bytes.readBigUInt64LE(offset + 8));
    const contentSize = Number(bytes.readBigUInt64LE(offset + 32));
    if (!Number.isSafeInteger(contentOffset) || !Number.isSafeInteger(contentSize) || contentSize < 2
      || contentOffset < 0 || contentOffset + contentSize > bytes.length) {
      throw new Error("protected automation ELF interpreter is invalid");
    }
    interpreter = bytes.subarray(contentOffset, contentOffset + contentSize).toString("utf8").replace(/\0.*$/su, "");
    if (!path.isAbsolute(interpreter)) throw new Error("protected automation ELF interpreter is not absolute");
  }
  return { interpreter, dynamic };
}

async function requireRegularFile(target: string): Promise<string> {
  const canonical = await fs.realpath(target);
  const metadata = await fs.lstat(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("protected automation runtime component is unsafe");
  await fs.access(canonical, constants.R_OK);
  return canonical;
}

async function validateWritableRoot(root: string): Promise<void> {
  if (!path.isAbsolute(root)) throw new Error("protected automation writable root must be absolute");
  const rootMetadata = await fs.lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("protected automation writable root is unsafe");
  const visit = async (directory: string): Promise<void> => {
    for (const name of await fs.readdir(directory)) {
      const entry = path.join(directory, name);
      const metadata = await fs.lstat(entry);
      if (metadata.isSymbolicLink()) throw new Error("protected automation writable root contains a symlink");
      if (metadata.isDirectory()) { await visit(entry); continue; }
      if (!metadata.isFile() || metadata.nlink > 1) throw new Error("protected automation writable root contains an unsafe entry");
    }
  };
  await visit(root);
}

async function requireRegularExecutable(target: string): Promise<string> {
  const canonical = await requireRegularFile(target);
  await fs.access(canonical, constants.X_OK);
  return canonical;
}

async function sha256File(target: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(target)).digest("hex");
}

async function captureBounded(executable: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, env: { PATH: "" }, stdio: ["ignore", "pipe", "ignore"] });
    let output: Bytes = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Bytes) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > MAX_LDD_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        reject(new Error("protected automation runtime closure output exceeded its bound"));
      }
    });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve(output.toString("utf8"))
      : reject(new Error("protected automation runtime closure resolution failed")));
  });
}

function parseLdd(output: string): string[] {
  const libraries = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("linux-vdso.so")) continue;
    if (line.includes("=> not found")) throw new Error("protected automation runtime closure is incomplete");
    const arrow = /=>\s+(\/[^\s]+)\s+\(0x[0-9a-f]+\)$/iu.exec(line);
    const direct = /^(\/[^\s]+)\s+\(0x[0-9a-f]+\)$/iu.exec(line);
    const candidate = arrow?.[1] ?? direct?.[1];
    if (!candidate) throw new Error("protected automation runtime closure output is unrecognized");
    libraries.add(candidate);
  }
  if (libraries.size === 0) throw new Error("protected automation runtime closure is empty");
  return [...libraries].sort();
}

function seccompPackageDirectory(): string {
  return path.dirname(fileURLToPath(new URL("../../node_modules/@anthropic-ai/sandbox-runtime/package.json", import.meta.url)));
}

async function resolveRuntimeClosure(): Promise<RuntimeClosure> {
  if (process.platform !== "linux") throw new Error("protected automation runner is Linux-only");
  const [nodeSource, lddSource, bwrapSource] = await Promise.all([
    requireRegularExecutable(NODE_PATH),
    requireRegularExecutable(LDD_PATH),
    requireRegularExecutable(BWRAP_PATH),
  ]);
  const nodeElf = inspectElf(await fs.readFile(nodeSource));
  if (!nodeElf.dynamic || !nodeElf.interpreter) throw new Error("protected automation requires the reviewed dynamic Node runtime");
  const destinations = new Set(parseLdd(await captureBounded(lddSource, [nodeSource])));
  destinations.add(nodeElf.interpreter);
  const binds: RuntimeBind[] = [{ source: nodeSource, destination: SANDBOX_NODE_PATH, sha256: await sha256File(nodeSource) }];
  for (const destination of [...destinations].sort()) {
    const source = await requireRegularFile(destination);
    binds.push({ source, destination, sha256: await sha256File(source) });
  }
  const architecture = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
  if (!architecture) throw new Error("protected automation has no reviewed seccomp wrapper for this architecture");
  const seccompSource = await requireRegularExecutable(path.join(
    seccompPackageDirectory(), "vendor", "seccomp", architecture, "apply-seccomp",
  ));
  const seccompElf = inspectElf(await fs.readFile(seccompSource));
  if (seccompElf.dynamic || seccompElf.interpreter !== null) throw new Error("protected automation seccomp wrapper must be static");
  return {
    binds,
    seccompSource,
    seccompSha256: await sha256File(seccompSource),
    bwrapSource,
    bwrapSha256: await sha256File(bwrapSource),
  };
}

async function verifiedRuntimeClosure(): Promise<RuntimeClosure> {
  closurePromise ??= resolveRuntimeClosure();
  const closure = await closurePromise;
  await Promise.all([
    (async () => {
      if (await requireRegularExecutable(closure.bwrapSource) !== closure.bwrapSource
        || await sha256File(closure.bwrapSource) !== closure.bwrapSha256) {
        throw new Error("protected automation Bubblewrap runtime changed");
      }
    })(),
    ...closure.binds.map(async (bind) => {
      const resolved = bind.destination === SANDBOX_NODE_PATH
        ? await requireRegularExecutable(bind.source)
        : await requireRegularFile(bind.source);
      if (resolved !== bind.source || await sha256File(bind.source) !== bind.sha256) {
        throw new Error("protected automation runtime closure changed");
      }
    }),
    (async () => {
      if (await requireRegularExecutable(closure.seccompSource) !== closure.seccompSource
        || await sha256File(closure.seccompSource) !== closure.seccompSha256) {
        throw new Error("protected automation seccomp wrapper changed");
      }
    })(),
  ]);
  return closure;
}

function destinationDirectories(destinations: string[]): string[] {
  const directories = new Set<string>([
    "/dev", "/proc", "/runtime", "/run", "/run/wayang-automation", "/workspace", SANDBOX_SNAPSHOT_ROOT,
    SANDBOX_RUN_ROOT, SANDBOX_STATE_ROOT,
  ]);
  for (const destination of destinations) {
    let cursor = path.dirname(destination);
    while (cursor !== "/") {
      directories.add(cursor);
      cursor = path.dirname(cursor);
    }
  }
  return [...directories].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
}

function bubblewrapArgs(
  closure: RuntimeClosure,
  sourceRoot: string,
  request: ProtectedAutomationRunnerJob,
  options: ProtectedAutomationRunnerOptions,
): string[] {
  const runtimeBinds = [...closure.binds, { source: closure.seccompSource, destination: SANDBOX_SECCOMP_PATH }];
  const args = [
    "--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--unshare-cgroup-try", "--unshare-net", "--tmpfs", "/",
  ];
  for (const directory of destinationDirectories(runtimeBinds.map((bind) => bind.destination))) args.push("--dir", directory);
  for (const bind of runtimeBinds) args.push("--ro-bind", bind.source, bind.destination);
  args.push(
    "--ro-bind", sourceRoot, SANDBOX_SNAPSHOT_ROOT,
    "--bind", request.projectRoot, SANDBOX_PROJECT_ROOT,
    "--bind", options.runRoot, SANDBOX_RUN_ROOT,
    "--bind", options.stateRoot, SANDBOX_STATE_ROOT,
    "--proc", "/proc", "--dev", "/dev", "--remount-ro", "/dev", "--remount-ro", "/",
    "--clearenv", "--setenv", "HOME", "/nonexistent", "--setenv", "PATH", "", "--setenv", "LANG", "C.UTF-8",
    "--setenv", "WAYANG_AUTOMATION_PROJECT_DIR", SANDBOX_PROJECT_ROOT,
    "--setenv", "WAYANG_AUTOMATION_RUN_DIR", SANDBOX_RUN_ROOT,
    "--setenv", "WAYANG_AUTOMATION_STATE_DIR", SANDBOX_STATE_ROOT,
    ...(request.job.uses_browser_profile ? ["--setenv", "WAYANG_AUTOMATION_RPC_FD", "3"] : []),
    "--chdir", SANDBOX_PROJECT_ROOT,
    "--", SANDBOX_SECCOMP_PATH, SANDBOX_NODE_PATH,
    `${SANDBOX_SNAPSHOT_ROOT}/${request.job.entrypoint}`,
    ...request.job.argv,
  );
  return args;
}

function terminateTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch { /* process has already exited */ }
  }
}

function responseFrame(value: unknown): Bytes {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_PROTECTED_AUTOMATION_BROWSER_FRAME_BYTES) throw new Error("browser response exceeded its frame bound");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function exactBrowserRequest(value: unknown): { id: string; method: string; params: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("browser request is malformed");
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "id,method,params,type" || candidate.type !== "request"
    || typeof candidate.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(candidate.id)
    || typeof candidate.method !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(candidate.method)) {
    throw new Error("browser request is malformed");
  }
  return { id: candidate.id, method: candidate.method, params: candidate.params };
}

async function runChild(
  request: ProtectedAutomationRunnerJob,
  options: ProtectedAutomationRunnerOptions,
  bwrapSource: string,
  args: string[],
): Promise<ProtectedAutomationRunnerResult> {
  return await new Promise((resolve) => {
    const controller = new AbortController();
    let child: ChildProcess;
    try {
      child = spawn(bwrapSource, args, {
        shell: false,
        detached: true,
        env: { PATH: "" },
        stdio: request.job.uses_browser_profile ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ status: "failed", outcomeCode: "runner_spawn_failed", exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      return;
    }
    const stdoutStream = child.stdout as Readable;
    const stderrStream = child.stderr as Readable;
    let stdout: Bytes = Buffer.alloc(0);
    let stderr: Bytes = Buffer.alloc(0);
    let requested: "timeout" | "cancelled" | "output_limit" | "browser_protocol" | "needs_user" | null = null;
    let attentionReason: string | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const stop = (reason: NonNullable<typeof requested>) => {
      if (requested) return;
      requested = reason;
      controller.abort();
      terminateTree(child, "SIGTERM");
      killTimer = setTimeout(() => terminateTree(child, "SIGKILL"), PROTECTED_AUTOMATION_TERM_GRACE_MS);
      killTimer.unref();
    };
    const append = (current: Bytes, chunk: Bytes, maximum: number): Bytes => {
      const remaining = maximum - current.length;
      if (remaining <= 0) return current;
      if (chunk.length > remaining) {
        stop("output_limit");
        return Buffer.concat([current, chunk.subarray(0, remaining)]);
      }
      return Buffer.concat([current, chunk]);
    };
    stdoutStream.on("data", (chunk: Bytes) => { stdout = append(stdout, chunk, MAX_PROTECTED_AUTOMATION_STDOUT_BYTES); });
    stderrStream.on("data", (chunk: Bytes) => { stderr = append(stderr, chunk, MAX_PROTECTED_AUTOMATION_STDERR_BYTES); });

    let browserBuffer: Bytes = Buffer.alloc(0);
    let browserRequests = 0;
    let browserBytes = 0;
    let browserChain = Promise.resolve();
    const browser = request.job.uses_browser_profile ? child.stdio[3] as Duplex : null;
    if (browser && options.browserPort) {
      browser.on("data", (chunk: Bytes) => {
        browserBytes += chunk.length;
        if (browserBytes > MAX_BROWSER_TOTAL_BYTES) { stop("browser_protocol"); return; }
        browserBuffer = Buffer.concat([browserBuffer, chunk]);
        while (!requested && browserBuffer.length >= 4) {
          const length = browserBuffer.readUInt32BE(0);
          if (length > MAX_PROTECTED_AUTOMATION_BROWSER_FRAME_BYTES) { stop("browser_protocol"); return; }
          if (browserBuffer.length < length + 4) return;
          const body = browserBuffer.subarray(4, length + 4);
          browserBuffer = browserBuffer.subarray(length + 4);
          browserRequests += 1;
          if (browserRequests > MAX_BROWSER_REQUESTS) { stop("browser_protocol"); return; }
          browserChain = browserChain.then(async () => {
            let decoded: unknown;
            try { decoded = JSON.parse(body.toString("utf8")); } catch { throw new Error("browser request is malformed"); }
            const message = exactBrowserRequest(decoded);
            if (!isProtectedAutomationBrowserRpcMethod(message.method)) throw new Error("browser request method is not allowed");
            const result = await options.browserPort!.request({
              method: message.method,
              params: message.params,
              allowedHttpsOrigins: request.job.allowed_https_origins,
              signal: controller.signal,
            });
            const frame = responseFrame({ type: "response", id: message.id, result });
            await new Promise<void>((resolveWrite, rejectWrite) => browser.write(frame, (error) => error ? rejectWrite(error) : resolveWrite()));
          }).catch((error) => {
            if (error instanceof ProtectedAutomationNeedsUserError) attentionReason = error.reason;
            stop(error instanceof ProtectedAutomationNeedsUserError ? "needs_user" : "browser_protocol");
          });
        }
      });
      browser.on("error", () => stop("browser_protocol"));
    }

    const timeout = setTimeout(() => stop("timeout"), request.job.timeout_ms);
    const abort = () => stop("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once("error", () => stop("browser_protocol"));
    child.once("close", (exitCode) => {
      const finalize = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
        controller.abort();
        if (browser && browserBuffer.length !== 0 && !requested) requested = "browser_protocol";
        const classification = requested;
        if (classification === "cancelled") {
          resolve({ status: "cancelled", outcomeCode: "cancelled", exitCode, stdout, stderr });
        } else if (classification === "timeout") {
          resolve({ status: "failed", outcomeCode: "timeout", exitCode, stdout, stderr });
        } else if (classification === "output_limit") {
          resolve({ status: "failed", outcomeCode: "output_limit", exitCode, stdout, stderr });
        } else if (classification === "browser_protocol") {
          resolve({ status: "failed", outcomeCode: "browser_protocol_error", exitCode, stdout, stderr });
        } else if (classification === "needs_user") {
          resolve({ status: "needs_user", outcomeCode: `needs_user:${attentionReason ?? "human_review_required"}`, exitCode, stdout, stderr });
        } else if (exitCode === 0) {
          resolve({ status: "completed", outcomeCode: "completed", exitCode, stdout, stderr });
        } else {
          resolve({ status: "failed", outcomeCode: "nonzero_exit", exitCode, stdout, stderr });
        }
      };
      void browserChain.finally(finalize).catch(() => { stop("browser_protocol"); finalize(); });
    });
  });
}

/** Shell-free direct-Bubblewrap deterministic Node execution. */
export async function runProtectedAutomation(
  request: ProtectedAutomationRunnerJob,
  options: ProtectedAutomationRunnerOptions,
): Promise<ProtectedAutomationRunnerResult> {
  if (process.platform !== "linux") {
    return { status: "failed", outcomeCode: "platform_unavailable", exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
  if (request.job.uses_browser_profile && !options.browserPort) {
    return { status: "failed", outcomeCode: "browser_unavailable", exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
  try {
    const snapshot = resolveProtectedAutomationSnapshotSourceForExecution({
      projectId: request.job.project_id,
      agentProfileId: request.job.agent_profile_id,
      jobId: request.job.id,
      revision: request.job.source_revision,
      expectedManifestSha256: request.job.source_manifest_sha256,
    });
    if (snapshot.metadata.entrypoint !== request.job.entrypoint) throw new Error("snapshot entrypoint mismatch");
    const projectCanonical = await fs.realpath(request.projectRoot);
    if (projectCanonical !== request.projectRoot) throw new Error("job root is not canonical");
    await Promise.all([
      validateWritableRoot(request.projectRoot),
      validateWritableRoot(options.runRoot),
      validateWritableRoot(options.stateRoot),
    ]);
    const closure = await verifiedRuntimeClosure();
    options.assertAuthorized();
    const spawnSnapshot = resolveProtectedAutomationSnapshotSourceForExecution({
      projectId: request.job.project_id,
      agentProfileId: request.job.agent_profile_id,
      jobId: request.job.id,
      revision: request.job.source_revision,
      expectedManifestSha256: request.job.source_manifest_sha256,
    });
    if (spawnSnapshot.sourceRoot !== snapshot.sourceRoot || spawnSnapshot.metadata.entrypoint !== request.job.entrypoint) {
      throw new Error("snapshot changed before spawn");
    }
    options.assertAuthorized();
    return await runChild(request, options, closure.bwrapSource, bubblewrapArgs(closure, spawnSnapshot.sourceRoot, request, options));
  } catch {
    return { status: "failed", outcomeCode: "runner_preflight_failed", exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}
