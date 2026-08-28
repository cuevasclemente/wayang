import { Router, type Request, type Response } from "express";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSession, listSessions, syncPiSessionFiles, persistManualSessionTitle, archiveSession, deleteSession, getSessionById, updateGoal, getSessionCatalogGeneration, getSessionCatalogStatus, onSessionCatalogGeneration, validateManualSessionTitle, type SessionRow } from "../sessions.js";
import { classifyAssistantErrorKind, getPiSession, getPiSessionBashMode, getPiSessionBrowserAgentDiagnostic, getPiSessionBrowserMode, getPiSessionRuntimeState, getRuntimeMutationSessionState, invalidateSessionFileSnapshot, listModels, listSlashCommands, previewSessionAgentSwitch, setSessionDefaultModel, setSessionModel, stopPiSession, switchSessionAgent } from "../pi-bridge.js";
import {
  indexSession as forceIndexSession,
  removeSession as removeSearchSession,
} from "../search/indexer.js";
import { recordLatencyMetric } from "../latency-metrics.js";
import { listHumanAttentionForSession, type HumanAttentionSummary } from "../human-attention.js";
import type { Session as ProtocolSession } from "@wayang/protocol";
import {
  acquireSessionRuntimeMutationLock,
  isSessionRuntimeMutationLocked,
  releaseSessionRuntimeMutationLock,
} from "../session-runtime-mutation-lock.js";
import { validateSessionDeletionPinAttempt } from "../transcript-mutations.js";
import { invalidateTranscriptPaginationSession } from "../transcript-pagination/service.js";
import { classifySessionPrivacy } from "../session-interop.js";
import {
  cancelManualTitleGeneration,
  enqueueManualTitleGeneration,
  getManualTitleGeneration,
  ManualTitleGenerationError,
  type ManualTitleGenerationProjection,
} from "../manual-title-generation.js";

export const router = Router();

type SessionResponse = ProtocolSession & SessionRow & ReturnType<typeof getPiSessionRuntimeState> & {
  bash_mode: ReturnType<typeof getPiSessionBashMode>;
  browser_mode: ReturnType<typeof getPiSessionBrowserMode>;
  browser_agent: ReturnType<typeof getPiSessionBrowserAgentDiagnostic>;
  error_kind: ReturnType<typeof classifyAssistantErrorKind>;
  humanAttention: HumanAttentionSummary[];
  title_generation: ManualTitleGenerationProjection;
};

/** @internal Exported for focused response-projection tests. */
export function serializeSession(session: SessionRow): SessionResponse {
  const error = classifySessionPrivacy(session) === "protected" && session.error
    ? "Protected session error; open the Protected session for details"
    : session.error;
  return {
    ...session,
    error,
    ...getPiSessionRuntimeState(session.id),
    bash_mode: getPiSessionBashMode(session.id),
    browser_mode: getPiSessionBrowserMode(session.id, session),
    browser_agent: getPiSessionBrowserAgentDiagnostic(session.id, session),
    error_kind: classifyAssistantErrorKind(error),
    humanAttention: listHumanAttentionForSession(session.id),
    title_generation: getManualTitleGeneration(session.id),
  };
}

// ---------------------------------------------------------------------------
// List models
// ---------------------------------------------------------------------------

router.get("/models", async (req: Request, res: Response) => {
  try {
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    res.json(await listModels({ refresh }));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// List sessions
// ---------------------------------------------------------------------------

router.get("/sessions", (_req: Request, res: Response) => {
  const start = performance.now();
  res.once("finish", () => recordLatencyMetric("sessions_list_finish_ms", performance.now() - start));
  try {
    // Pure cached snapshot: discovery and transcript parsing are owned by the
    // backend catalog lifecycle and never initiated by this request.
    res.setHeader("X-Wayang-Catalog-Generation", String(getSessionCatalogGeneration()));
    res.json(listSessions().map(serializeSession));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/sessions/catalog/health", (_req: Request, res: Response) => {
  try { res.json(getSessionCatalogStatus()); }
  catch { res.status(500).json({ error: "Session catalog status is unavailable" }); }
});

router.get("/sessions/events", (req: Request, res: Response) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = (generation: number) => res.write(`event: catalog_generation\ndata: ${JSON.stringify({ generation })}\n\n`);
  send(getSessionCatalogGeneration());
  const unsubscribe = onSessionCatalogGeneration(send);
  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 25_000);
  heartbeat.unref?.();
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Import canonical pi session files
// ---------------------------------------------------------------------------

router.post("/sessions/import", async (_req: Request, res: Response) => {
  try {
    const result = await syncPiSessionFiles();
    res.json({ ...result, sessions: listSessions().map(serializeSession) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Create session
// ---------------------------------------------------------------------------

router.post("/sessions", async (req: Request, res: Response) => {
  try {
    const { cwd, title, model, provider, agent_profile_id } = req.body;
    if (!cwd || typeof cwd !== "string") {
      res.status(400).json({ error: "cwd is required" });
      return;
    }

    // Create only the lightweight DB record. Opening/selecting a session is
    // read-only; the live pi AgentSession is started lazily when the first
    // human/agent message is sent.
    if (agent_profile_id !== undefined && typeof agent_profile_id !== "string") {
      res.status(400).json({ error: "agent_profile_id must be a string" });
      return;
    }
    // Older frontend clients represented an omitted provisional title as the
    // empty string. Preserve that wire compatibility without accepting other
    // blank manual titles (for example whitespace-only names).
    const requestedTitle = title === "" ? undefined : title;
    if (requestedTitle !== undefined) validateManualSessionTitle(requestedTitle);
    const session = createSession(cwd, {
      title: requestedTitle,
      model: model || undefined,
      provider: provider || undefined,
      agentProfileId: agent_profile_id,
    });

    res.status(201).json(serializeSession(session));
  } catch (err: any) {
    res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// Slash commands for a session
// ---------------------------------------------------------------------------

router.get("/sessions/:id/slash-commands", async (req: Request, res: Response) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Listing slash commands must stay read-only. If the session is not live,
    // listSlashCommands returns the web-supported built-ins without constructing
    // an AgentSession just because the chat was opened.
    res.json({ commands: await listSlashCommands(session.id) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Get session
// ---------------------------------------------------------------------------

router.get("/sessions/:id", (req: Request, res: Response) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(serializeSession(session));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Update session title
// ---------------------------------------------------------------------------

/** @internal Shared lock projection for focused route race tests. */
export function isSessionTitleWriteAllowed(sessionId: string): boolean {
  return !isSessionRuntimeMutationLocked(sessionId);
}

export function writeStoppedPiSessionName(session: SessionRow, name: string): void {
  if (!session.pi_session_file) return;
  SessionManager.open(session.pi_session_file, undefined, session.cwd).appendSessionInfo(name);
}

router.put("/sessions/:id/title", (req: Request, res: Response) => {
  try {
    const title = validateManualSessionTitle(req.body?.title);
    const session = getSessionById(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!isSessionTitleWriteAllowed(session.id)) {
      res.status(409).json({ error: "Session transcript mutation is in progress" });
      return;
    }
    const live = getPiSession(session.id);
    const writePiName = live
      ? (name: string) => live.session.setSessionName(name)
      : session.pi_session_file
        ? (name: string) => writeStoppedPiSessionName(session, name)
        : undefined;
    persistManualSessionTitle(session.id, title, writePiName);
    cancelManualTitleGeneration(session.id, "title_changed");
    res.status(204).end();
  } catch (err: any) {
    res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// Explicit Terra title generation
// ---------------------------------------------------------------------------

function manualTitleGenerationBusy(sessionId: string): boolean {
  const mutation = getRuntimeMutationSessionState(sessionId);
  const runtime = getPiSessionRuntimeState(sessionId);
  return mutation.runtime_status === "starting"
    || mutation.streaming
    || mutation.queued
    || mutation.mutation_locked
    || runtime.runtime_is_compacting;
}

router.post("/sessions/:id/title-generation", (req: Request, res: Response) => {
  try {
    if (typeof req.body?.expected_title !== "string") {
      res.status(400).json({ error: "expected_title is required", code: "invalid_request" });
      return;
    }
    const result = enqueueManualTitleGeneration(
      req.params.id,
      { expectedTitle: req.body.expected_title },
      {
        isBusy: manualTitleGenerationBusy,
        onCommitted: invalidateSessionFileSnapshot,
      },
    );
    res.status(202).json(result);
  } catch (err: any) {
    if (err instanceof ManualTitleGenerationError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: "Title generation could not be queued", code: "title_generation_failed" });
  }
});

router.get("/sessions/:id/title-generation", (req: Request, res: Response) => {
  if (!getSessionById(req.params.id)) {
    res.status(404).json({ error: "Session not found", code: "session_not_found" });
    return;
  }
  res.json(getManualTitleGeneration(req.params.id));
});

// ---------------------------------------------------------------------------
// Archive session
// ---------------------------------------------------------------------------

router.delete("/sessions/:id", async (req: Request, res: Response) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!isSessionTitleWriteAllowed(session.id)) {
      res.status(409).json({ error: "Session transcript mutation is in progress" });
      return;
    }
    cancelManualTitleGeneration(session.id);
    archiveSession(req.params.id);
    await stopPiSession(req.params.id, { kind: "close_session", reason: "archive" });
    res.status(204).end();
  } catch (err: any) {
    res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// Delete session (requires command guard identity PIN)
// ---------------------------------------------------------------------------

/** @internal Rebuild logically purged search only while canonical row/file remain. */
export async function recoverSearchAfterFailedSessionDelete(
  sessionId: string,
  index: typeof forceIndexSession = forceIndexSession,
): Promise<boolean> {
  if (!getSessionById(sessionId)) return false;
  try {
    const result = await index(sessionId, { force: true });
    return !result.error;
  } catch {
    return false;
  }
}

router.post("/sessions/:id/delete", async (req: Request, res: Response) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    if (!isSessionTitleWriteAllowed(session.id)) {
      res.status(409).json({ error: "Session transcript mutation is in progress" });
      return;
    }

    if (!acquireSessionRuntimeMutationLock(session.id)) {
      res.status(409).json({ error: "Session transcript mutation is in progress", code: "mutation_busy" });
      return;
    }
    try {
      const validation = await validateSessionDeletionPinAttempt(req.body?.pin, {
        kind: "delete_session",
        sessionId: session.id,
        catalogMutationVersion: session.catalog_mutation_version ?? 0,
      });
      if (!validation.ok) {
        if (validation.retryAt !== undefined) {
          res.setHeader("Retry-After", Math.max(1, Math.ceil((validation.retryAt - Date.now()) / 1_000)));
        }
        res.status(validation.statusCode ?? 403).json({
          error: validation.error || "Command guard identity PIN is required.",
          code: validation.code ?? "pin_rejected",
          pinRequired: true,
          pinConfigured: validation.pinConfigured,
        });
        return;
      }

      cancelManualTitleGeneration(session.id);
      await stopPiSession(req.params.id, { kind: "close_session", reason: "session_delete" });
      await removeSearchSession(req.params.id);
      let deleted: ReturnType<typeof deleteSession>;
      try {
        invalidateTranscriptPaginationSession(req.params.id);
        deleted = deleteSession(req.params.id, { searchPurged: true });
      } catch {
        const canonicalRetained = Boolean(getSessionById(req.params.id));
        if (canonicalRetained) await recoverSearchAfterFailedSessionDelete(req.params.id);
        res.status(500).json(canonicalRetained
          ? { error: "Session deletion failed; canonical transcript was retained.", code: "session_delete_failed" }
          : { error: "Session deletion cleanup is incomplete.", code: "session_delete_incomplete" });
        return;
      }
      if (!deleted) {
        await recoverSearchAfterFailedSessionDelete(req.params.id);
        res.status(404).json({ error: "Session not found" });
        return;
      }

      res.json({ deleted: true, deleted_session_file: deleted.deletedSessionFile });
    } finally {
      releaseSessionRuntimeMutationLock(session.id);
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Stop live pi session
// ---------------------------------------------------------------------------

router.post("/sessions/:id/stop", async (req: Request, res: Response) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!isSessionTitleWriteAllowed(session.id)) {
      res.status(409).json({ error: "Session transcript mutation is in progress" });
      return;
    }
    await stopPiSession(req.params.id);
    const updated = getSessionById(req.params.id) || session;
    res.json(serializeSession(updated));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Preview/switch session agent
// ---------------------------------------------------------------------------

router.post("/sessions/:id/agent/preview", async (req: Request, res: Response) => {
  try {
    const agentProfileId = req.body?.agent_profile_id;
    if (typeof agentProfileId !== "string" || !agentProfileId) {
      res.status(400).json({ error: "agent_profile_id is required" });
      return;
    }
    res.json(await previewSessionAgentSwitch(req.params.id, agentProfileId));
  } catch (err: any) {
    res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });
  }
});

router.put("/sessions/:id/agent", async (req: Request, res: Response) => {
  try {
    const agentProfileId = req.body?.agent_profile_id;
    if (typeof agentProfileId !== "string" || !agentProfileId) {
      res.status(400).json({ error: "agent_profile_id is required" });
      return;
    }
    if (!isSessionTitleWriteAllowed(req.params.id)) {
      res.status(409).json({ error: "Session transcript mutation is in progress" });
      return;
    }
    const result = await switchSessionAgent(req.params.id, agentProfileId);
    res.json({
      switch_id: result.switch_id,
      preview: result.preview,
      session: serializeSession(result.session),
    });
  } catch (err: any) {
    res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// Update session model
// ---------------------------------------------------------------------------

router.put("/sessions/:id/model", async (req: Request, res: Response) => {
  try {
    const { provider, model } = req.body;
    const wantsDefault = provider == null && model == null;
    if (
      !wantsDefault &&
      (!provider || typeof provider !== "string" || !model || typeof model !== "string")
    ) {
      res.status(400).json({ error: "provider and model are required" });
      return;
    }

    const session = getSessionById(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    if (!isSessionTitleWriteAllowed(session.id)) {
      res.status(409).json({ error: "Session transcript mutation is in progress" });
      return;
    }
    if (wantsDefault) {
      await setSessionDefaultModel(req.params.id);
    } else {
      await setSessionModel(req.params.id, provider, model);
    }
    const updated = getSessionById(req.params.id);
    res.json(updated ? serializeSession(updated) : null);
  } catch (err: any) {
    res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// Update session goal
// ---------------------------------------------------------------------------

router.put("/sessions/:id/goal", (req: Request, res: Response) => {
  try {
    const { goal, status } = req.body;
    updateGoal(req.params.id, goal ?? null, status ?? null);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Refresh session title from pi session
// ---------------------------------------------------------------------------

router.patch("/sessions/:id/title", (req: Request, res: Response) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Legacy clients may still call this endpoint, but a transcript snapshot
    // cannot prove that the browser send was accepted and settled. Exact live
    // settlement owns provisional fallback mutation; this route is read-only.
    res.json(null);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
