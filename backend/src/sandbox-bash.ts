import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {
  createBashToolDefinition,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { buildRestrictedSandboxEnv } from "./child-env.js";
import { getSessionById } from "./sessions.js";
import { getAgentProfile } from "./agent-profiles.js";
import { getWorkspaceCapabilityStoreProjectionPath } from "./db.js";
import { isSessionCapabilityEligible, resolveWorkspaceCapability } from "./workspace-capabilities.js";
import { getRegisteredMemoryRoots } from "./agent-runtime.js";
import { listProjects } from "./projects.js";
import { authorizeProjectAction, pathIsWithin, projectAllowsAgentProfile } from "./policy.js";
import {
  getProtectedArtifactReadRoots,
  getProtectedArtifactWriteRoots,
  getRestrictedAgentArtifactRoots,
  getSessionAttachmentRoot,
} from "./protected-artifacts.js";
import type { SandboxExecRequest, SandboxNetworkMode } from "./sandbox-exec-protocol.js";
import type { HostExecutionAuthorizationDecision, HostExecutionMode } from "./host-execution.js";
import { isLegacyWrenStandardRuntime } from "./legacy-wren.js";
import type { WayangBashMode as LegacyWayangBashMode } from "./wren-host-bash.js";

export interface BashSandboxAvailability {
  available: boolean;
  reason?: string;
}

export interface BashSandboxPolicy {
  config: SandboxRuntimeConfig;
  networkMode: SandboxNetworkMode;
  deniedReadRoots: string[];
  deniedWriteRoots: string[];
}

/** Missing denyWrite targets temporarily created by active SRT helpers. */
const activeSyntheticDenyWriteMounts = new Map<string, number>();

function activeSyntheticMount(target: string): boolean {
  return activeSyntheticDenyWriteMounts.has(path.resolve(target))
    || activeSyntheticDenyWriteMounts.has(canonicalExistingOrResolved(target));
}

function registerSyntheticDenyWriteMounts(policy: BashSandboxPolicy): () => void {
  const candidates = policy.deniedWriteRoots.filter((root) => (
    !fs.existsSync(root)
    && policy.config.filesystem.allowWrite.some((allowedRoot) => pathIsWithin(root, allowedRoot))
  )).map((root) => path.resolve(root));
  for (const root of candidates) {
    activeSyntheticDenyWriteMounts.set(root, (activeSyntheticDenyWriteMounts.get(root) ?? 0) + 1);
  }
  return () => {
    for (const root of candidates) {
      const remaining = (activeSyntheticDenyWriteMounts.get(root) ?? 1) - 1;
      if (remaining > 0) activeSyntheticDenyWriteMounts.set(root, remaining);
      else activeSyntheticDenyWriteMounts.delete(root);
    }
  };
}

/** Host eligibility is independent of sandbox availability; every ineligible
 * runtime keeps the existing sandbox-or-unavailable fail-closed behavior.
 *
 * A legacy boolean is accepted only to keep an incremental build type-safe. It
 * can never select host mode because that would discard the exact capability
 * witness carried by an authorization decision.
 */
export function selectWayangBashMode(
  hostAuthorization: HostExecutionAuthorizationDecision,
  sandboxAvailability?: BashSandboxAvailability,
): HostExecutionMode;
/** @deprecated A boolean never selects host mode; pass the complete decision. */
export function selectWayangBashMode(
  hostAuthorization: boolean,
  sandboxAvailability?: BashSandboxAvailability,
): LegacyWayangBashMode;
export function selectWayangBashMode(
  hostAuthorization: HostExecutionAuthorizationDecision | boolean,
  sandboxAvailability: BashSandboxAvailability = getBashSandboxAvailability(),
): HostExecutionMode {
  if (typeof hostAuthorization !== "boolean" && hostAuthorization.allowed === true) return "host";
  return sandboxAvailability.available ? "sandboxed" : "unavailable";
}

function canonicalExistingOrResolved(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function uniqueCanonicalPaths(paths: Iterable<string>): string[] {
  return [...new Set([...paths].map(canonicalExistingOrResolved))];
}

/** Bubblewrap cannot safely install overlapping deny mounts; retain outermost roots. */
function outermostCanonicalPaths(paths: Iterable<string>): string[] {
  const canonical = uniqueCanonicalPaths(paths);
  return canonical.filter((root) => !canonical.some((other) => other !== root && pathIsWithin(root, other)));
}

export function getBashSandboxAvailability(): BashSandboxAvailability {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return { available: false, reason: `OS sandboxing is unsupported on ${process.platform}` };
  }
  if (!SandboxManager.isSupportedPlatform()) {
    return { available: false, reason: "OS sandboxing is unsupported on this platform variant" };
  }
  const dependencies = SandboxManager.checkDependencies();
  if (dependencies.errors.length > 0) {
    return { available: false, reason: dependencies.errors.join(", ") };
  }
  if (process.platform === "linux" && dependencies.warnings.some((warning) => /seccomp|unix socket/i.test(warning))) {
    return { available: false, reason: "Unix control-socket blocking is unavailable" };
  }
  return { available: true };
}

/** Build a fresh, live policy for every execution; no policy state is cached. */
export function buildBashSandboxPolicy(
  sessionId: string,
  networkMode: SandboxNetworkMode = process.platform === "linux" ? "host" : "allow_all_proxy",
): BashSandboxPolicy {
  const session = getSessionById(sessionId);
  if (!session) throw new Error("Wayang session no longer exists");
  const profile = session.agent_profile_id ? getAgentProfile(session.agent_profile_id) : undefined;
  if (!profile) throw new Error("Session agent profile was not found");

  const sourceAuthorization = authorizeProjectAction({
    cwd: session.cwd,
    actor: "interactive",
    agentProfileId: profile.id,
  });
  if (!sourceAuthorization.allowed) throw new Error(sourceAuthorization.reason ?? "Session is no longer authorized");

  const projects = listProjects();
  const legacyWrenStandard = sourceAuthorization.project
    ? isLegacyWrenStandardRuntime({ session, profile, project: sourceAuthorization.project })
    : false;
  const deniedRead = new Set<string>();
  const deniedWrite = new Set<string>();
  const sourceProtected = sourceAuthorization.project?.access_policy.privacy_mode === "protected";
  for (const project of projects) {
    const otherProtectedProject = project.access_policy.privacy_mode === "protected"
      && project.id !== sourceAuthorization.project?.id;
    const excludedByAllowlist = !projectAllowsAgentProfile(project, profile.id);
    if (otherProtectedProject || (excludedByAllowlist && !sourceProtected)) deniedRead.add(project.cwd);
    if (otherProtectedProject || excludedByAllowlist) deniedWrite.add(project.cwd);
  }

  for (const root of getProtectedArtifactReadRoots()) deniedRead.add(root);
  for (const root of getProtectedArtifactWriteRoots()) deniedWrite.add(root);

  // resource_mode and provider/model are profile/runtime preferences, not
  // filesystem authority. Only live privacy/RBAC-derived pair authority opens global Pi roots.
  const standardResources = isSessionCapabilityEligible(session)
    && session.pending_agent_switch === null
    && sourceAuthorization.project
    ? resolveWorkspaceCapability({
        capability_id: "wayang.standard-resources.v1",
        project_id: sourceAuthorization.project.id,
        agent_profile_id: profile.id,
      })
    : null;
  const standardResourcesAuthorized = standardResources?.authorized === true || legacyWrenStandard;
  if (!standardResourcesAuthorized) {
    for (const root of getRestrictedAgentArtifactRoots()) {
      deniedRead.add(root);
      deniedWrite.add(root);
    }
  }

  const ownAttachmentRoot = getSessionAttachmentRoot(session.id);
  const allowedRead = fs.existsSync(ownAttachmentRoot) ? [ownAttachmentRoot] : [];
  if (standardResourcesAuthorized && sourceAuthorization.project) {
    const projection = getWorkspaceCapabilityStoreProjectionPath({
      capability_id: "wayang.standard-resources.v1",
      project_id: sourceAuthorization.project.id,
      agent_profile_id: profile.id,
    });
    try {
      const stat = fs.lstatSync(projection);
      const uid = process.getuid?.();
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
        && (uid === undefined || stat.uid === uid) && (stat.mode & 0o7777) === 0o600
        && fs.realpathSync.native(projection) === projection) {
        allowedRead.push(projection);
      }
    } catch { /* missing or unsafe projection stays unavailable */ }
  }

  const memoryRoots = getRegisteredMemoryRoots();
  if (profile.memory_access === "none") {
    for (const root of memoryRoots) deniedRead.add(root);
  }
  if (profile.memory_access !== "read_write") {
    for (const root of memoryRoots) deniedWrite.add(root);
  }

  // Restricted runtimes may not replace project-local Pi extension/config code
  // and then ask the host process to reload it outside the sandbox. Exact Wren
  // intentionally retains its pre-policy ability to maintain Pi projects.
  if (!legacyWrenStandard) deniedWrite.add(path.join(session.cwd, ".pi"));

  // Snapshot only currently existing genuine read-deny targets. SRT evaluates
  // this policy in a forked helper and temporarily creates missing denyWrite
  // mountpoints on the host. A concurrent helper must not mistake one for a real
  // file: binding it races cleanup and can make Bubblewrap fail before startup.
  // Missing targets cannot be read, and every denyWrite remains present so this
  // sandbox cannot create them itself. Concurrent unrelated same-UID mutation
  // remains outside this cooperative boundary, as documented for the policy.
  const deniedReadRoots = outermostCanonicalPaths(
    [...deniedRead].filter((root) => fs.existsSync(root) && !activeSyntheticMount(root)),
  );
  const deniedWriteRoots = outermostCanonicalPaths(deniedWrite);
  const canonicalCwd = canonicalExistingOrResolved(session.cwd);
  const overlappingDeny = deniedWriteRoots.find((root) => pathIsWithin(canonicalCwd, root));
  if (overlappingDeny) {
    throw new Error("Bash is unavailable because the project overlaps a write-denied policy root");
  }
  return {
    networkMode,
    deniedReadRoots,
    deniedWriteRoots,
    config: {
      network: {
        // SRT's schema requires a network block at initialization. The helper
        // removes allowedDomains through SRT's live update API before wrapping
        // host-mode commands, which preserves the filesystem sandbox without
        // creating a network namespace or injecting proxy settings. Proxy and
        // deny modes remain only for live-upgrade and focused regression use.
        allowedDomains: [],
        deniedDomains: networkMode === "deny_all" ? ["*"] : [],
        strictAllowlist: networkMode === "deny_all",
        allowUnixSockets: [],
        allowAllUnixSockets: legacyWrenStandard,
        allowLocalBinding: false,
      },
      filesystem: {
        denyRead: deniedReadRoots,
        // sandbox-runtime explicitly supports deny-then-allow nested read
        // overrides. Children still receive no transcript/attachment access.
        allowRead: allowedRead,
        // Upstream sandbox-runtime treats writes as allow-only. Permit the
        // current project plus the host's shared temporary directory. Protected
        // host backing remains hidden and unmodifiable: on Linux, a directory
        // that is both read-denied and beneath writable /tmp appears as an empty
        // disposable tmpfs, so writes there never reach the protected host path.
        allowWrite: legacyWrenStandard
          ? [path.parse(canonicalCwd).root]
          : sourceAuthorization.project?.access_policy.privacy_mode === "protected"
            ? [canonicalCwd]
            : uniqueCanonicalPaths([canonicalCwd, os.tmpdir()]),
        denyWrite: deniedWriteRoots,
        allowGitConfig: legacyWrenStandard,
      },
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
    },
  };
}

function helperModulePath(): string {
  const current = fileURLToPath(import.meta.url);
  return path.join(path.dirname(current), current.endsWith(".ts") ? "sandbox-exec-helper.ts" : "sandbox-exec-helper.js");
}

function killProcessGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
}

export function createPolicySandboxedBashOperations(
  sessionId: string,
  options: { networkMode?: SandboxNetworkMode } = {},
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      const availability = getBashSandboxAvailability();
      if (!availability.available) throw new Error(`Wayang bash sandbox unavailable: ${availability.reason ?? "unknown reason"}`);
      const policy = buildBashSandboxPolicy(sessionId, options.networkMode);
      const releaseSyntheticMounts = registerSyntheticDenyWriteMounts(policy);
      let child: ChildProcess;
      try {
        child = fork(helperModulePath(), [], {
          cwd,
          detached: process.platform !== "win32",
          env: buildRestrictedSandboxEnv(env ?? process.env),
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
      } catch (error) {
        releaseSyntheticMounts();
        throw error;
      }
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      const request: SandboxExecRequest = { command, cwd, config: policy.config, networkMode: policy.networkMode };
      try {
        child.send(request);
        return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
          let settled = false;
          let timedOut = false;
          let timer: NodeJS.Timeout | undefined;
          const finish = (operation: () => void) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            operation();
          };
          const onAbort = () => {
            killProcessGroup(child);
            finish(() => reject(new Error("aborted")));
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });
          if (timeout !== undefined && timeout > 0) {
            timer = setTimeout(() => {
              timedOut = true;
              killProcessGroup(child);
            }, timeout * 1000);
          }
          child.once("error", (error) => finish(() => reject(error)));
          child.once("close", (code) => {
            if (timedOut) finish(() => reject(new Error(`timeout:${timeout}`)));
            else finish(() => resolve({ exitCode: code }));
          });
        });
      } finally {
        releaseSyntheticMounts();
      }
    },
  };
}

export function createPolicySandboxedBashToolDefinition(
  cwd: string,
  sessionId: string,
  mode: "sandboxed" | "sandboxed-wren" = "sandboxed",
): any {
  const tool = createBashToolDefinition(cwd, { operations: createPolicySandboxedBashOperations(sessionId) });
  if (mode === "sandboxed-wren") {
    return {
      ...tool,
      label: "bash (Wren host workspace)",
      description: `${tool.description} Exact seeded Wren may read and write ordinary host paths and use visible Unix IPC services. Every registered Protected project and protected control-plane artifact remains masked. Commands run as the Wayang OS user; this is broad same-user authority, not containment.`,
    };
  }
  const networkDescription = process.platform === "linux"
    ? "the host TCP/UDP network namespace is retained, including loopback/LAN/VPN access and local listeners"
    : "outbound TCP destinations use the sandbox HTTP/SOCKS proxies";
  return {
    ...tool,
    label: "bash (Wayang sandboxed)",
    description: `${tool.description} Wayang runs each command in an independent OS sandbox: writes are limited to the current project and shared host temporary storage, protected/control-plane roots are masked even beneath temporary storage, Unix sockets are blocked, and ${networkDescription}.`,
  };
}
