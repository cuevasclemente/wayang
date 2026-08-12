import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getAgentProfile } from "../agent-profiles.js";
import {
  abortSession,
  createPiSession,
  getPiSession,
  getPiSessionRuntimeState,
  hasMessagingPromptOrigin,
  runMessagingPromptAndWait,
  type MessagingPromptOrigin,
  type RunPromptResult,
} from "../pi-bridge.js";
import { authorizeProjectAction } from "../policy.js";
import { getProject } from "../projects.js";
import {
  createSession,
  getSessionById,
  isLegacyPrivateSessionQuarantined,
  listSessions,
  updatePiSessionFile,
  type SessionRow,
} from "../sessions.js";
import { WorkspaceStoreError, type AgentProfileRow, type ProjectRow } from "../workspace-types.js";
import type {
  MessagingConversationBinding,
  MessagingEndpointDeclaration,
  NormalizedMessagingInboundEvent,
} from "./contracts.js";

export interface MessagingSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly lastActive: number;
  readonly active: boolean;
}

export interface MessagingEndpointStatus {
  readonly projectId: string;
  readonly projectName: string;
  readonly agentProfileId: string;
  readonly agentProfileName: string;
  readonly activeSession: MessagingSessionSummary | null;
  readonly runtimeStatus: "active" | "starting" | "stopped";
  readonly streaming: boolean;
  readonly queued: boolean;
}

export interface WayangMessagingSessionPort {
  createSessionCandidate(
    declaration: MessagingEndpointDeclaration,
    idempotencyKey: string,
  ): Promise<MessagingSessionSummary>;
  listEligibleSessions(declaration: MessagingEndpointDeclaration, activeSessionId: string | null): Promise<MessagingSessionSummary[]>;
  resolveEligibleSession(declaration: MessagingEndpointDeclaration, sessionId: string): Promise<MessagingSessionSummary>;
  getStatus(declaration: MessagingEndpointDeclaration, binding: MessagingConversationBinding): Promise<MessagingEndpointStatus>;
  inspectOrigin(sessionId: string, origin: MessagingPromptOrigin): Promise<"absent" | "present">;
  abortTurn?(sessionId: string): Promise<void>;
  runTurn(
    declaration: MessagingEndpointDeclaration,
    binding: MessagingConversationBinding,
    event: NormalizedMessagingInboundEvent,
    options: { canonicalEventSha256: string; timeoutMs?: number; authorizeDispatch: () => void },
  ): Promise<RunPromptResult>;
}

interface ExactScope {
  project: ProjectRow;
  profile: AgentProfileRow;
}

function resolveScope(declaration: MessagingEndpointDeclaration): ExactScope {
  const project = getProject(declaration.projectId);
  const profile = getAgentProfile(declaration.agentProfileId);
  if (!project || !profile) throw new WorkspaceStoreError("Messaging endpoint Project/Profile scope was not found", 404);
  const decision = authorizeProjectAction({
    cwd: project.cwd,
    actor: "interactive",
    agentProfileId: profile.id,
  });
  if (!decision.allowed || decision.project?.id !== project.id || decision.agentProfile?.id !== profile.id) {
    throw new WorkspaceStoreError(decision.reason ?? "Messaging endpoint scope is not authorized", 403);
  }
  return { project, profile };
}

function eligible(row: SessionRow, scope: ExactScope): boolean {
  return row.project_id === scope.project.id
    && row.cwd === scope.project.cwd
    && row.agent_profile_id === scope.profile.id
    && !row.archived
    && !isLegacyPrivateSessionQuarantined(row)
    && row.pending_agent_switch === null
    && row.scheduled_job_id === null
    && row.scheduled_run_id === null;
}

function summary(row: SessionRow, activeSessionId: string | null): MessagingSessionSummary {
  return {
    id: row.id,
    title: row.title || "Untitled session",
    createdAt: row.created_at,
    lastActive: row.last_active,
    active: row.id === activeSessionId,
  };
}

function requireEligibleSession(
  declaration: MessagingEndpointDeclaration,
  sessionId: string,
): { row: SessionRow; scope: ExactScope } {
  const scope = resolveScope(declaration);
  const row = getSessionById(sessionId);
  if (!row || !eligible(row, scope)) {
    throw new WorkspaceStoreError("Wayang session is not eligible for this messaging endpoint", 403);
  }
  return { row, scope };
}

function originFor(
  declaration: MessagingEndpointDeclaration,
  event: NormalizedMessagingInboundEvent,
  canonicalEventSha256: string,
): MessagingPromptOrigin {
  return {
    connectorId: event.connectorId,
    connectorEventId: event.connectorEventId,
    endpointId: declaration.endpointId,
    canonicalEventSha256,
  };
}

export class ProductionWayangMessagingSessionPort implements WayangMessagingSessionPort {
  async createSessionCandidate(
    declaration: MessagingEndpointDeclaration,
    idempotencyKey: string,
  ): Promise<MessagingSessionSummary> {
    const scope = resolveScope(declaration);
    const row = createSession(scope.project.cwd, {
      title: `${declaration.displayName} — external session`,
      agentProfileId: scope.profile.id,
      idempotencyKey: `messaging-endpoint:${declaration.endpointId}:event:${idempotencyKey}`,
    });
    if (!eligible(row, scope)) throw new WorkspaceStoreError("Created Wayang session failed endpoint eligibility", 409);
    return summary(row, null);
  }

  async listEligibleSessions(
    declaration: MessagingEndpointDeclaration,
    activeSessionId: string | null,
  ): Promise<MessagingSessionSummary[]> {
    const scope = resolveScope(declaration);
    return listSessions(false).filter((row) => eligible(row, scope)).slice(0, 50)
      .map((row) => summary(row, activeSessionId));
  }

  async resolveEligibleSession(
    declaration: MessagingEndpointDeclaration,
    sessionId: string,
  ): Promise<MessagingSessionSummary> {
    const { row } = requireEligibleSession(declaration, sessionId);
    return summary(row, null);
  }

  async getStatus(
    declaration: MessagingEndpointDeclaration,
    binding: MessagingConversationBinding,
  ): Promise<MessagingEndpointStatus> {
    const scope = resolveScope(declaration);
    const active = binding.activeWayangSessionId
      ? requireEligibleSession(declaration, binding.activeWayangSessionId).row
      : null;
    const runtime = active ? getPiSessionRuntimeState(active.id) : null;
    return {
      projectId: scope.project.id,
      projectName: scope.project.name,
      agentProfileId: scope.profile.id,
      agentProfileName: scope.profile.name,
      activeSession: active ? summary(active, active.id) : null,
      runtimeStatus: runtime?.runtime_status ?? "stopped",
      streaming: runtime?.runtime_is_streaming ?? false,
      queued: active ? Boolean(getPiSession(active.id)?.session.pendingMessageCount) : false,
    };
  }

  async inspectOrigin(sessionId: string, origin: MessagingPromptOrigin): Promise<"absent" | "present"> {
    if (hasMessagingPromptOrigin(sessionId, origin)) return "present";
    const row = getSessionById(sessionId);
    if (!row?.pi_session_file) return "absent";
    let entries: any[];
    try {
      entries = SessionManager.open(row.pi_session_file, undefined, row.cwd).getEntries();
    } catch {
      throw new WorkspaceStoreError("Messaging recovery could not inspect the Wayang session", 409);
    }
    return entries.some((entry: any) => (
      entry?.type === "custom_message"
      && entry.customType === "wayang-messaging-input"
      && entry.details?.connector_id === origin.connectorId
      && entry.details?.connector_event_id === origin.connectorEventId
      && entry.details?.endpoint_id === origin.endpointId
      && entry.details?.canonical_event_sha256 === origin.canonicalEventSha256
    )) ? "present" : "absent";
  }

  async abortTurn(sessionId: string): Promise<void> {
    await abortSession(sessionId, { clearQueue: true });
  }

  async runTurn(
    declaration: MessagingEndpointDeclaration,
    binding: MessagingConversationBinding,
    event: NormalizedMessagingInboundEvent,
    options: { canonicalEventSha256: string; timeoutMs?: number; authorizeDispatch: () => void },
  ): Promise<RunPromptResult> {
    const sessionId = binding.activeWayangSessionId;
    if (!sessionId) throw new WorkspaceStoreError("Messaging endpoint has no active Wayang session", 409);
    const { row, scope } = requireEligibleSession(declaration, sessionId);
    if (binding.endpointId !== declaration.endpointId || binding.connectorId !== declaration.connectorId
      || event.connectorId !== declaration.connectorId
      || event.externalConversationId !== binding.externalConversationId) {
      throw new WorkspaceStoreError("Messaging turn binding mismatch", 403);
    }
    let handle = getPiSession(row.id);
    if (!handle) {
      handle = await createPiSession(row.id, row.cwd, row.provider, row.model, row.pi_session_file);
      if (handle.sessionFile && !row.pi_session_file) updatePiSessionFile(row.id, handle.sessionFile);
    }
    const current = requireEligibleSession(declaration, sessionId);
    if (current.scope.project.id !== scope.project.id || current.scope.profile.id !== scope.profile.id
      || handle.cwd !== scope.project.cwd || handle.agentProfileId !== scope.profile.id) {
      throw new WorkspaceStoreError("Messaging session scope changed during runtime creation", 409);
    }
    options.authorizeDispatch();
    return runMessagingPromptAndWait(
      row.id,
      event.body,
      originFor(declaration, event, options.canonicalEventSha256),
      { timeoutMs: options.timeoutMs },
    );
  }
}
