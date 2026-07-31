/**
 * routes/tts.ts — TTS (Text-to-Speech) route for Wayang.
 *
 * POST  /api/tts/synthesize  — Extract text from an assistant message and submit
 *                              it to the shared TTS broker, or legacy Chatterbox fallback.
 * GET   /api/tts/jobs/:id/*  — Proxy broker manifest/events/chunk/final audio.
 * GET   /api/tts/audio/:id   — Serve legacy cached audio with HTTP Range support.
 * DELETE /api/tts/audio/:id  — Remove a cached audio file.
 */

import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { getConfig } from "../config.js";
import { synthesizeChunk } from "../tts-chatterbox.js";
import { extractTtsTextFromEntries, findAssistantSpeechGroup } from "../tts-text.js";
import { chunkText } from "../tts-chunk.js";
import { writeAudio, readAudio, deleteAudio } from "../tts-cache.js";
import {
  getPiSession,
  getMessageHistory,
  getSessionFileMessageHistory,
} from "../pi-bridge.js";
import {
  getSessionById,
  isLegacyPrivateSessionQuarantined,
} from "../sessions.js";

export const router = Router();

// ---------------------------------------------------------------------------
// POST /api/tts/synthesize
// ---------------------------------------------------------------------------

interface SynthesizeRequest {
  sessionId: string;
  messageId: string;
}

function requireBrokerUrl(): string | null {
  const brokerUrl = getConfig().tts.brokerUrl.trim().replace(/\/+$/, "");
  return brokerUrl || null;
}

function brokerApiUrl(path: string): string {
  const brokerUrl = requireBrokerUrl();
  if (!brokerUrl) throw new Error("TTS broker is not configured (set WAYANG_TTS_BROKER_URL)");
  return `${brokerUrl}${path}`;
}

function rewriteBrokerUrl(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("/v1/tts/")) {
    return value.replace(/^\/v1\/tts/, "/api/tts");
  }
  return value;
}

function rewriteManifestUrls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteManifestUrls(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = rewriteManifestUrls(rewriteBrokerUrl(child));
    }
    return out as T;
  }
  return rewriteBrokerUrl(value) as T;
}

function validateJobId(jobId: string): boolean {
  return /^[a-f0-9-]{16,64}$/i.test(jobId);
}

function validateAudioName(name: string): boolean {
  return /^\d{1,6}\.[a-z0-9]+$/i.test(name) || /^audio\.[a-z0-9]+$/i.test(name);
}

const TTS_TEXT_PIPELINE_VERSION = "speech-text-v2";

function hashTtsText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

async function submitBrokerJob(text: string, sessionId: string, messageId: string) {
  const config = getConfig();
  const textHash = hashTtsText(text);
  const response = await fetch(brokerApiUrl("/v1/tts/jobs"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotency_key: `wayang:${sessionId}:${messageId}:${config.tts.voice}:${config.tts.model}:${config.tts.format}:${TTS_TEXT_PIPELINE_VERSION}:${textHash}`,
      text,
      title: `Wayang assistant message ${messageId}`,
      format: config.tts.format,
      voice: config.tts.voice,
      model: config.tts.model,
      provider: "chatterbox",
      mode: "interactive",
      priority: "high",
      concat_final: true,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`TTS broker job creation failed (${response.status}): ${body.slice(0, 500) || response.statusText}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  return rewriteManifestUrls({
    jobId: payload.job_id,
    status: payload.status,
    manifestUrl: payload.manifest_url,
    eventsUrl: payload.events_url,
  });
}

router.post("/tts/synthesize", async (req: Request, res: Response) => {
  try {
    const { sessionId, messageId } = req.body as SynthesizeRequest;

    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }
    if (!messageId || typeof messageId !== "string") {
      res.status(400).json({ error: "messageId is required" });
      return;
    }

    // Load session from DB
    const dbSession = getSessionById(sessionId);
    if (!dbSession) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Legacy private sessions are permanent non-egress targets. Keep this
    // durable denial before live/file history, broker/provider, and cache work.
    if (isLegacyPrivateSessionQuarantined(dbSession)) {
      res.status(403).json({ error: "Read aloud is unavailable for quarantined legacy sessions" });
      return;
    }

    // Get message history — prefer live session, fall back to session file
    let entries: any[] = [];
    const liveHandle = getPiSession(sessionId);
    if (liveHandle) {
      entries = getMessageHistory(sessionId);
    } else if (dbSession.pi_session_file) {
      entries = getSessionFileMessageHistory(
        dbSession.pi_session_file,
        dbSession.cwd,
      );
    }

    if (entries.length === 0) {
      res
        .status(404)
        .json({ error: "No message history available for this session" });
      return;
    }

    // Find the display-level assistant bubble containing the target message.
    // A rendered bubble may be composed from multiple raw assistant fragments
    // separated by tool calls/results. Read aloud should speak the visible prose
    // from that whole bubble, not just the one fragment whose id was clicked.
    const speechGroup = findAssistantSpeechGroup(entries, messageId);
    if (!speechGroup) {
      res.status(404).json({ error: "Message not found in session history" });
      return;
    }

    // Extract clean text
    const text = extractTtsTextFromEntries(speechGroup);
    if (!text) {
      res.status(400).json({
        error: "No readable assistant text in this message group",
      });
      return;
    }

    // Get TTS config
    const config = getConfig();
    if (config.tts.brokerUrl) {
      const brokerJob = await submitBrokerJob(text, sessionId, messageId);
      res.json(brokerJob);
      return;
    }
    if (!config.tts.baseUrl) {
      res.status(503).json({
        error: "TTS is not configured (set WAYANG_TTS_BROKER_URL, or legacy WAYANG_TTS_BASE_URL)",
      });
      return;
    }

    // Legacy direct Chatterbox fallback. The shared broker path above is preferred
    // because it exposes chunk-ready events and avoids browser waits for full audio.
    const chunks = chunkText(text, config.tts.maxChars);

    // Cap legacy direct synthesis to prevent abuse. Broker jobs own robust long-form chunking.
    if (chunks.length > 20) {
      console.warn(
        `[tts] Message ${messageId} has ${chunks.length} chunks — capping legacy direct synthesis at 20`,
      );
      chunks.length = 20;
    }

    const audioBuffers: Buffer[] = [];
    for (let i = 0; i < chunks.length; i++) {
      let attempts = 0;
      const maxAttempts = 3;
      let lastError: unknown;

      while (attempts < maxAttempts) {
        try {
          const audio = await synthesizeChunk(chunks[i], config.tts);
          audioBuffers.push(audio);
          break;
        } catch (err) {
          lastError = err;
          attempts++;
          if (attempts < maxAttempts) {
            await new Promise((resolve) =>
              setTimeout(resolve, 1000 * attempts),
            );
          }
        }
      }

      if (audioBuffers.length <= i) {
        throw new Error(
          `Failed to synthesize chunk ${i + 1}/${chunks.length}: ${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`,
        );
      }
    }

    const concatenated = Buffer.concat(audioBuffers);
    const filename = await writeAudio(concatenated, config.tts.format);
    const audioUrl = `/api/tts/audio/${filename}`;

    res.json({
      id: filename,
      url: audioUrl,
      chunks: chunks.length,
      duration: concatenated.length,
    });
  } catch (err) {
    console.error("[tts] Synthesize error:", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "TTS synthesis failed",
    });
  }
});

// ---------------------------------------------------------------------------
// Broker proxy routes
// ---------------------------------------------------------------------------

router.get("/tts/jobs/:jobId/manifest", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    if (!validateJobId(jobId)) {
      res.status(400).json({ error: "Invalid job ID" });
      return;
    }
    const response = await fetch(brokerApiUrl(`/v1/tts/jobs/${jobId}/manifest`));
    const text = await response.text();
    res.status(response.status);
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/json");
    if (!response.ok) {
      res.send(text);
      return;
    }
    res.json(rewriteManifestUrls(JSON.parse(text)));
  } catch (err) {
    console.error("[tts] Broker manifest proxy error:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "TTS broker manifest proxy failed" });
  }
});

router.get("/tts/jobs/:jobId/events", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    if (!validateJobId(jobId)) {
      res.status(400).json({ error: "Invalid job ID" });
      return;
    }
    const response = await fetch(brokerApiUrl(`/v1/tts/jobs/${jobId}/events`), {
      headers: { Accept: "text/event-stream" },
    });
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "");
      res.status(response.status || 502).json({ error: body || "TTS broker events unavailable" });
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    try {
      for await (const chunk of response.body as any) {
        if (res.destroyed) break;
        res.write(chunk);
      }
    } finally {
      res.end();
    }
  } catch (err) {
    console.error("[tts] Broker events proxy error:", err);
    if (!res.headersSent) {
      res.status(502).json({ error: err instanceof Error ? err.message : "TTS broker events proxy failed" });
    } else {
      res.end();
    }
  }
});

router.get("/tts/jobs/:jobId/chunks/:chunkName", async (req: Request, res: Response) => {
  await proxyBrokerAudio(req, res, `/v1/tts/jobs/${req.params.jobId}/chunks/${req.params.chunkName}`);
});

router.get("/tts/jobs/:jobId/audio.:fmt", async (req: Request, res: Response) => {
  await proxyBrokerAudio(req, res, `/v1/tts/jobs/${req.params.jobId}/audio.${req.params.fmt}`);
});

async function proxyBrokerAudio(req: Request, res: Response, path: string): Promise<void> {
  try {
    const { jobId } = req.params;
    const name = req.params.chunkName || `audio.${req.params.fmt}`;
    if (!validateJobId(jobId) || !validateAudioName(name)) {
      res.status(400).json({ error: "Invalid TTS audio path" });
      return;
    }
    const headers: Record<string, string> = {};
    if (typeof req.headers.range === "string") headers.Range = req.headers.range;
    const response = await fetch(brokerApiUrl(path), { headers });
    const body = Buffer.from(await response.arrayBuffer());
    res.status(response.status);
    for (const header of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"]) {
      const value = response.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    res.end(body);
  } catch (err) {
    console.error("[tts] Broker audio proxy error:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "TTS broker audio proxy failed" });
  }
}

// ---------------------------------------------------------------------------
// GET /api/tts/audio/:id
// ---------------------------------------------------------------------------

router.get("/tts/audio/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Validate id is a simple filename (uuid.format)
    if (!/^[a-f0-9-]+\.[a-z0-9]+$/i.test(id)) {
      res.status(400).json({ error: "Invalid audio ID" });
      return;
    }

    const result = await readAudio(id);
    if (!result) {
      res.status(404).json({ error: "Audio not found" });
      return;
    }

    // Determine content type
    const ext = id.split(".").pop()?.toLowerCase();
    const contentType =
      ext === "mp3"
        ? "audio/mpeg"
        : ext === "wav"
          ? "audio/wav"
          : ext === "ogg"
            ? "audio/ogg"
            : "application/octet-stream";

    // Support HTTP Range requests for seeking
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", result.size);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=86400");

    // Handle Range requests
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : result.size - 1;

      if (!isNaN(start) && !isNaN(end) && start <= end && end < result.size) {
        const chunkSize = end - start + 1;
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${result.size}`);
        res.setHeader("Content-Length", chunkSize);
        res.end(result.data.subarray(start, end + 1));
        return;
      }
    }

    res.end(result.data);
  } catch (err) {
    console.error("[tts] Audio serve error:", err);
    res.status(500).json({ error: "Failed to serve audio" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/tts/audio/:id
// ---------------------------------------------------------------------------

router.delete("/tts/audio/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!/^[a-f0-9-]+\.[a-z0-9]+$/i.test(id)) {
      res.status(400).json({ error: "Invalid audio ID" });
      return;
    }

    const deleted = await deleteAudio(id);
    if (!deleted) {
      res.status(404).json({ error: "Audio not found" });
      return;
    }

    res.json({ deleted: true });
  } catch (err) {
    console.error("[tts] Audio delete error:", err);
    res.status(500).json({ error: "Failed to delete audio" });
  }
});
