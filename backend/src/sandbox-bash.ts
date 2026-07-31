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
import { stripInternalCapabilityEnv } from "./child-env.js";
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
import { WREN_AGENT_PROFILE_ID, type AgentProfileRow, type ProjectRow } from "./workspace-types.js";
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

export function allowsLegacyWrenUnixSockets(input: {
  session: {
    agent_profile_id?: string | null;
    pending_agent_switch: unknown;
    legacy_private_session_quarantine?: boolean;
    legacy_capability_ineligible?: boolean;
    scheduled_job_id: string | null;
    scheduled_run_id: string | null;
  };
  profile: Pick<AgentProfileRow, "id" | "builtin_kind" | "enabled">;
  project: Pick<ProjectRow, "access_policy">;
}): boolean {
  const { session, profile, project } = input;
  return profile.id === WREN_AGENT_PROFILE_ID
    && profile.builtin_kind === "wren"
    && profile.enabled === true
    && session.agent_profile_id === profile.id
    && session.pending_agent_switch === null
    && session.legacy_private_session_quarantine === false
    && session.legacy_capability_ineligible === false
    && session.scheduled_job_id === null
    && session.scheduled_run_id === null
    && project.access_policy.privacy_mode === "standard";
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
  networkMode: SandboxNetworkMode = "allow_all_proxy",
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
  const legacyWrenUnixSockets = sourceAuthorization.project
    ? allowsLegacyWrenUnixSockets({ session, profile, project: sourceAuthorization.project })
    : false;
  const deniedRead = new Set<string>();
  const deniedWrite = new Set<string>();
  for (const project of projects) {
    if (!projectAllowsAgentProfile(project, profile.id)) {
      deniedRead.add(project.cwd);
      deniedWrite.add(project.cwd);
    }
  }

  for (const root of getProtectedArtifactReadRoots()) deniedRead.add(root);
  for (const root of getProtectedArtifactWriteRoots()) deniedWrite.add(root);

  // resource_mode and provider/model are profile/runtime preferences, not
  // filesystem authority. Only a live pair association opens global Pi roots.
  const standardResources = isSessionCapabilityEligible(session)
    && session.pending_agent_switch === null
    && sourceAuthorization.project
    ? resolveWorkspaceCapability({
        capability_id: "wayang.standard-resources.v1",
        project_id: sourceAuthorization.project.id,
        agent_profile_id: profile.id,
      })
    : null;
  const standardResourcesAuthorized = standardResources?.authorized === true;
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

  // A bash command may not replace project-local Pi extension/config code and
  // then ask the host process to reload it outside the sandbox.
  deniedWrite.add(path.join(session.cwd, ".pi"));

  const deniedReadRoots = outermostCanonicalPaths(deniedRead);
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
        // SRT has no supported unrestricted-domain wildcard. Production's
        // empty non-strict list delegates each destination to the helper's
        // explicit allow-all callback. deny_all is retained only for
        // fail-closed live-upgrade compatibility.
        allowedDomains: [],
        deniedDomains: networkMode === "allow_all_proxy" ? [] : ["*"],
        strictAllowlist: networkMode !== "allow_all_proxy",
        allowUnixSockets: [],
        // Preserve the seeded legacy Wren profile's interactive Standard-project
        // IPC compatibility without restoring unsandboxed host execution. The
        // exact stable profile ID plus non-user-settable historical kind prevents
        // a rename, clone, or ordinary profile CRUD operation from acquiring it.
        allowAllUnixSockets: legacyWrenUnixSockets,
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
        allowWrite: uniqueCanonicalPaths([canonicalCwd, os.tmpdir()]),
        denyWrite: deniedWriteRoots,
        allowGitConfig: false,
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
      const child = fork(helperModulePath(), [], {
        cwd,
        detached: process.platform !== "win32",
        env: stripInternalCapabilityEnv(env ?? process.env),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      const request: SandboxExecRequest = { command, cwd, config: policy.config, networkMode: policy.networkMode };
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
    },
  };
}

export function createPolicySandboxedBashToolDefinition(
  cwd: string,
  sessionId: string,
  mode: "sandboxed" | "sandboxed-unix" = "sandboxed",
): any {
  const tool = createBashToolDefinition(cwd, { operations: createPolicySandboxedBashOperations(sessionId) });
  const socketDescription = mode === "sandboxed-unix"
    ? "The seeded legacy Wren profile may create and connect to Unix sockets visible inside the sandbox; those IPC services can carry same-user authority."
    : "Unix sockets are blocked.";
  return {
    ...tool,
    label: mode === "sandboxed-unix" ? "bash (Wayang sandboxed + Unix IPC)" : "bash (Wayang sandboxed)",
    description: `${tool.description} Wayang runs each command in an independent OS sandbox: writes are limited to the current project and shared host temporary storage, and protected/control-plane roots are masked even beneath temporary storage. ${socketDescription} Outbound TCP destinations are allowed through HTTP/SOCKS proxies.`,
  };
}
