/**
 * ws.ts — WebSocket endpoint for structured chat with pi.
 *
 * Protocol:
 *   Client → Server:
 *     { type: "message", content: string, client_message_id?: string, attachments?: {name?: string, mimeType?: string, data: string, size?: number}[] }
 *     { type: "cancel_queued_message", client_message_id: string }
 *     { type: "resend", message_id: string }
 *     { type: "interrupt", clear_queue?: boolean }
 *     { type: "set_permission", mode: string }
 *     { type: "set_goal", goal: string }
 *     { type: "subagent_spawn", agent: string, task: string, mode: "single"|"parallel"|"chain" }
 *     { type: "external_action_response", requestId, sessionId, selection_id, argumentsHash, approved, pin? }
 *     { type: "interview_response", requestId, answers }
 *     { type: "interview_cancel", requestId }
 *     { type: "command_guard_pin_response", requestId, sessionId, selection_id, pin? | cancelled }
 *
 *   Server → Client:
 *     { type: "history", messages: [...] }
 *     { type: "session_runtime_state", session_id, selection_id, bash_mode }
 *     { type: "text_delta", delta: string }
 *     { type: "thinking_delta", delta: string }
 *     { type: "tool_execution_start", tool_call_id, tool_name, input }
 *     { type: "tool_execution_end", tool_call_id, tool_name, result, is_error }
 *     { type: "agent_start" }
 *     { type: "agent_end", messages: [...] }
 *     { type: "error", error: string }
 *     { type: "subagent_event", subagent_id, event }
 *     { type: "goal_update", goal_id, status }
 *     { type: "context_usage", tokens: number|null, contextWindow: number, percent: number|null }
 *     { type: "history", streaming_at_snapshot: boolean, compacting_at_snapshot: boolean, messages: [...] }
 *     { type: "compaction_start", reason: "manual"|"threshold"|"overflow" }
 *     { type: "compaction_end", reason, succeeded, aborted, will_retry, error? }
 *     { type: "agent_settled" }
 *     { type: "queue_update", steering: string[], followUp: string[] }
 *     { type: "queued_message_snapshot", session_id, selection_id, messages: [...] }
 *     { type: "queued_message_ack", session_id, client_message_id, status: "queued"|"accepted"|"rejected", cancellable?, error? }
 *     { type: "queued_message_cancel_ack", session_id, client_message_id, status: "cancelled"|"not_found"|"error", error? }
 *     { type: "external_action_request", requestId, sessionId, selection_id, argumentsHash, ...displayMetadata }
 *     { type: "external_action_response_ack", requestId, sessionId, selection_id, status, errorCode?, retryAt? }
 *     { type: "external_action_terminal", requestId, sessionId, selection_id, status }
 *     { type: "external_action_snapshot", sessionId, selection_id, requests, syncComplete: true }
 *     { type: "interview_cancel_ack", requestId, sessionId, status: "cancelled"|"rejected", errorCode?, error? }
 *     { type: "command_guard_pin_request", requestId, sessionId, selection_id, ...displayMetadata }
 */

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import {
  createPiSession,
  getPiSession,
  getPiSessionBashMode,
  getRuntimeMutationSessionState,
  sendMessage,
  resendMessage,
  abortSession,
  cancelQueuedBrowserMessage,
  getQueuedBrowserMessages,
  subscribeToSession,
  getMessageHistory,
  getLiveMessageHistory,
  getSessionFileTodoState,
  getSessionFileSnapshot,
  invalidateSessionFileSnapshot,
  getTodoState,
  getCommandGuardState,
  setCommandGuardMode,
  ensureInteractiveCommandGuardEnabled,
  onPiSessionRuntimeEvent,
  setSessionModel,
  type CommandGuardMode,
  type PiSessionHandle,
  type SerializedMessage,
} from "../pi-bridge.js";
import {
  getSessionById,
  isLegacyPrivateSessionQuarantined,
  persistManualSessionTitle,
  touchSession,
  updateGoal,
  updatePiSessionFile,
  updateSessionError,
} from "../sessions.js";
import { getInterviewBridge } from "../interview-bridge.js";
import {
  confirmInterviewToolResultDelivery,
  drainSubmittedInterviews,
  retrySubmittedInterviewDelivery,
} from "../interview-delivery.js";
import { cancelInterview, getInterviewForSession, submitInterview } from "../interviews.js";
import {
  WAYANG_WEBSOCKET_SUBMISSION_CONTEXT,
  type InterviewSubmissionContext,
} from "../interview-provenance.js";
import { getSudoBridge, type SudoRequest } from "../sudo-bridge.js";
import { getCommandGuardIdentityBridge, type CommandGuardIdentityRequest } from "../command-guard-bridge.js";
import {
  getActionApprovalBridge,
  type ActionApprovalBridge,
  type ApprovalResponse,
  type ApprovalTerminalEvent,
  type ExternalActionRequest,
} from "../action-approval-bridge.js";
import { recordLatencyMetric } from "../latency-metrics.js";
import { scheduleWayangAutoTitle, scheduleWayangAutoTitleFromActivation } from "../session-title-service.js";
import type {
  ExternalActionTerminalMessage,
  SessionRuntimeStateMessage,
} from "@wayang/protocol";
import { authorizeProjectAction } from "../policy.js";
import type { AuthService } from "../auth/service.js";
import { prepareAttachments } from "../attachments.js";
import { logSessionRuntimeStartFailure } from "../session-runtime-logging.js";

export const router = Router();

const wsHandshakeStarts = new WeakMap<object, number>();

function nowMs(): number {
  return performance.now();
}

function elapsedMs(start: number): string {
  return `${(nowMs() - start).toFixed(1)}ms`;
}

function shortSessionId(sessionId: string | null | undefined): string {
  return sessionId ? sessionId.slice(0, 8) : "none";
}

function wsProfile(sessionId: string | null | undefined, event: string, details = ""): void {
  if (process.env.WAYANG_LATENCY_PROFILE_VERBOSE !== "1") return;
  console.log(
    `[ws-profile] ${new Date().toISOString()} sid=${shortSessionId(sessionId)} event=${event}${details ? ` ${details}` : ""}`,
  );
}

/** @internal Exported for focused wire-contract tests. */
export function serializeSessionRuntimeState(sessionId: string, selectionId: string | null): SessionRuntimeStateMessage {
  return {
    type: "session_runtime_state" as const,
    session_id: sessionId,
    ...(selectionId ? { selection_id: selectionId } : {}),
    bash_mode: getPiSessionBashMode(sessionId),
  };
}

/** @internal Exported for focused approval eligibility tests. */
export function isExternalActionApprovalClientEligible(
  selectionId: string | null,
  quarantined: boolean,
  mutationLocked = false,
): selectionId is string {
  return !quarantined && !mutationLocked && typeof selectionId === "string" && selectionId.length > 0;
}

/** @internal Exported for focused terminal wire-contract tests. */
export function serializeExternalActionTerminal(
  event: ApprovalTerminalEvent,
  selectionId: string,
): ExternalActionTerminalMessage {
  return {
    type: "external_action_terminal" as const,
    requestId: event.requestId,
    sessionId: event.sessionId,
    selection_id: selectionId,
    status: event.status,
  };
}

/** @internal Exported for focused terminal-before-snapshot ordering tests. */
export function sendExternalActionTerminalState(
  ws: WebSocket,
  event: ApprovalTerminalEvent,
  selectionId: string,
  getRequests: () => ExternalActionRequest[],
): void {
  sendSafe(ws, serializeExternalActionTerminal(event, selectionId));
  sendSafe(ws, {
    type: "external_action_snapshot",
    sessionId: event.sessionId,
    selection_id: selectionId,
    requests: getRequests(),
    syncComplete: true,
  });
}

// We attach this to the HTTP server in app.ts
export function attachWs(httpServer: Server, auth: AuthService): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "", "http://localhost").pathname;
    if (pathname !== "/ws/chat") return;
    const decision = auth.authorizeWebSocket(req);
    if (!decision.allowed) {
      auth.rejectWebSocket(socket, decision);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("headers", (_headers, req) => {
    const start = nowMs();
    wsHandshakeStarts.set(req, start);
    const url = new URL(req.url || "", "http://localhost");
    wsProfile(url.searchParams.get("session_id"), "upgrade_headers");
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const connectionStart = nowMs();
    const url = new URL(req.url || "", "http://localhost");
    const sessionId = url.searchParams.get("session_id");
    const selectionId = url.searchParams.get("selection_id");
    const handshakeStart = wsHandshakeStarts.get(req);
    wsProfile(
      sessionId,
      "connection_event",
      handshakeStart ? `handshake_since_headers=${elapsedMs(handshakeStart)}` : "handshake_since_headers=unknown",
    );

    if (!sessionId) {
      wsProfile(sessionId, "close_missing_session_id");
      ws.close(1008, "session_id required");
      return;
    }

    const lookupStart = nowMs();
    const session = getSessionById(sessionId);
    wsProfile(sessionId, "session_lookup", `duration=${elapsedMs(lookupStart)} found=${Boolean(session)}`);
    if (!session) {
      wsProfile(sessionId, "close_session_not_found");
      ws.close(1008, "session not found");
      return;
    }

    wsProfile(sessionId, "handle_connection_start", `connection_event_duration=${elapsedMs(connectionStart)}`);
    handleConnection(ws, sessionId, selectionId, WAYANG_WEBSOCKET_SUBMISSION_CONTEXT);
  });
}

interface PendingMessage {
  type: string;
  data?: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_input?: any;
  thinking?: string;
}

function handleConnection(
  ws: WebSocket,
  sessionId: string,
  initialSelectionId: string | null,
  submissionContext: InterviewSubmissionContext,
): void {
  const connectionStart = nowMs();
  wsProfile(sessionId, "handle_connection_enter");
  let alive = true;
  let currentSessionId = sessionId;
  let currentSelectionId: string | null = initialSelectionId;
  let ready = false;
  let readyError: string | null = null;
  let setupVersion = 0;
  let unsubscribe: (() => void) | null = null;
  let subscribedHandle: PiSessionHandle | null = null;
  let interviewBridgeUnsub: (() => void) | null = null;
  let sudoBridgeUnsub: (() => void) | null = null;
  let commandGuardIdentityBridgeUnsub: (() => void) | null = null;
  const actionApprovalClientId = randomUUID();
  let actionApprovalDetach: (() => void) | null = null;
  let actionApprovalRequestUnsub: (() => void) | null = null;
  let actionApprovalTerminalUnsub: (() => void) | null = null;
  let filePollTimer: NodeJS.Timeout | null = null;
  let runtimeEventUnsub: (() => void) | null = null;
  const pendingMessages: any[] = [];

  const sendCorrelatedClientFailure = (targetSessionId: string, msg: any, error: string): boolean => {
    let clientMessageId: string | undefined;
    try { clientMessageId = optionalClientMessageId(msg?.client_message_id); }
    catch { return false; }
    if (!clientMessageId) return false;
    if (msg?.type === "message") {
      sendSafe(ws, {
        type: "queued_message_ack",
        session_id: targetSessionId,
        client_message_id: clientMessageId,
        status: "rejected",
        error,
      });
      return true;
    }
    if (msg?.type === "cancel_queued_message") {
      sendSafe(ws, {
        type: "queued_message_cancel_ack",
        session_id: targetSessionId,
        client_message_id: clientMessageId,
        status: "error",
        error,
      });
      return true;
    }
    return false;
  };

  const stopFilePoll = () => {
    if (filePollTimer) {
      clearInterval(filePollTimer);
      filePollTimer = null;
    }
  };

  const cleanupSubscriptions = () => {
    unsubscribe?.();
    unsubscribe = null;
    subscribedHandle = null;
    interviewBridgeUnsub?.();
    interviewBridgeUnsub = null;
    sudoBridgeUnsub?.();
    sudoBridgeUnsub = null;
    commandGuardIdentityBridgeUnsub?.();
    commandGuardIdentityBridgeUnsub = null;
    actionApprovalDetach?.();
    actionApprovalDetach = null;
    actionApprovalRequestUnsub?.();
    actionApprovalRequestUnsub = null;
    actionApprovalTerminalUnsub?.();
    actionApprovalTerminalUnsub = null;
    stopFilePoll();
  };

  const flushPending = () => {
    const queued = pendingMessages.splice(0);
    for (const queuedMsg of queued) {
      dispatchClientMessage(queuedMsg);
    }
  };

  const startFilePoll = (
    nextSessionId: string,
    sessionFile: string | null | undefined,
    cwd: string | null | undefined,
    version: number,
    selectionId: string | null,
    runtimeEligible: boolean,
  ) => {
    const pollStart = nowMs();
    stopFilePoll();
    if (!sessionFile) {
      wsProfile(nextSessionId, "file_poll_skip", "reason=no_session_file");
      return;
    }

    let lastMtimeMs = 0;
    try {
      lastMtimeMs = fs.statSync(sessionFile).mtimeMs;
    } catch (err: any) {
      wsProfile(nextSessionId, "file_poll_skip", `reason=stat_failed duration=${elapsedMs(pollStart)} error=${err?.message || String(err)}`);
      return;
    }

    wsProfile(nextSessionId, "file_poll_started", `duration=${elapsedMs(pollStart)}`);
    filePollTimer = setInterval(() => {
      if (!alive || version !== setupVersion) return;
      if (runtimeEligible && getPiSession(nextSessionId)) return;

      try {
        const mtimeMs = fs.statSync(sessionFile).mtimeMs;
        if (mtimeMs <= lastMtimeMs) return;
        lastMtimeMs = mtimeMs;
        const historyStart = nowMs();
        const snapshot = getSessionFileSnapshot(sessionFile, cwd);
        const messages = snapshot?.messages ?? [];
        wsProfile(nextSessionId, "file_poll_history_loaded", `duration=${elapsedMs(historyStart)} messages=${messages.length}`);
        sendSafe(ws, {
          type: "history",
          session_id: nextSessionId,
          ...(selectionId ? { selection_id: selectionId } : {}),
          reason: "external_file_change",
          message_count: messages.length,
          payload_bytes: snapshot?.payloadBytes ?? 0,
          messages,
        });
        sendSafe(ws, { ...(snapshot?.todoState ?? getSessionFileTodoState(sessionFile, cwd)), session_id: nextSessionId, ...(selectionId ? { selection_id: selectionId } : {}) });
      } catch {
        // Ignore transient file errors; the next sessions sync will reconcile
        // deleted/moved session files.
      }
    }, 2_000);
  };

  const attachLiveSession = async (
    nextSessionId: string,
    version: number,
    createIfMissing: boolean,
    selectionId: string | null,
    sendInitialSnapshot = true,
  ): Promise<boolean> => {
    const durable = getSessionById(nextSessionId);
    if (durable && isLegacyPrivateSessionQuarantined(durable)) {
      wsProfile(nextSessionId, "attach_live_skip", "reason=legacy_quarantine");
      return false;
    }
    const attachStart = nowMs();
    wsProfile(nextSessionId, "attach_live_start", `createIfMissing=${createIfMissing} hasLive=${Boolean(getPiSession(nextSessionId))}`);
    if (!getPiSession(nextSessionId)) {
      if (!createIfMissing) {
        wsProfile(nextSessionId, "attach_live_skip", `duration=${elapsedMs(attachStart)} reason=not_live`);
        return false;
      }
      const createStart = nowMs();
      await getOrCreatePiSession(nextSessionId);
      wsProfile(nextSessionId, "attach_live_created", `duration=${elapsedMs(createStart)}`);
    }

    if (!alive || version !== setupVersion) return false;
    const liveHandle = getPiSession(nextSessionId);
    if (!liveHandle) return false;

    if (!liveHandle.session.isStreaming) {
      ensureInteractiveCommandGuardEnabled(nextSessionId, "websocket live-session attach");
    }
    if (unsubscribe && subscribedHandle !== liveHandle) {
      unsubscribe();
      unsubscribe = null;
      subscribedHandle = null;
    }
    stopFilePoll();

    const alreadySubscribedToLiveHandle = Boolean(unsubscribe && subscribedHandle === liveHandle);
    const bufferedEvents: SerializedMessage[] = [];
    let bufferLiveEvents = !alreadySubscribedToLiveHandle;
    let bufferOverflow = false;
    const deliverLiveEvent = (msg: SerializedMessage) => {
      if (!alive || version !== setupVersion) return;
      if (msg.type === "turn_end" || msg.type === "agent_end" || msg.type === "agent_settled") {
        touchSession(nextSessionId);
      }
      sendSafe(ws, {
        ...msg,
        session_id: nextSessionId,
        ...(selectionId ? { selection_id: selectionId } : {}),
      });
      if (msg.type === "turn_end" || msg.type === "agent_end" || msg.type === "agent_settled") {
        sendSafe(ws, { ...getTodoState(nextSessionId), session_id: nextSessionId, ...(selectionId ? { selection_id: selectionId } : {}) });
      }

      // Pi's agent_end is intermediate: retry and auto-compaction run after it.
      // Reconcile context usage only once the top-level run settles. Manual
      // compaction has no agent_settled event, so a successful compaction_end
      // is also an authoritative reconciliation point.
      if (shouldReconcileLiveSessionState(msg)) {
        const streamingAtSnapshot = Boolean(liveHandle.session.isStreaming);
        // AgentSession emits compaction_end before clearing its internal abort
        // controller, so isCompacting is transiently stale during this exact
        // reconciliation callback. The lifecycle event is authoritative.
        const compactingAtSnapshot = msg.type === "compaction_end"
          ? false
          : Boolean(liveHandle.session.isCompacting);
        const reconciled = getLiveMessageHistory(nextSessionId);
        sendSafe(ws, {
          type: "history",
          session_id: nextSessionId,
          ...(selectionId ? { selection_id: selectionId } : {}),
          reason: msg.type === "agent_settled" ? "agent_settled_reconciliation" : "compaction_end_reconciliation",
          streaming_at_snapshot: streamingAtSnapshot,
          compacting_at_snapshot: compactingAtSnapshot,
          message_count: reconciled.length,
          payload_bytes: Buffer.byteLength(JSON.stringify(reconciled)),
          messages: reconciled,
        });
        sendContextUsage(ws, nextSessionId);
      }
    };

    if (!unsubscribe) {
      subscribedHandle = liveHandle;
      unsubscribe = subscribeToSession(nextSessionId, (msg: SerializedMessage) => {
        if (!alive || version !== setupVersion) return;
        if (bufferLiveEvents) {
          if (bufferedEvents.length >= 1_000) bufferOverflow = true;
          else bufferedEvents.push(msg);
          return;
        }
        deliverLiveEvent(msg);
      });
    }

    if (sendInitialSnapshot) {
      // Subscribe first, capture the authoritative snapshot synchronously, then
      // drain events observed after capture. Events queued before capture are
      // represented by the snapshot and are discarded to prevent duplicates.
      const liveHistoryStart = nowMs();
      // Capture runtime state with the synchronous history snapshot. The
      // snapshot is the attach boundary: earlier events are represented by
      // history and later events are drained below. A synthetic agent_start
      // after that drain would clear valid post-snapshot deltas in the client.
      const streamingAtSnapshot = Boolean(liveHandle.session.isStreaming);
      const compactingAtSnapshot = Boolean(liveHandle.session.isCompacting);
      const liveHistory = getLiveMessageHistory(nextSessionId);
      bufferedEvents.length = 0;
      wsProfile(nextSessionId, "attach_live_history", `duration=${elapsedMs(liveHistoryStart)} messages=${liveHistory.length}`);
      sendSafe(ws, {
        type: "history",
        session_id: nextSessionId,
        ...(selectionId ? { selection_id: selectionId } : {}),
        reason: "initial",
        streaming_at_snapshot: streamingAtSnapshot,
        compacting_at_snapshot: compactingAtSnapshot,
        message_count: liveHistory.length,
        payload_bytes: Buffer.byteLength(JSON.stringify(liveHistory)),
        messages: liveHistory,
      });
      sendSafe(ws, { ...getTodoState(nextSessionId), session_id: nextSessionId, ...(selectionId ? { selection_id: selectionId } : {}) });
      sendSafe(ws, {
        type: "queued_message_snapshot",
        session_id: nextSessionId,
        ...(selectionId ? { selection_id: selectionId } : {}),
        messages: getQueuedBrowserMessages(nextSessionId),
      });
    }
    bufferLiveEvents = false;
    if (bufferOverflow) {
      const streamingAtSnapshot = Boolean(liveHandle.session.isStreaming);
      const compactingAtSnapshot = Boolean(liveHandle.session.isCompacting);
      const retryHistory = getLiveMessageHistory(nextSessionId);
      sendSafe(ws, {
        type: "history",
        session_id: nextSessionId,
        ...(selectionId ? { selection_id: selectionId } : {}),
        reason: "event_buffer_overflow_resnapshot",
        streaming_at_snapshot: streamingAtSnapshot,
        compacting_at_snapshot: compactingAtSnapshot,
        message_count: retryHistory.length,
        payload_bytes: Buffer.byteLength(JSON.stringify(retryHistory)),
        messages: retryHistory,
      });
    } else {
      for (const msg of bufferedEvents) deliverLiveEvent(msg);
    }
    sendSafe(ws, {
      type: "command_guard_state",
      session_id: nextSessionId,
      ...(selectionId ? { selection_id: selectionId } : {}),
      ...getCommandGuardState(nextSessionId),
    });
    sendContextUsage(ws, nextSessionId, selectionId);

    wsProfile(nextSessionId, "attach_live_done", `duration=${elapsedMs(attachStart)}`);
    return true;
  };

  const setupSession = async (nextSessionId: string, selectionId: string | null) => {
    const setupStart = nowMs();
    const version = ++setupVersion;
    currentSessionId = nextSessionId;
    currentSelectionId = selectionId;
    ready = false;
    readyError = null;
    wsProfile(nextSessionId, "setup_start", `version=${version} since_connection=${elapsedMs(connectionStart)}`);
    cleanupSubscriptions();

    try {
      const lookupStart = nowMs();
      const sessionInfo = getSessionById(nextSessionId);
      wsProfile(nextSessionId, "setup_session_lookup", `duration=${elapsedMs(lookupStart)} found=${Boolean(sessionInfo)}`);
      if (!sessionInfo) throw new Error("Session not found");
      const quarantined = isLegacyPrivateSessionQuarantined(sessionInfo);
      if (!quarantined) {
        const authorization = authorizeProjectAction({
          cwd: sessionInfo.cwd,
          actor: "interactive",
          agentProfileId: sessionInfo.agent_profile_id,
        });
        if (!authorization.allowed) throw new Error(authorization.reason ?? "Session is no longer authorized");
      }

      // Mark the selected session ready before loading/parsing transcript
      // history. Large JSONL session files and Firefox websocket scheduling can
      // otherwise leave the UI in the yellow "connecting" state even though the
      // server has accepted the selection and can queue/send messages.
      sendSafe(ws, { type: "session_loading", session_id: nextSessionId, ...(selectionId ? { selection_id: selectionId } : {}) });
      wsProfile(nextSessionId, "sent_session_loading", `setup_elapsed=${elapsedMs(setupStart)}`);
      if (!quarantined) sendSafe(ws, serializeSessionRuntimeState(nextSessionId, selectionId));
      ready = true;
      sendSafe(ws, { type: "session_ready", session_id: nextSessionId, ...(selectionId ? { selection_id: selectionId } : {}) });
      wsProfile(nextSessionId, "sent_session_ready", `setup_elapsed=${elapsedMs(setupStart)}`);

      // External actions bind only to an exact, non-empty selection
      // generation. Legacy/invalid sockets without one can still read chat but
      // are never counted as interactive approvers.
      if (isExternalActionApprovalClientEligible(
        selectionId,
        quarantined,
        getRuntimeMutationSessionState(nextSessionId).mutation_locked,
      )) {
        // Register listeners before advertising this browser as interactive,
        // then publish an authoritative snapshot so a request cannot fall into
        // an attach/reconnect race.
        const actionBridge = getActionApprovalBridge();
        const actionSessionId = nextSessionId;
        const actionSelectionId = selectionId;
        const isCurrentActionSelection = () => (
          alive
          && version === setupVersion
          && currentSessionId === actionSessionId
          && currentSelectionId === actionSelectionId
        );
        const sendActionSnapshot = () => {
          if (!isCurrentActionSelection()) return;
          sendSafe(ws, {
            type: "external_action_snapshot",
            sessionId: actionSessionId,
            selection_id: actionSelectionId,
            requests: actionBridge.getPendingRequests(actionSessionId),
            syncComplete: true,
          });
        };
        const sendActionRequest = (request: ExternalActionRequest) => {
          if (!isCurrentActionSelection() || request.sessionId !== actionSessionId) return;
          // A different tab can resolve the request while listeners are being
          // notified. Never resurrect a request that is already terminal.
          const stillPending = actionBridge.getPendingRequests(actionSessionId).some((pending) => (
            pending.requestId === request.requestId
            && pending.argumentsHash === request.argumentsHash
          ));
          if (!stillPending) return;
          sendSafe(ws, {
            type: "external_action_request",
            requestId: request.requestId,
            sessionId: request.sessionId,
            selection_id: actionSelectionId,
            connector: request.connector,
            workspace: request.workspace,
            toolName: request.toolName,
            target: request.target,
            summary: request.summary,
            argumentsHash: request.argumentsHash,
            createdAt: request.createdAt,
            timeoutMs: request.timeoutMs,
          });
        };
        actionApprovalRequestUnsub = actionBridge.onRequest(sendActionRequest);
        actionApprovalTerminalUnsub = actionBridge.onTerminal((event) => {
          if (event.sessionId !== actionSessionId || !isCurrentActionSelection()) return;
          // Emit the explicit outcome first; the following snapshot is the
          // authoritative pending set and can never make timeout/cancellation
          // look like an approval.
          sendExternalActionTerminalState(
            ws,
            event,
            actionSelectionId,
            () => actionBridge.getPendingRequests(actionSessionId),
          );
        });
        actionApprovalDetach = actionBridge.attachClient(actionSessionId, actionApprovalClientId);
        sendActionSnapshot();
      }

      // Approval listeners must exist before a response queued during session
      // setup is dispatched, preserving terminal -> snapshot -> ack ordering.
      flushPending();

      // Subscribe to extension UI bridge requests for this session's project cwd.
      // This is cheap and does not require constructing a live AgentSession.
      if (sessionInfo.cwd && !quarantined) {
        const bridgeStart = nowMs();
        const deliveredInterviewRequestIds = new Set<string>();
        const sendInterviewRequest = (req: { requestId: string; sessionId: string; questions: unknown; createdAt: number }) => {
          // Only deliver to the WebSocket whose currently selected session
          // matches the request. This prevents an interview spawned by
          // session A from popping up in session B even when both share a
          // cwd. When the user switches away and later switches back, the
          // setup path below will replay any still-pending requests.
          if (req.sessionId !== currentSessionId) return;
          if (deliveredInterviewRequestIds.has(req.requestId)) return;
          deliveredInterviewRequestIds.add(req.requestId);
          sendSafe(ws, {
            type: "interview_request",
            requestId: req.requestId,
            sessionId: req.sessionId,
            questions: req.questions,
            createdAt: req.createdAt,
          });
        };

        const interviewBridge = getInterviewBridge();
        interviewBridgeUnsub = interviewBridge.onRequest((req) => {
          if (!alive || version !== setupVersion) return;
          sendInterviewRequest(req);
        });
        for (const req of interviewBridge.getPendingRequests(currentSessionId)) {
          sendInterviewRequest(req);
        }
        // Recovery closes the crash window after a durable submit but before
        // pi accepted its custom message. Open requests are replayed above;
        // completed forms are never reopened.
        void drainSubmittedInterviews(currentSessionId);

        const deliveredSudoRequestIds = new Set<string>();
        const sendSudoRequest = (req: SudoRequest) => {
          if (req.sessionId !== currentSessionId || deliveredSudoRequestIds.has(req.requestId)) return;
          deliveredSudoRequestIds.add(req.requestId);
          sendSafe(ws, {
            type: "sudo_request",
            requestId: req.requestId,
            sessionId: req.sessionId,
            prompt: req.prompt,
            kind: req.kind,
            command: req.command,
            executable: req.executable,
            argv: req.argv,
            cwd: req.cwd,
            timeoutMs: req.timeoutMs,
            origin: req.origin,
          });
        };

        const sudoBridge = getSudoBridge();
        sudoBridgeUnsub = sudoBridge.onRequest((req) => {
          if (!alive || version !== setupVersion) return;
          sendSudoRequest(req);
        });
        for (const req of sudoBridge.getPendingRequests(currentSessionId)) {
          sendSudoRequest(req);
        }

        const deliveredCommandGuardIdentityRequestIds = new Set<string>();
        const sendCommandGuardIdentityRequest = (req: CommandGuardIdentityRequest) => {
          // Shared identity challenges are valid only for the exact active
          // browser selection. Selectionless and stale setup generations must
          // never receive a challenge or later resolve its in-memory waiter.
          if (
            !selectionId
            || !alive
            || version !== setupVersion
            || req.sessionId !== currentSessionId
            || currentSelectionId !== selectionId
            || deliveredCommandGuardIdentityRequestIds.has(req.requestId)
          ) return;
          deliveredCommandGuardIdentityRequestIds.add(req.requestId);
          sendSafe(ws, {
            type: "command_guard_pin_request",
            requestId: req.requestId,
            sessionId: req.sessionId,
            selection_id: selectionId,
            prompt: req.prompt,
            command: req.command,
            reason: req.reason,
          });
        };

        const commandGuardIdentityBridge = getCommandGuardIdentityBridge();
        commandGuardIdentityBridgeUnsub = commandGuardIdentityBridge.onRequest((req) => {
          if (!alive || version !== setupVersion) return;
          sendCommandGuardIdentityRequest(req);
        });
        for (const req of commandGuardIdentityBridge.getPendingRequests(currentSessionId)) {
          sendCommandGuardIdentityRequest(req);
        }
        wsProfile(nextSessionId, "bridge_subscriptions_ready", `duration=${elapsedMs(bridgeStart)}`);
      }

      // Load history and attach optional live/file subscriptions after the ready
      // notification has had a chance to reach the browser.
      setImmediate(async () => {
        const deferredStart = nowMs();
        wsProfile(nextSessionId, "deferred_history_start", `since_setup_start=${elapsedMs(setupStart)}`);
        if (!alive || version !== setupVersion) return;
        try {
          // A live session subscribes before snapshot capture and emits exactly
          // one initial history payload for this selection generation.
          const attachedLive = quarantined
            ? false
            : await attachLiveSession(nextSessionId, version, false, selectionId, true);
          if (!alive || version !== setupVersion) return;
          if (!attachedLive) {
            const fileHistoryStart = nowMs();
            const snapshot = getSessionFileSnapshot(sessionInfo.pi_session_file, sessionInfo.cwd);
            const messages = snapshot?.messages ?? [];
            wsProfile(nextSessionId, "file_history_loaded", `duration=${elapsedMs(fileHistoryStart)} messages=${messages.length} hasFile=${Boolean(sessionInfo.pi_session_file)}`);
            const sendHistoryStart = nowMs();
            sendSafe(ws, {
              type: "history",
              session_id: nextSessionId,
              ...(selectionId ? { selection_id: selectionId } : {}),
              reason: "initial",
              message_count: messages.length,
              payload_bytes: snapshot?.payloadBytes ?? 0,
              messages,
            });
            sendSafe(ws, { ...(snapshot?.todoState ?? getSessionFileTodoState(sessionInfo.pi_session_file, sessionInfo.cwd)), session_id: nextSessionId, ...(selectionId ? { selection_id: selectionId } : {}) });
            sendSafe(ws, {
              type: "queued_message_snapshot",
              session_id: nextSessionId,
              ...(selectionId ? { selection_id: selectionId } : {}),
              messages: [],
            });
            wsProfile(nextSessionId, "sent_history", `duration=${elapsedMs(sendHistoryStart)} messages=${messages.length}`);
            // Catch-up is selected-session-only and starts after history is sent.
            // It reuses this parse; a second full parse is reserved for commit.
            if (!quarantined && snapshot?.autoTitle) {
              scheduleWayangAutoTitleFromActivation(nextSessionId, snapshot.autoTitle, {
                stillSelected: () => alive && version === setupVersion && currentSessionId === nextSessionId && currentSelectionId === selectionId,
                onCommitted: invalidateSessionFileSnapshot,
              });
            }
            startFilePoll(nextSessionId, sessionInfo.pi_session_file, sessionInfo.cwd, version, selectionId, !quarantined);
          } else if (!quarantined) {
            scheduleWayangAutoTitle(nextSessionId, {
              stillSelected: () => alive && version === setupVersion && currentSessionId === nextSessionId && currentSelectionId === selectionId,
              onCommitted: invalidateSessionFileSnapshot,
            });
          }
          if (!quarantined) sendContextUsage(ws, nextSessionId);
          wsProfile(nextSessionId, "deferred_history_done", `duration=${elapsedMs(deferredStart)}`);
        } catch (err: any) {
          if (!alive || version !== setupVersion) return;
          sendSafe(ws, {
            type: "session_error",
            session_id: nextSessionId,
            ...(selectionId ? { selection_id: selectionId } : {}),
            error: `Failed to load session history: ${err?.message || String(err)}`,
          });
        }
      });
    } catch (err: any) {
      if (!alive || version !== setupVersion) return;
      readyError = err?.message || String(err);
      wsProfile(nextSessionId, "setup_error", `duration=${elapsedMs(setupStart)} error=${readyError}`);
      const dropped = pendingMessages.splice(0);
      for (const pendingMessage of dropped) {
        sendCorrelatedClientFailure(nextSessionId, pendingMessage, `Session setup failed: ${readyError}`);
      }
      sendSafe(ws, {
        type: "session_error",
        session_id: nextSessionId,
        ...(selectionId ? { selection_id: selectionId } : {}),
        error: `Failed to load session: ${readyError}`,
      });
    }
  };

  const dispatchClientMessage = (msg: any) => {
    wsProfile(currentSessionId, "client_message", `type=${String(msg?.type || "unknown")} ready=${ready}`);
    if (msg.type === "switch_session") {
      const nextSessionId = msg.session_id;
      const nextSelectionId = typeof msg.selection_id === "string" ? msg.selection_id : null;
      if (!nextSessionId || typeof nextSessionId !== "string") return;
      wsProfile(nextSessionId, "switch_session_received", `from=${shortSessionId(currentSessionId)}`);
      if (nextSessionId === currentSessionId && ready && nextSelectionId === currentSelectionId) {
        wsProfile(nextSessionId, "switch_session_noop", "reason=same_session_ready");
        return;
      }

      // Drop any messages queued for the previous session; messages received
      // after this switch request will queue against the new session instead.
      pendingMessages.splice(0);
      setupSession(nextSessionId, nextSelectionId).catch((err) => {
        sendSafe(ws, { type: "error", error: err.message || String(err) });
      });
      return;
    }

    const durable = getSessionById(currentSessionId);
    if (durable && isLegacyPrivateSessionQuarantined(durable)) {
      const error = "Quarantined legacy sessions are view-only";
      sendCorrelatedClientFailure(currentSessionId, msg, error);
      sendSafe(ws, { type: "error", error });
      return;
    }

    if (readyError) {
      const error = `Session is not ready: ${readyError}`;
      sendCorrelatedClientFailure(currentSessionId, msg, error);
      sendSafe(ws, { type: "error", error });
      return;
    }

    if (!ready) {
      if (msg.type === "message" && typeof msg.content === "string") touchSession(currentSessionId);
      pendingMessages.push(msg);
      wsProfile(currentSessionId, "client_message_queued", `type=${String(msg?.type || "unknown")} queueLength=${pendingMessages.length}`);
      return;
    }

    // Route extension UI bridge responses directly to their bridges.
    if (msg.type === "external_action_response") {
      void handleExternalActionResponse(ws, currentSessionId, currentSelectionId, msg);
      return;
    }

    if (msg.type === "interview_response") {
      handleInterviewResponse(ws, currentSessionId, msg, submissionContext);
      return;
    }

    if (msg.type === "interview_cancel") {
      handleInterviewCancel(ws, currentSessionId, msg);
      return;
    }

    if (msg.type === "sudo_response") {
      handleSudoResponse(currentSessionId, msg);
      return;
    }

    if (msg.type === "command_guard_pin_response") {
      handleCommandGuardPinResponse(currentSessionId, currentSelectionId, msg);
      return;
    }

    handleClientMessage(ws, currentSessionId, currentSelectionId, msg, async () => {
      await attachLiveSession(currentSessionId, setupVersion, true, currentSelectionId, false);
    });
  };

  runtimeEventUnsub = onPiSessionRuntimeEvent((event) => {
    if (!alive || event.sessionId !== currentSessionId) return;
    const durable = getSessionById(currentSessionId);
    if (!durable || isLegacyPrivateSessionQuarantined(durable)) return;
    if (event.type === "runtime_state_changed") {
      sendSafe(ws, serializeSessionRuntimeState(currentSessionId, currentSelectionId));
      return;
    }
    if (event.type === "agent_switched") {
      setupSession(currentSessionId, currentSelectionId).catch((err) => {
        sendSafe(ws, { type: "error", error: err.message || String(err) });
      });
    }
  });

  setupSession(sessionId, initialSelectionId).catch((err) => {
    sendSafe(ws, { type: "error", error: err.message || String(err) });
  });

  ws.on("message", (raw) => {
    if (!alive) return;

    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    dispatchClientMessage(msg);
  });

  ws.on("close", (code, reason) => {
    wsProfile(currentSessionId, "socket_close", `code=${code} reason=${reason.toString()} lifetime=${elapsedMs(connectionStart)}`);
    alive = false;
    cleanupSubscriptions();
    runtimeEventUnsub?.();
    runtimeEventUnsub = null;
  });

  ws.on("error", (err) => {
    wsProfile(currentSessionId, "socket_error", `error=${err instanceof Error ? err.message : String(err)} lifetime=${elapsedMs(connectionStart)}`);
    alive = false;
    cleanupSubscriptions();
    runtimeEventUnsub?.();
    runtimeEventUnsub = null;
  });
}

async function getOrCreatePiSession(id: string): Promise<void> {
  const session = getSessionById(id);
  if (!session) throw new Error("Session not found in DB");
  if (isLegacyPrivateSessionQuarantined(session)) {
    throw new Error("Quarantined legacy sessions cannot start a runtime");
  }

  const existing = getPiSession(id);
  if (existing) return;

  let handle: PiSessionHandle;
  try {
    handle = await createPiSession(
      id,
      session.cwd,
      session.provider || null,
      session.model || null,
      session.pi_session_file,
    );
  } catch (error) {
    logSessionRuntimeStartFailure({ source: "websocket", sessionId: id, error });
    throw error;
  }
  ensureInteractiveCommandGuardEnabled(id, "websocket-created pi session");
  if (handle.sessionFile && !session.pi_session_file) updatePiSessionFile(id, handle.sessionFile);
}

function parseSlashCommand(content: string): { name: string; args: string } | null {
  if (!content.startsWith("/") || content.startsWith("//")) return null;
  const trimmed = content.trim();
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1], args: match[2] ?? "" };
}

function sendCommandNotice(ws: WebSocket, content: string): void {
  sendSafe(ws, {
    type: "custom",
    message: {
      role: "custom",
      customType: "slash-command",
      content,
    },
  });
}

async function handleBuiltinSlashCommand(ws: WebSocket, sessionId: string, content: string): Promise<boolean> {
  const parsed = parseSlashCommand(content);
  if (!parsed) return false;

  const durable = getSessionById(sessionId);
  if (durable && isLegacyPrivateSessionQuarantined(durable)) {
    // Deny before looking up a live handle: every built-in, extension command,
    // prompt template, and skill is unavailable to quarantined sessions.
    sendSafe(ws, { type: "error", error: "Commands are unavailable for quarantined legacy sessions" });
    return true;
  }

  const handle = getPiSession(sessionId);
  if (!handle) return false;

  switch (parsed.name) {
    case "model": {
      const modelRef = parsed.args.trim().split(/\s+/, 1)[0] ?? "";
      if (!modelRef) {
        sendSafe(ws, { type: "error", error: "Usage: /model provider/model" });
        return true;
      }
      const slashIndex = modelRef.indexOf("/");
      if (slashIndex <= 0 || slashIndex === modelRef.length - 1) {
        sendSafe(ws, { type: "error", error: "Usage: /model provider/model" });
        return true;
      }
      const provider = modelRef.slice(0, slashIndex);
      const model = modelRef.slice(slashIndex + 1);
      const selected = await setSessionModel(sessionId, provider, model);
      sendCommandNotice(ws, `Model set to ${selected.provider}/${selected.model}`);
      sendSafe(ws, { type: "command_guard_state", ...getCommandGuardState(sessionId) });
      return true;
    }

    case "name": {
      const name = parsed.args.trim();
      if (!name) {
        sendSafe(ws, { type: "error", error: "Usage: /name <name>" });
        return true;
      }
      persistManualSessionTitle(sessionId, name, (canonicalName) => {
        handle.session.setSessionName(canonicalName);
      });
      sendCommandNotice(ws, `Session name set to ${name}`);
      return true;
    }

    case "session": {
      const stats = handle.session.getSessionStats();
      sendCommandNotice(
        ws,
        [
          `Session: ${stats.sessionId}`,
          stats.sessionFile ? `File: ${stats.sessionFile}` : undefined,
          `Messages: ${stats.totalMessages} (${stats.userMessages} user, ${stats.assistantMessages} assistant)`,
          `Tool calls: ${stats.toolCalls}; tool results: ${stats.toolResults}`,
          `Tokens: ${stats.tokens.total} total; cost: $${stats.cost.toFixed(4)}`,
        ].filter(Boolean).join("\n"),
      );
      return true;
    }

    case "compact": {
      sendCommandNotice(ws, "Compacting session context…");
      handle.session.compact(parsed.args.trim() || undefined)
        .then(() => {
          sendCommandNotice(ws, "Compaction complete.");
          sendContextUsage(ws, sessionId);
        })
        // AgentSession emits the authoritative structured compaction_end event,
        // including a bounded failure message. Avoid a second generic error.
        .catch(() => {});
      return true;
    }

    case "export": {
      const outputPath = parsed.args.trim() || undefined;
      const exportedPath = outputPath?.endsWith(".jsonl")
        ? handle.session.exportToJsonl(outputPath)
        : await handle.session.exportToHtml(outputPath);
      sendCommandNotice(ws, `Exported session to ${exportedPath}`);
      return true;
    }

    case "reload": {
      await handle.session.reload();
      sendCommandNotice(ws, "Reloaded settings, extensions, skills, prompts, and context files.");
      return true;
    }

    default:
      return false;
  }
}

function safeSessionError(sessionId: string, error: unknown, prefix = ""): string {
  const row = getSessionById(sessionId);
  if (row && isLegacyPrivateSessionQuarantined(row)) return "Quarantined legacy session operation denied";
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}${message}`;
}

function optionalClientMessageId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error("client_message_id is invalid");
  }
  return value;
}

function requiredClientMessageId(value: unknown): string {
  const clientMessageId = optionalClientMessageId(value);
  if (!clientMessageId) throw new Error("cancel_queued_message requires client_message_id");
  return clientMessageId;
}

function queuedAttachmentNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((attachment) => (
    attachment && typeof attachment === "object" && typeof attachment.name === "string"
      ? attachment.name.trim().slice(0, 120) || "attachment"
      : "attachment"
  ));
}

async function handleClientMessage(
  ws: WebSocket,
  sessionId: string,
  selectionId: string | null,
  msg: any,
  ensureLiveSession: () => Promise<void>,
): Promise<void> {
  try {
    const row = getSessionById(sessionId);
    if (!row) throw new Error("Session not found");
    if (isLegacyPrivateSessionQuarantined(row)) {
      throw new Error("Quarantined legacy sessions are view-only");
    }
    const authorization = authorizeProjectAction({
      cwd: row.cwd,
      actor: "interactive",
      agentProfileId: row.agent_profile_id,
    });
    if (!authorization.allowed) throw new Error(authorization.reason ?? "Session is no longer authorized");

    switch (msg.type) {
      case "message": {
        const rawContent = typeof msg.content === "string" ? msg.content : "";
        const trimmedContent = rawContent.trim();
        const clientMessageId = optionalClientMessageId(msg.client_message_id);
        const preparedAttachments = prepareAttachments(sessionId, msg.attachments);
        const acceptedAt = Date.now();
        if (!trimmedContent && preparedAttachments.count === 0) return;

        touchSession(sessionId);

        try {
          await ensureLiveSession();
          updateSessionError(sessionId, null);
        } catch (err: any) {
          throw new Error(safeSessionError(sessionId, err, "Failed to start pi session: "));
        }

        if (trimmedContent && await handleBuiltinSlashCommand(ws, sessionId, trimmedContent)) {
          if (clientMessageId) {
            sendSafe(ws, {
              type: "queued_message_ack",
              session_id: sessionId,
              client_message_id: clientMessageId,
              status: "accepted",
              cancellable: false,
            });
          }
          break;
        }

        const attachmentNotes = preparedAttachments.notes.join("\n");
        const contentWithAttachments = attachmentNotes
          ? trimmedContent
            ? `${trimmedContent}\n\n${attachmentNotes}`
            : attachmentNotes
          : trimmedContent;

        // If we have a goal set, prepend instructions. Slash commands that are
        // handled by AgentSession itself (extension commands, prompt templates,
        // /skill:name) must stay exact, so do not decorate slash-prefixed input.
        const session = getSessionById(sessionId);
        let fullContent = contentWithAttachments;
        if (!trimmedContent.startsWith("/") && session?.goal && session.goal_status === "pending") {
          fullContent = `[Goal: ${session.goal}] Working toward this goal.\n\n${contentWithAttachments}`;
        }

        sendMessage(
          sessionId,
          fullContent,
          preparedAttachments.images.length > 0 ? preparedAttachments.images : undefined,
          clientMessageId,
          {
            content: trimmedContent,
            attachmentNames: queuedAttachmentNames(msg.attachments),
            rawUserText: rawContent,
            provisionalTitleText: trimmedContent || (preparedAttachments.count > 0 ? "File attachment" : rawContent),
            acceptedAt,
          },
        ).then((result) => {
          if (clientMessageId) {
            sendSafe(ws, {
              type: "queued_message_ack",
              session_id: sessionId,
              client_message_id: clientMessageId,
              status: result.queued ? "queued" : "accepted",
              cancellable: result.cancellable,
            });
          }
        }).catch((err) => {
          const error = safeSessionError(sessionId, err, "Agent turn failed: ");
          updateSessionError(sessionId, error);
          if (clientMessageId) {
            sendSafe(ws, {
              type: "queued_message_ack",
              session_id: sessionId,
              client_message_id: clientMessageId,
              status: "rejected",
              error,
            });
          }
          sendSafe(ws, { type: "error", session_id: sessionId, ...(selectionId ? { selection_id: selectionId } : {}), error });
        });
        break;
      }

      case "cancel_queued_message": {
        const clientMessageId = requiredClientMessageId(msg.client_message_id);
        try {
          const cancelled = cancelQueuedBrowserMessage(sessionId, clientMessageId);
          sendSafe(ws, {
            type: "queued_message_cancel_ack",
            session_id: sessionId,
            client_message_id: clientMessageId,
            status: cancelled ? "cancelled" : "not_found",
          });
        } catch (error) {
          sendSafe(ws, {
            type: "queued_message_cancel_ack",
            session_id: sessionId,
            client_message_id: clientMessageId,
            status: "error",
            error: safeSessionError(sessionId, error, "Could not cancel queued message: "),
          });
        }
        break;
      }

      case "resend": {
        const messageId = typeof msg.message_id === "string" ? msg.message_id : "";
        if (!messageId) throw new Error("resend requires message_id");

        try {
          await ensureLiveSession();
          updateSessionError(sessionId, null);
        } catch (err: any) {
          throw new Error(safeSessionError(sessionId, err, "Failed to start pi session: "));
        }

        const result = await resendMessage(sessionId, messageId);
        touchSession(sessionId);
        sendSafe(ws, {
          type: "history",
          session_id: sessionId,
          ...(selectionId ? { selection_id: selectionId } : {}),
          messages: result.messages,
        });
        sendSafe(ws, { ...getTodoState(sessionId), session_id: sessionId, ...(selectionId ? { selection_id: selectionId } : {}) });
        sendContextUsage(ws, sessionId, selectionId);

        result.turn.catch((err) => {
          const error = safeSessionError(sessionId, err, "Agent turn failed: ");
          updateSessionError(sessionId, error);
          sendSafe(ws, { type: "error", session_id: sessionId, ...(selectionId ? { selection_id: selectionId } : {}), error });
          sendSafe(ws, {
            type: "history",
            session_id: sessionId,
            ...(selectionId ? { selection_id: selectionId } : {}),
            messages: getMessageHistory(sessionId),
          });
        });
        break;
      }

      case "interrupt": {
        // Cancel approval waiters first. In particular, an approval can remain
        // pending briefly after a Pi turn settles even when no live handle is
        // visible to this transport.
        getActionApprovalBridge().cancelSession(sessionId, "session interrupted");
        if (getPiSession(sessionId)) {
          abortSession(sessionId, { clearQueue: msg.clear_queue !== false }).catch(() => {});
        }
        break;
      }

      case "set_goal": {
        const { goal, status } = msg;
        updateGoal(sessionId, goal ?? null, status ?? null);
        sendSafe(ws, {
          type: "goal_update",
          session_id: sessionId,
          ...(selectionId ? { selection_id: selectionId } : {}),
          goal,
          status: status || "pending",
        });
        break;
      }

      case "command_guard": {
        await ensureLiveSession();
        const mode = normalizeCommandGuardMode(msg.mode);
        const state = mode
          ? setCommandGuardMode(sessionId, mode, { announce: msg.announce !== false, pin: typeof msg.pin === "string" ? msg.pin : undefined })
          : getCommandGuardState(sessionId);
        sendSafe(ws, { type: "command_guard_state", session_id: sessionId, ...(selectionId ? { selection_id: selectionId } : {}), ...state });
        break;
      }

      case "set_permission": {
        // For now, permissions are handled by pi itself
        // Future: could integrate with pi extension permission gates
        break;
      }

      default:
        // Unknown message type, ignore
        break;
    }
  } catch (err: any) {
    const error = safeSessionError(sessionId, err);
    let cancellationId: string | undefined;
    if (msg?.type === "cancel_queued_message") {
      try { cancellationId = optionalClientMessageId(msg.client_message_id); }
      catch { /* malformed IDs cannot receive a correlated acknowledgement */ }
    }
    if (cancellationId) {
      sendSafe(ws, {
        type: "queued_message_cancel_ack",
        session_id: sessionId,
        client_message_id: cancellationId,
        status: "error",
        error: `Could not cancel queued message: ${error}`,
      });
      return;
    }
    let messageId: string | undefined;
    if (msg?.type === "message") {
      try { messageId = optionalClientMessageId(msg.client_message_id); }
      catch { /* malformed IDs receive only the generic protocol error */ }
    }
    if (messageId) {
      sendSafe(ws, {
        type: "queued_message_ack",
        session_id: sessionId,
        client_message_id: messageId,
        status: "rejected",
        error,
      });
    }
    updateSessionError(sessionId, error);
    sendSafe(ws, { type: "error", session_id: sessionId, ...(selectionId ? { selection_id: selectionId } : {}), error });
  }
}

function normalizeCommandGuardMode(value: unknown): CommandGuardMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "on" || normalized === "enable" || normalized === "enabled") return "balanced";
  if (["off", "audit", "balanced", "strict"].includes(normalized)) return normalized as CommandGuardMode;
  return null;
}

/**
 * Persist the response before waking a live waiter or injecting pi context.
 * The acknowledgement is the browser durability boundary and is sent for both
 * first submit and same-payload retries.
 */
/** @internal Exported for focused durable acknowledgement contract tests. */
export function handleInterviewResponse(
  ws: WebSocket,
  sessionId: string,
  msg: any,
  submissionContext: InterviewSubmissionContext,
): void {
  const requestId = typeof msg?.requestId === "string" ? msg.requestId : "";
  if (getRuntimeMutationSessionState(sessionId).mutation_locked) {
    sendSafe(ws, { type: "interview_response_ack", requestId: requestId || null, sessionId, status: "rejected", errorCode: "session_busy", error: "Session is reserved for a headless turn" });
    return;
  }
  if (!requestId || !Array.isArray(msg?.answers)) {
    sendSafe(ws, { type: "interview_response_ack", requestId: requestId || null, sessionId, status: "rejected", errorCode: "invalid_answers", error: "requestId and answers are required" });
    return;
  }

  let submitted: ReturnType<typeof submitInterview>;
  try {
    submitted = submitInterview(sessionId, requestId, msg.answers, submissionContext);
  } catch {
    sendSafe(ws, {
      type: "interview_response_ack",
      requestId,
      sessionId,
      status: "rejected",
      errorCode: "persistence_failed",
      error: "Response could not be persisted. Retry when ready.",
    });
    return;
  }
  if (!submitted.ok) {
    sendSafe(ws, { type: "interview_response_ack", requestId, sessionId, status: "rejected", errorCode: submitted.code, error: submitted.message });
    return;
  }

  const record = submitted.record;
  const resolvedLiveWaiter = getInterviewBridge().resolveSubmitted(record);
  if (resolvedLiveWaiter) {
    void (async () => {
      try {
        const timeoutMs = record.origin_tool_call_id ? 30_000 : 2_000;
        if (await confirmInterviewToolResultDelivery(record, { timeoutMs })) return;
      } catch {
        // Fall through to bounded custom-message recovery.
      }
      await retrySubmittedInterviewDelivery(record);
    })().catch((error) => {
      console.warn(`[interviews] delivery retained for request ${requestId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  } else if (record.status === "submitted") {
    // Do not await delivery: receipt has already been made durable and the
    // dispatcher retains failures after bounded immediate retries, with later
    // WebSocket/startup drains providing another recovery opportunity.
    void retrySubmittedInterviewDelivery(record).catch((error) => {
      console.warn(`[interviews] delivery retained for request ${requestId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  const currentStatus = record.status;
  sendSafe(ws, {
    type: "interview_response_ack",
    requestId,
    sessionId,
    submissionId: record.submission_id,
    status: currentStatus,
    duplicate: submitted.kind === "duplicate",
  });
}

/** @internal Exported for focused exact cancellation-ack contract tests. */
export function handleInterviewCancel(ws: WebSocket, sessionId: string, msg: any): void {
  const requestId = typeof msg?.requestId === "string" ? msg.requestId : "";
  if (getRuntimeMutationSessionState(sessionId).mutation_locked) {
    sendSafe(ws, { type: "interview_cancel_ack", requestId: requestId || null, sessionId, status: "rejected", errorCode: "session_busy" });
    return;
  }
  if (!requestId) {
    sendSafe(ws, { type: "interview_cancel_ack", requestId: null, sessionId, status: "rejected", errorCode: "not_found", error: "Interview request was not found or is no longer open" });
    return;
  }
  let cancelled: ReturnType<typeof cancelInterview>;
  try {
    cancelled = cancelInterview(sessionId, requestId);
  } catch {
    // The form remains authoritative until this exact terminal rejection. Do
    // not expose store paths or persistence diagnostics over the transport.
    sendSafe(ws, {
      type: "interview_cancel_ack",
      requestId,
      sessionId,
      status: "rejected",
      errorCode: "persistence_failed",
      error: "Cancellation could not be persisted. Retry when ready.",
    });
    return;
  }
  if (!cancelled) {
    const existing = getInterviewForSession(sessionId, requestId);
    if (existing?.status === "cancelled") {
      sendSafe(ws, { type: "interview_cancel_ack", requestId, sessionId, status: "cancelled", duplicate: true });
      return;
    }
    sendSafe(ws, { type: "interview_cancel_ack", requestId, sessionId, status: "rejected", errorCode: "not_found", error: "Interview request was not found or is no longer open" });
    return;
  }
  getInterviewBridge().cancel(requestId);
  sendSafe(ws, { type: "interview_cancel_ack", requestId, sessionId, status: "cancelled", duplicate: false });
}

/**
 * Resolve only an exact request/session/selection/hash tuple and acknowledge
 * every response. respondForSession emits terminal listeners synchronously, so
 * each attached socket's authoritative terminal snapshot is queued before this
 * submitting socket's acknowledgement. Frontends reconcile from that snapshot;
 * the later ack is secondary status confirmation.
 */
/** @internal Exported for focused untrusted transport tests. */
export async function handleExternalActionResponse(
  ws: WebSocket,
  currentSessionId: string,
  currentSelectionId: string | null,
  msg: any,
  actionBridge: ActionApprovalBridge = getActionApprovalBridge(),
): Promise<void> {
  const requestId: unknown = msg?.requestId;
  const sessionId: unknown = msg?.sessionId;
  const selectionId: unknown = msg?.selection_id;
  const argumentsHash: unknown = msg?.argumentsHash;
  const approved: unknown = msg?.approved;

  let response: ApprovalResponse = {
    status: "rejected",
    errorCode: typeof approved === "boolean" ? "request_identity_mismatch" : "invalid_decision",
  };
  if (
    typeof requestId === "string"
    && typeof sessionId === "string"
    && typeof selectionId === "string"
    && typeof argumentsHash === "string"
    && typeof approved === "boolean"
    && requestId.length > 0
    && sessionId.length > 0
    && selectionId.length > 0
    && argumentsHash.length > 0
    && currentSelectionId !== null
    && !getRuntimeMutationSessionState(sessionId).mutation_locked
    && sessionId === currentSessionId
    && selectionId === currentSelectionId
  ) {
    response = await actionBridge.respondForSession(
      sessionId,
      requestId,
      argumentsHash,
      approved,
      msg?.pin,
    );
  }

  sendSafe(ws, {
    type: "external_action_response_ack",
    requestId: typeof requestId === "string" && requestId.length > 0 ? requestId : null,
    sessionId: typeof sessionId === "string" ? sessionId : null,
    selection_id: typeof selectionId === "string" ? selectionId : null,
    status: response.status,
    ...(response.errorCode ? { errorCode: response.errorCode } : {}),
    ...(response.retryAt === undefined ? {} : { retryAt: response.retryAt }),
  });
}

/**
 * Handle sudo_response from frontend. Passwords are passed directly to the
 * in-memory bridge and are never logged or persisted by the websocket layer.
 */
function handleSudoResponse(sessionId: string, msg: any): void {
  const { requestId } = msg;
  if (getRuntimeMutationSessionState(sessionId).mutation_locked) return;
  if (!requestId || typeof requestId !== "string") return;

  const bridge = getSudoBridge();
  if (msg.cancelled) {
    bridge.approveForSession(sessionId, requestId, false) || bridge.resolveForSession(sessionId, requestId, null);
    return;
  }

  if (typeof msg.approved === "boolean") {
    bridge.approveForSession(sessionId, requestId, msg.approved);
    return;
  }

  bridge.resolveForSession(sessionId, requestId, typeof msg.password === "string" ? msg.password : null);
}

/** Handle command_guard_pin_response without logging or persisting PIN values. */
function handleCommandGuardPinResponse(
  sessionId: string,
  currentSelectionId: string | null,
  msg: any,
): void {
  if (getRuntimeMutationSessionState(sessionId).mutation_locked) return;
  const requestId = typeof msg?.requestId === "string" ? msg.requestId : "";
  const responseSessionId = typeof msg?.sessionId === "string" ? msg.sessionId : "";
  const responseSelectionId = typeof msg?.selection_id === "string" ? msg.selection_id : "";
  if (
    !requestId
    || !responseSessionId
    || !responseSelectionId
    || !currentSelectionId
    || responseSessionId !== sessionId
    || responseSelectionId !== currentSelectionId
  ) return;

  // Validate the complete wire binding before obtaining or touching the
  // in-memory bridge. Missing/stale responses cannot consume a live waiter.
  const bridge = getCommandGuardIdentityBridge();
  if (msg.cancelled) {
    bridge.resolveForSession(sessionId, requestId, null);
    return;
  }

  bridge.resolveForSession(sessionId, requestId, typeof msg.pin === "string" ? msg.pin : null);
}

export function shouldReconcileLiveSessionState(msg: SerializedMessage): boolean {
  return msg.type === "agent_settled"
    || (msg.type === "compaction_end" && msg.succeeded === true);
}

function sendContextUsage(ws: WebSocket, sessionId: string, selectionId?: string | null): void {
  const handle = getPiSession(sessionId);
  if (!handle) return;
  const usage = handle.session.getContextUsage();
  if (!usage) return;
  sendSafe(ws, {
    type: "context_usage",
    session_id: sessionId,
    ...(selectionId ? { selection_id: selectionId } : {}),
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
    percent: usage.percent,
  });
}

function sendSafe(ws: WebSocket, msg: any): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      const startedAt = msg?.type === "history" ? performance.now() : 0;
      const serialized = JSON.stringify(msg);
      if (startedAt) recordLatencyMetric("history_stringify_ms", performance.now() - startedAt);
      ws.send(serialized);
    }
  } catch {
    // Client disconnected
  }
}
