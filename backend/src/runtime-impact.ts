import { listSessions } from "./sessions.js";
import { getProject, getProjectByCwd } from "./projects.js";
import {
  getRuntimeMutationSessionState,
  lockRuntimeMutationSession,
  stopPiSessionIfIdle,
  unlockRuntimeMutationSession,
  type RuntimeMutationSessionState,
} from "./pi-bridge.js";
import { WorkspaceStoreError } from "./workspace-types.js";

export interface RuntimeImpactConflictBody {
  error: string;
  code: "runtime_mutation_conflict";
  affected_session_ids: string[];
  streaming_session_ids: string[];
  queued_session_ids: string[];
  starting_session_ids: string[];
  mutation_locked_session_ids: string[];
}

export class RuntimeImpactConflict extends WorkspaceStoreError {
  readonly body: RuntimeImpactConflictBody;

  constructor(states: RuntimeMutationSessionState[]) {
    super("Settings cannot change while affected sessions are active", 409);
    this.name = "RuntimeImpactConflict";
    this.body = {
      error: this.message,
      code: "runtime_mutation_conflict",
      affected_session_ids: states.map((state) => state.session_id),
      streaming_session_ids: states.filter((state) => state.streaming).map((state) => state.session_id),
      queued_session_ids: states.filter((state) => state.queued).map((state) => state.session_id),
      starting_session_ids: states.filter((state) => state.runtime_status === "starting").map((state) => state.session_id),
      mutation_locked_session_ids: states.filter((state) => state.mutation_locked).map((state) => state.session_id),
    };
  }
}

export interface RuntimeCleanupFailure {
  session_id: string;
  error: "runtime_cleanup_failed";
}

export interface RuntimeMutationImpactLease {
  readonly affected_session_ids: string[];
  readonly cleanup_failures: RuntimeCleanupFailure[];
  commitAndStopIdle(): Promise<string[]>;
  release(): void;
}

export interface RuntimeImpactAdapter {
  getState(sessionId: string): RuntimeMutationSessionState;
  lock(sessionId: string): boolean;
  unlock(sessionId: string): void;
  stopIfIdle(sessionId: string): Promise<boolean>;
}

const defaultRuntimeImpactAdapter: RuntimeImpactAdapter = {
  getState: getRuntimeMutationSessionState,
  lock: lockRuntimeMutationSession,
  unlock: unlockRuntimeMutationSession,
  stopIfIdle: stopPiSessionIfIdle,
};

export function acquireRuntimeMutationImpact(
  sessionIds: Iterable<string>,
  adapter: RuntimeImpactAdapter = defaultRuntimeImpactAdapter,
): RuntimeMutationImpactLease {
  const uniqueIds = [...new Set(sessionIds)];
  const states = uniqueIds
    .map((id) => adapter.getState(id))
    .filter((state) => state.runtime_status !== "stopped" || state.mutation_locked);
  const blocking = states.filter((state) => (
    state.streaming || state.queued || state.runtime_status === "starting" || state.mutation_locked
  ));
  if (blocking.length > 0) throw new RuntimeImpactConflict(states);

  const locked: string[] = [];
  for (const state of states) {
    if (!adapter.lock(state.session_id)) {
      for (const id of locked) adapter.unlock(id);
      throw new RuntimeImpactConflict(states.map((candidate) => (
        candidate.session_id === state.session_id ? { ...candidate, mutation_locked: true } : candidate
      )));
    }
    locked.push(state.session_id);
  }

  let settled = false;
  const cleanupFailures: RuntimeCleanupFailure[] = [];
  const recordCleanupFailure = (id: string) => {
    if (!cleanupFailures.some((failure) => failure.session_id === id)) {
      cleanupFailures.push({ session_id: id, error: "runtime_cleanup_failed" });
    }
  };
  const release = () => {
    if (settled) return;
    settled = true;
    for (const id of locked) {
      try { adapter.unlock(id); } catch { recordCleanupFailure(id); }
    }
  };

  return {
    affected_session_ids: [...locked],
    cleanup_failures: cleanupFailures,
    release,
    async commitAndStopIdle(): Promise<string[]> {
      if (settled) return [];
      const stopped: string[] = [];
      try {
        for (const id of locked) {
          try {
            if (await adapter.stopIfIdle(id)) stopped.push(id);
          } catch {
            recordCleanupFailure(id);
          }
        }
        return stopped;
      } finally {
        release();
      }
    },
  };
}

export function projectRuntimeSessionIds(cwd: string): string[] {
  return listSessions(true).filter((session) => session.cwd === cwd).map((session) => session.id);
}

export function profileRuntimeSessionIds(profileId: string): string[] {
  const referencedProjectCwds = new Set(listSessions(true)
    .map((session) => getProjectByCwd(session.cwd))
    .filter((project) => project?.default_agent_profile_id === profileId
      || project?.access_policy.allowed_agent_profile_ids?.includes(profileId))
    .map((project) => project!.cwd));
  return listSessions(true).filter((session) => {
    if (session.agent_profile_id === profileId) return true;
    if (referencedProjectCwds.has(session.cwd)) return true;
    if (session.agent_profile_id) return false;
    return getProjectByCwd(session.cwd)?.default_agent_profile_id === profileId;
  }).map((session) => session.id);
}

export function capabilityPairRuntimeSessionIds(
  projectId: string,
  profileId: string,
): string[] {
  const project = getProject(projectId);
  if (!project) return [];
  return listSessions(true)
    .filter((session) => session.cwd === project.cwd && session.agent_profile_id === profileId)
    .map((session) => session.id);
}

export function previewRuntimeMutationImpact(sessionIds: Iterable<string>): RuntimeMutationSessionState[] {
  return [...new Set(sessionIds)]
    .map((id) => defaultRuntimeImpactAdapter.getState(id))
    .filter((state) => state.runtime_status !== "stopped" || state.mutation_locked);
}

export function acquireProjectRuntimeImpact(cwd: string): RuntimeMutationImpactLease {
  return acquireRuntimeMutationImpact(projectRuntimeSessionIds(cwd));
}

export function acquireProfileRuntimeImpact(profileId: string): RuntimeMutationImpactLease {
  return acquireRuntimeMutationImpact(profileRuntimeSessionIds(profileId));
}

export function acquireCapabilityPairRuntimeImpact(
  projectId: string,
  profileId: string,
): RuntimeMutationImpactLease {
  return acquireRuntimeMutationImpact(capabilityPairRuntimeSessionIds(projectId, profileId));
}

export const runtimeImpactService = {
  acquireProject: acquireProjectRuntimeImpact,
  acquireProfile: acquireProfileRuntimeImpact,
  acquireCapabilityPair: acquireCapabilityPairRuntimeImpact,
};

export function runtimeImpactErrorBody(error: unknown): RuntimeImpactConflictBody | null {
  return error instanceof RuntimeImpactConflict ? error.body : null;
}
