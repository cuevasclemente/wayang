import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createBashToolDefinition,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { stripInternalCapabilityEnv } from "./child-env.js";
import type { AgentProfileRow, ProjectRow } from "./workspace-types.js";
import type { WorkspaceCapabilityResolution } from "./workspace-capabilities.js";
import type { SessionRow } from "./sessions.js";

export const HOST_EXECUTION_CAPABILITY_ID = "wayang.host-execution.v1" as const;

export type HostExecutionMode = "host" | "sandboxed" | "masked-host-workspace" | "unavailable";

/**
 * Backend-issued proof that the closed workspace capability resolver found the
 * exact active project/profile association. Host execution consumes this proof;
 * provider/model, names, built-in kinds, resource preferences, and configuration
 * flags are not authority inputs here.
 */
export interface ExactHostExecutionCapabilityWitness {
  readonly capabilityId: typeof HOST_EXECUTION_CAPABILITY_ID;
  readonly projectId: string;
  readonly agentProfileId: string;
  readonly associationRevision: number;
}

/** Convert only a successful current closed-registry resolution into the exact
 * host-layer witness. Call resolveWorkspaceCapability again for every execute-
 * time authorization; never cache this witness across an operation. */
export function hostExecutionWitnessFromResolution(
  resolution: WorkspaceCapabilityResolution,
): ExactHostExecutionCapabilityWitness | null {
  if (!resolution.authorized || resolution.capability.id !== HOST_EXECUTION_CAPABILITY_ID) return null;
  const { association, project, profile } = resolution;
  if (
    association.active !== true
    || association.capability_id !== HOST_EXECUTION_CAPABILITY_ID
    || association.project_id !== project.id
    || association.agent_profile_id !== profile.id
  ) return null;
  return Object.freeze({
    capabilityId: HOST_EXECUTION_CAPABILITY_ID,
    projectId: project.id,
    agentProfileId: profile.id,
    associationRevision: association.revision,
  });
}

export interface HostExecutionAuthorizationFacts {
  capabilityWitness: ExactHostExecutionCapabilityWitness | null | undefined;
  row: SessionRow | null | undefined;
  profile: AgentProfileRow | null | undefined;
  project: ProjectRow | null | undefined;
  requestedCwd: string;
  authorization: {
    allowed: boolean;
    projectId?: string;
    agentProfileId?: string;
  };
  isInteractive: boolean;
  isSubagent: boolean;
  execution?: {
    selectedBashMode: HostExecutionMode;
    /** Creation-time binding; a revoke/regrant or newer association revision
     * can never authorize an already-created runtime. */
    expectedCapabilityWitness: ExactHostExecutionCapabilityWitness;
    expectedRuntimeGeneration: string;
    activeRuntimeGeneration?: string;
    expectedProcessBootNonce: string;
    activeProcessBootNonce?: string;
    activeHandleSessionId?: string;
    activeHandleAgentProfileId?: string;
    activeHandleCwd?: string;
    spawnCwd?: string;
    trustedToolDefinition: boolean;
    trustedToolExecutable: boolean;
  };
}

export type HostExecutionAuthorizationDecision =
  | {
      allowed: true;
      witness: ExactHostExecutionCapabilityWitness;
    }
  | {
      allowed: false;
      reason: string;
    };

function deny(reason: string): HostExecutionAuthorizationDecision {
  return { allowed: false, reason };
}

function canonicalExisting(target: string): string | null {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

function isNonemptyExactString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.normalize("NFC") === value;
}

function isPositiveSafeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function witnessIsWellFormed(
  witness: ExactHostExecutionCapabilityWitness | null | undefined,
): witness is ExactHostExecutionCapabilityWitness {
  return Boolean(
    witness
    && witness.capabilityId === HOST_EXECUTION_CAPABILITY_ID
    && isNonemptyExactString(witness.projectId)
    && isNonemptyExactString(witness.agentProfileId)
    && isPositiveSafeRevision(witness.associationRevision)
  );
}

function witnessesAreExact(
  left: ExactHostExecutionCapabilityWitness,
  right: ExactHostExecutionCapabilityWitness,
): boolean {
  return left.capabilityId === right.capabilityId
    && left.projectId === right.projectId
    && left.agentProfileId === right.agentProfileId
    && left.associationRevision === right.associationRevision;
}

/**
 * One strict resolver serves construction and execute time. The workspace
 * capability resolver must inject a current exact witness. Every ambiguity is
 * an ordinary denial and never an instruction to use unsandboxed execution.
 */
export function resolveHostExecutionAuthorization(
  facts: HostExecutionAuthorizationFacts,
): HostExecutionAuthorizationDecision {
  const witness = facts.capabilityWitness;
  if (!witnessIsWellFormed(witness)) return deny("An exact active host-execution capability witness is required");
  if (facts.isInteractive !== true) return deny("Host execution requires an interactive runtime");
  if (facts.isSubagent !== false) return deny("Subagent runtime identity is missing or delegated");

  const { row, profile, project } = facts;
  if (!row || !profile || !project || typeof row.id !== "string" || !row.id) {
    return deny("Runtime identity is incomplete");
  }
  if (row.pending_agent_switch !== null) return deny("An agent switch is pending or ambiguous");
  if (
    row.legacy_private_session_quarantine !== false
    || row.legacy_capability_ineligible !== false
  ) {
    return deny("The durable source session lacks exact capability-eligibility markers");
  }
  if (row.agent_profile_id !== profile.id) return deny("Durable source profile does not match the resolved profile");
  if (profile.enabled !== true) return deny("The resolved profile is disabled");
  if (project.access_policy.privacy_mode !== "standard") return deny("Protected projects cannot receive host execution");
  const allowedProfileIds = project.access_policy.allowed_agent_profile_ids;
  if (allowedProfileIds !== null && !allowedProfileIds.includes(profile.id)) {
    return deny("The project no longer allows the resolved profile");
  }
  if (row.scheduled_job_id !== null || row.scheduled_run_id !== null) {
    return deny("Scheduled runtime identity is present or ambiguous");
  }
  if (facts.authorization.allowed !== true) return deny("Current project authorization failed");
  if (facts.authorization.projectId !== project.id || facts.authorization.agentProfileId !== profile.id) {
    return deny("Project authorization identity is ambiguous");
  }

  if (witness.projectId !== project.id || witness.agentProfileId !== profile.id) {
    return deny("The capability witness does not match the exact durable runtime binding");
  }

  const canonicalRequested = canonicalExisting(facts.requestedCwd);
  const canonicalRow = canonicalExisting(row.cwd);
  const canonicalProject = canonicalExisting(project.cwd);
  if (!canonicalRequested || !canonicalRow || !canonicalProject) return deny("Runtime cwd could not be canonicalized");
  if (canonicalRequested !== canonicalRow || canonicalRequested !== canonicalProject) {
    return deny("Runtime cwd does not match the authorized project");
  }

  const execution = facts.execution;
  if (!execution) return { allowed: true, witness };
  if (
    !witnessIsWellFormed(execution.expectedCapabilityWitness)
    || !witnessesAreExact(execution.expectedCapabilityWitness, witness)
  ) {
    return deny("Host-execution association differs from the creation-time binding");
  }
  if (execution.selectedBashMode !== "host") return deny("Runtime was not created with host execution");
  if (
    !execution.expectedRuntimeGeneration
    || !execution.activeRuntimeGeneration
    || execution.activeRuntimeGeneration !== execution.expectedRuntimeGeneration
  ) {
    return deny("Host-execution runtime generation is stale");
  }
  if (
    !execution.expectedProcessBootNonce
    || !execution.activeProcessBootNonce
    || execution.activeProcessBootNonce !== execution.expectedProcessBootNonce
  ) {
    return deny("Host-execution process boot identity is stale");
  }
  if (execution.activeHandleSessionId !== row.id) return deny("Live session handle does not match the durable source");
  if (execution.activeHandleAgentProfileId !== profile.id) return deny("Live session profile has drifted");
  const canonicalHandleCwd = execution.activeHandleCwd ? canonicalExisting(execution.activeHandleCwd) : null;
  const canonicalSpawnCwd = execution.spawnCwd ? canonicalExisting(execution.spawnCwd) : null;
  if (!canonicalHandleCwd || canonicalHandleCwd !== canonicalRequested) return deny("Live session cwd has drifted");
  if (!canonicalSpawnCwd || canonicalSpawnCwd !== canonicalRequested) return deny("Host-execution spawn cwd has drifted");
  if (!execution.trustedToolDefinition || !execution.trustedToolExecutable) {
    return deny("Host-execution tool identity is no longer trusted");
  }
  return { allowed: true, witness };
}

interface HostEnvironmentFs {
  lstatSync: typeof fs.lstatSync;
}

export interface HostEnvironmentOptions {
  uid?: number;
  runtimeRoot?: string;
  fs?: HostEnvironmentFs;
}

function hasNoSymlinkTraversal(target: string, fsApi: HostEnvironmentFs): boolean {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let stat: fs.Stats;
    try {
      stat = fsApi.lstatSync(cursor) as fs.Stats;
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) return false;
  }
  return true;
}

/**
 * Strip Wayang-internal names without inspecting their values, then replace any
 * inherited user-bus routing only when the expected uid-owned runtime objects
 * are safe to advertise to the child.
 */
export function buildHostChildEnvironment(
  source: NodeJS.ProcessEnv,
  options: HostEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const env = stripInternalCapabilityEnv(source);
  delete env.XDG_RUNTIME_DIR;
  delete env.DBUS_SESSION_BUS_ADDRESS;

  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) return env;
  const fsApi = options.fs ?? fs;
  const runtimeDir = path.join(options.runtimeRoot ?? "/run/user", String(uid));
  const busPath = path.join(runtimeDir, "bus");
  if (!hasNoSymlinkTraversal(runtimeDir, fsApi) || !hasNoSymlinkTraversal(busPath, fsApi)) return env;

  try {
    const runtimeStat = fsApi.lstatSync(runtimeDir) as fs.Stats;
    const busStat = fsApi.lstatSync(busPath) as fs.Stats;
    if (!runtimeStat.isDirectory() || runtimeStat.uid !== uid) return env;
    if (!busStat.isSocket() || busStat.uid !== uid) return env;
  } catch {
    return env;
  }

  env.XDG_RUNTIME_DIR = runtimeDir;
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busPath}`;
  return env;
}

export interface HostBashRegistryGuard {
  readonly revoked: boolean;
  checkCurrent(): boolean;
}

const EXECUTABLE_DEFINITION_KEYS = [
  "name",
  "label",
  "description",
  "parameters",
  "prepareArguments",
  "executionMode",
] as const;

/**
 * Pi keeps the backend ToolDefinition verbatim but adapts it into a distinct
 * AgentTool executable. Accept only that exact definition/registry/active-tool
 * relationship; callers then pin the returned executable for the runtime.
 */
export function resolveHostBashExecutable(session: any, definition: any): any | undefined {
  const definitions = session?._toolDefinitions;
  const registry = session?._toolRegistry;
  const activeTools = session?.agent?.state?.tools;
  if (!(definitions instanceof Map) || definitions.get("bash")?.definition !== definition) return undefined;
  if (!(registry instanceof Map) || !Array.isArray(activeTools)) return undefined;

  const executable = registry.get("bash");
  if (!executable || typeof executable.execute !== "function" || !activeTools.includes(executable)) return undefined;
  for (const key of EXECUTABLE_DEFINITION_KEYS) {
    if (executable[key] !== definition[key]) return undefined;
  }
  return executable;
}

export function installHostBashRegistryGuard(options: {
  session: any;
  definition: any;
  executable: any;
  execute: unknown;
  onRevoke: (reason: string) => void;
}): HostBashRegistryGuard {
  const { session, definition, executable, execute } = options;
  const initialDefinitionRegistry = session._toolDefinitions;
  const initialToolRegistry = session._toolRegistry;
  const pinnedDefinitionValues = new Map(EXECUTABLE_DEFINITION_KEYS.map((key) => [key, definition?.[key]]));
  let revoked = false;

  const revoke = (reason: string): false => {
    if (!revoked) {
      revoked = true;
      options.onRevoke(reason);
    }
    return false;
  };
  const identityIsCurrent = (): boolean => (
    !revoked
    && session._toolDefinitions === initialDefinitionRegistry
    && session._toolRegistry === initialToolRegistry
    && initialDefinitionRegistry instanceof Map
    && initialDefinitionRegistry.get("bash")?.definition === definition
    && initialToolRegistry instanceof Map
    && initialToolRegistry.get("bash") === executable
    && executable?.execute === execute
    && EXECUTABLE_DEFINITION_KEYS.every((key) => (
      definition?.[key] === pinnedDefinitionValues.get(key)
      && executable?.[key] === pinnedDefinitionValues.get(key)
    ))
    && Array.isArray(session.agent?.state?.tools)
    && session.agent.state.tools.includes(executable)
  );
  const checkCurrent = (): boolean => identityIsCurrent()
    || revoke("Pi bash definition or registry identity changed; a fresh runtime is required");

  if (typeof session._refreshToolRegistry === "function" && !session.__wayangHostPermanentRevocationWrapped) {
    const previousRefresh = session._refreshToolRegistry.bind(session);
    session._refreshToolRegistry = (...args: unknown[]) => {
      if (!checkCurrent()) return previousRefresh(...args);
      let result: any;
      try {
        result = previousRefresh(...args);
      } catch (error) {
        checkCurrent();
        throw error;
      }
      if (result && typeof result.finally === "function") {
        return result.finally(() => { checkCurrent(); });
      }
      checkCurrent();
      return result;
    };
    session.__wayangHostPermanentRevocationWrapped = true;
  }
  if (typeof session.setActiveToolsByName === "function" && !session.__wayangHostPermanentSetActiveWrapped) {
    const previousSetActive = session.setActiveToolsByName.bind(session);
    session.setActiveToolsByName = (names: string[]) => {
      try {
        return previousSetActive(names);
      } finally {
        checkCurrent();
      }
    };
    session.__wayangHostPermanentSetActiveWrapped = true;
  }

  return {
    get revoked() { return revoked; },
    checkCurrent,
  };
}

export interface HostExecutionRequest {
  command: string;
  cwd: string;
}

export interface CreateHostBashOptions {
  authorizeExecution: (request: HostExecutionRequest) => HostExecutionAuthorizationDecision;
  operations?: BashOperations;
  environmentOptions?: HostEnvironmentOptions;
}

export interface RevocableHostBashOperations extends BashOperations {
  /** Permanently deny new executions and abort every execution already in flight. */
  revoke(): Promise<void>;
}

const HOST_PROCESS_TERM_GRACE_MS = 250;
const HOST_PROCESS_EXIT_GRACE_MS = 100;

function hostShell(): string {
  if (process.platform === "win32") {
    throw new Error("Wayang host execution is supported only on Linux and macOS");
  }
  if (fs.existsSync("/bin/bash")) return "/bin/bash";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "bash");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep searching */ }
  }
  return "/bin/sh";
}

function signalHostProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* process already exited */ }
  }
}

function waitForHostChild(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    const cleanup = () => {
      if (exitTimer) clearTimeout(exitTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
    };
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      operation();
    };
    const armExitTimer = () => {
      if (exitTimer) clearTimeout(exitTimer);
      exitTimer = setTimeout(() => finish(() => resolve(exitCode)), HOST_PROCESS_EXIT_GRACE_MS);
    };
    const maybeFinish = () => {
      if (exited && stdoutEnded && stderrEnded) finish(() => resolve(exitCode));
    };
    const onData = () => { if (exited) armExitTimer(); };
    const onStdoutEnd = () => { stdoutEnded = true; maybeFinish(); };
    const onStderrEnd = () => { stderrEnded = true; maybeFinish(); };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinish();
      if (!settled) armExitTimer();
    };
    const onClose = (code: number | null) => finish(() => resolve(code));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

/** Local host backend with an explicit process-group TERM/KILL cancellation
 * contract. The KILL escalation is awaited even when the leader exits first,
 * so a TERM-ignoring descendant cannot perform a delayed mutation. */
function createBoundedLocalHostBashOperations(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (signal?.aborted) throw new Error("aborted");
      let timeoutMs: number | undefined;
      if (timeout !== undefined) {
        timeoutMs = timeout * 1000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
          throw new Error("Invalid timeout: must be a finite positive number within the timer range");
        }
      }
      const child = spawn(hostShell(), ["-c", command], {
        cwd,
        detached: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      let termination: Promise<void> | undefined;
      let timedOut = false;
      let timeoutTimer: NodeJS.Timeout | undefined;
      const terminate = (): Promise<void> => {
        if (termination) return termination;
        // Freeze the group before requesting termination so a TERM handler or
        // descendant cannot mutate host state during the bounded KILL grace.
        signalHostProcessGroup(child, "SIGSTOP");
        signalHostProcessGroup(child, "SIGTERM");
        termination = new Promise((resolve) => {
          setTimeout(() => {
            signalHostProcessGroup(child, "SIGKILL");
            resolve();
          }, HOST_PROCESS_TERM_GRACE_MS);
        });
        return termination;
      };
      const onAbort = () => { void terminate(); };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          void terminate();
        }, timeoutMs);
      }

      try {
        const exitCode = await waitForHostChild(child);
        if (termination) await termination;
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode };
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export function createHostBashOperations(options: CreateHostBashOptions): RevocableHostBashOperations {
  const local = options.operations ?? createBoundedLocalHostBashOperations();
  const active = new Map<AbortController, Promise<unknown>>();
  let revoked = false;
  return {
    async exec(command, cwd, execOptions) {
      const decision = options.authorizeExecution({ command, cwd });
      if (revoked) {
        throw new Error("Wayang denied host execution before local execution: runtime authority was revoked");
      }
      if (!decision.allowed) {
        throw new Error(`Wayang denied host execution before local execution: ${decision.reason ?? "authorization failed"}`);
      }
      const executionAbort = new AbortController();
      const onCallerAbort = () => executionAbort.abort();
      if (execOptions.signal?.aborted) onCallerAbort();
      else execOptions.signal?.addEventListener("abort", onCallerAbort, { once: true });
      let streamingDenial: string | undefined;
      const execution = local.exec(command, cwd, {
        ...execOptions,
        signal: executionAbort.signal,
        onData: (data) => {
          if (revoked || streamingDenial) return;
          try {
            const chunkDecision = options.authorizeExecution({ command, cwd });
            if (!chunkDecision.allowed) {
              streamingDenial = chunkDecision.reason ?? "authorization failed";
              executionAbort.abort();
              return;
            }
            execOptions.onData(data);
          } catch {
            streamingDenial = "authorization failed";
            executionAbort.abort();
          }
        },
        env: buildHostChildEnvironment(execOptions.env ?? process.env, options.environmentOptions),
      });
      active.set(executionAbort, execution);
      try {
        const result = await execution;
        if (revoked || streamingDenial) {
          throw new Error(`Wayang aborted host execution before release: ${streamingDenial ?? "runtime authority was revoked"}`);
        }
        const releaseDecision = options.authorizeExecution({ command, cwd });
        if (!releaseDecision.allowed) {
          throw new Error(`Wayang suppressed host execution result before release: ${releaseDecision.reason ?? "authorization failed"}`);
        }
        return result;
      } finally {
        active.delete(executionAbort);
        execOptions.signal?.removeEventListener("abort", onCallerAbort);
      }
    },
    async revoke() {
      revoked = true;
      const inFlight = [...active.entries()];
      for (const [controller] of inFlight) controller.abort();
      await Promise.allSettled(inFlight.map(([, execution]) => execution));
    },
  };
}

export function createHostBashToolDefinition(cwd: string, options: CreateHostBashOptions): any {
  const operations = createHostBashOperations(options);
  const tool = createBashToolDefinition(cwd, { operations });
  const definition = {
    ...tool,
    label: "bash (Wayang host)",
    description: `${tool.description} This exact capability-authorized interactive runtime executes as the normal Wayang OS user on the host, not in Wayang's filesystem/socket sandbox. Wayang blocks recognized direct lexical sudo syntax; use sudo_exec for reviewed privileged operations. This does not contain indirect or other host privilege mechanisms. This same-user process can technically reach Protected and other same-user state, so that isolation is cooperative against this process.`,
  };
  Object.defineProperty(definition, "revokeActiveExecutions", {
    value: () => operations.revoke(),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return definition;
}
