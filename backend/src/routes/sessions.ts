import { Router, type Request, type Response } from "express";
import { createSession, listSessions, syncPiSessionFiles, updateSessionTitle, archiveSession, deleteSession, getSessionById, updateGoal, updateSessionModel, getSessionCatalogGeneration, onSessionCatalogGeneration, type SessionRow } from "../sessions.js";
import { getPiSession, getPiSessionRuntimeState, listModels, listSlashCommands, setSessionDefaultModel, setSessionModel, stopPiSession } from "../pi-bridge.js";
import { validateCommandGuardIdentityPin } from "../command-guard-pin.js";
import { removeSession as removeSearchSession } from "../search/indexer.js";
import { recordLatencyMetric } from "../latency-metrics.js";

export const router = Router();

type SessionResponse = SessionRow & ReturnType<typeof getPiSessionRuntimeState>;

function serializeSession(session: SessionRow): SessionResponse {
  return { ...session, ...getPiSessionRuntimeState(session.id) };
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
    const { cwd, title, model, provider } = req.body;
    if (!cwd || typeof cwd !== "string") {
      res.status(400).json({ error: "cwd is required" });
      return;
    }

    // Create only the lightweight DB record. Opening/selecting a session is
    // read-only; the live pi AgentSession is started lazily when the first
    // human/agent message is sent.
    const session = createSession(cwd, title, model || undefined, undefined, provider || undefined);

    res.status(201).json(serializeSession(session));
  } catch (err) {
    res.status(500).json({ error: String(err) });
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

router.put("/sessions/:id/title", (req: Request, res: Response) => {
  try {
    const { title } = req.body;
    updateSessionTitle(req.params.id, title);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
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
    archiveSession(req.params.id);
    await stopPiSession(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Delete session (requires command guard identity PIN)
// ---------------------------------------------------------------------------

router.post("/sessions/:id/delete", async (req: Request, res: Response) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const validation = validateCommandGuardIdentityPin(req.body?.pin);
    if (!validation.ok) {
      res.status(403).json({
        error: validation.error || "Command guard identity PIN is required.",
        pinRequired: true,
        pinConfigured: validation.pinConfigured,
      });
      return;
    }

    await stopPiSession(req.params.id);
    await removeSearchSession(req.params.id);
    const deleted = deleteSession(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    res.json({ deleted: true, deleted_session_file: deleted.deletedSessionFile });
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
    await stopPiSession(req.params.id);
    const updated = getSessionById(req.params.id) || session;
    res.json(serializeSession(updated));
  } catch (err) {
    res.status(500).json({ error: String(err) });
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

    if (wantsDefault) {
      await setSessionDefaultModel(req.params.id);
      updateSessionModel(req.params.id, null, null);
    } else {
      const selected = await setSessionModel(req.params.id, provider, model);
      updateSessionModel(req.params.id, selected.model, selected.provider);
    }
    const updated = getSessionById(req.params.id);
    res.json(updated ? serializeSession(updated) : null);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
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

    const handle = getPiSession(session.id);
    if (handle && handle.session.messages.length > 0) {
      const firstUser = handle.session.messages.find((m) => m.role === "user");
      if (firstUser) {
        const content = Array.isArray(firstUser.content)
          ? firstUser.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join(" ")
          : typeof firstUser.content === "string"
            ? firstUser.content
            : String(firstUser.content);
        const title = content.slice(0, 80).trim();
        if (title) {
          updateSessionTitle(session.id, title);
          res.json(title);
          return;
        }
      }
    }

    res.json(null);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
