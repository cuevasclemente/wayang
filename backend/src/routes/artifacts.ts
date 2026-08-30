import * as fs from "node:fs";
import { once } from "node:events";
import { Router, type Request, type Response } from "express";
import { reauthorizeArtifactRow, ArtifactAuthorizationError } from "../artifacts/authorization.js";
import { closeOpenArtifact, PREVIEW_LIMITS, type OpenArtifactFile } from "../artifacts/file.js";
import {
  listSessionArtifacts,
  openSessionArtifact,
  readArtifactTextPreview,
} from "../artifacts/service.js";
import { ArtifactRegistryError } from "../artifacts/registry.js";

export const router = Router();

function setArtifactHeaders(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function errorStatus(error: unknown): number {
  return error instanceof ArtifactAuthorizationError || error instanceof ArtifactRegistryError
    ? error.statusCode
    : 500;
}

function errorCode(error: unknown): string {
  return error instanceof ArtifactAuthorizationError || error instanceof ArtifactRegistryError
    ? error.code
    : "artifact_error";
}

function sendError(res: Response, error: unknown): void {
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : undefined);
    return;
  }
  setArtifactHeaders(res);
  const status = errorStatus(error);
  const code = errorCode(error);
  const publicMessage = status === 404
    ? "Artifact was not found"
    : status === 422
      ? "Artifact preview is unavailable"
      : status >= 500
        ? "Artifact request failed"
        : error instanceof Error ? error.message : "Artifact request failed";
  res.status(status).json({ error: publicMessage, code });
}

function assertSameOriginFetch(req: Request, kind: "list" | "preview" | "download", image = false): void {
  const site = req.get("sec-fetch-site");
  const mode = req.get("sec-fetch-mode");
  const dest = req.get("sec-fetch-dest");
  if (!site && !mode && !dest) return;
  if (site && site !== "same-origin" && site !== "none") {
    throw new ArtifactAuthorizationError("Cross-origin artifact requests are denied", 403, "cross_origin_denied");
  }
  if (kind === "download") {
    const navigation = mode === "navigate" && (dest === "document" || dest === "empty");
    const explicit = (!mode || ["cors", "same-origin", "no-cors"].includes(mode)) && (!dest || dest === "empty");
    if (!navigation && !explicit) throw new ArtifactAuthorizationError("Artifact download fetch metadata is invalid", 403, "cross_origin_denied");
    return;
  }
  const allowedMode = !mode || ["cors", "same-origin", "no-cors"].includes(mode);
  const allowedDest = !dest || dest === "empty" || (image && dest === "image");
  if (!allowedMode || !allowedDest) throw new ArtifactAuthorizationError("Artifact fetch metadata is invalid", 403, "cross_origin_denied");
}

function safeContentDisposition(name: string): string {
  const clean = name.replace(/[\r\n]/g, "_");
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").slice(0, 180) || "artifact";
  const encoded = encodeURIComponent(clean).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function streamVerifiedArtifact(req: Request, res: Response, opened: OpenArtifactFile): Promise<void> {
  const buffer = Buffer.alloc(256 * 1024);
  let position = 0;
  while (position < opened.stat.size) {
    if (req.destroyed || res.destroyed) throw new Error("Artifact client disconnected");
    const current = reauthorizeArtifactRow(opened.row.session_id, opened.row);
    const descriptorStat = fs.fstatSync(opened.descriptor);
    if (current.canonicalPath !== opened.canonicalPath || !sameIdentity(opened.stat, current.stat) || !sameIdentity(opened.stat, descriptorStat)) {
      throw new Error("Artifact changed while streaming");
    }
    const wanted = Math.min(buffer.length, opened.stat.size - position);
    const count = fs.readSync(opened.descriptor, buffer, 0, wanted, position);
    if (count <= 0) throw new Error("Artifact ended while streaming");
    position += count;
    if (!res.write(buffer.subarray(0, count))) await once(res, "drain");
  }
  res.end();
}

router.all("/sessions/:sessionId/artifacts", async (req: Request, res: Response) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    assertSameOriginFetch(req, "list");
    const result = listSessionArtifacts(req.params.sessionId);
    setArtifactHeaders(res);
    res.type("application/json; charset=utf-8");
    if (req.method === "HEAD") res.end();
    else res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.all("/sessions/:sessionId/artifacts/:artifactId/preview", async (req: Request, res: Response) => {
  let opened: OpenArtifactFile | null = null;
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    opened = openSessionArtifact(req.params.sessionId, req.params.artifactId);
    assertSameOriginFetch(req, "preview", opened.classification.renderer === "image");
    if (!opened.classification.previewAvailable) {
      throw new ArtifactAuthorizationError("Artifact preview is unavailable", 422, "preview_unavailable");
    }
    setArtifactHeaders(res);
    if (["markdown", "text", "html"].includes(opened.classification.renderer)) {
      const result = readArtifactTextPreview(opened);
      res.type("application/json; charset=utf-8");
      if (req.method === "HEAD") res.end();
      else res.json(result);
      return;
    }
    if (opened.classification.renderer !== "image" && opened.classification.renderer !== "pdf") {
      throw new ArtifactAuthorizationError("Artifact preview is unavailable", 422, "preview_unavailable");
    }
    res.type(opened.classification.contentType ?? "application/octet-stream");
    res.setHeader("Content-Length", String(opened.stat.size));
    if (req.method === "HEAD") { res.end(); return; }
    await streamVerifiedArtifact(req, res, opened);
  } catch (error) {
    sendError(res, error);
  } finally {
    if (opened) closeOpenArtifact(opened);
  }
});

router.all("/sessions/:sessionId/artifacts/:artifactId/download", async (req: Request, res: Response) => {
  let opened: OpenArtifactFile | null = null;
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    assertSameOriginFetch(req, "download");
    opened = openSessionArtifact(req.params.sessionId, req.params.artifactId);
    if (opened.stat.size > PREVIEW_LIMITS.download) {
      throw new ArtifactAuthorizationError("Artifact download is unavailable", 422, "download_unavailable");
    }
    setArtifactHeaders(res);
    res.type("application/octet-stream");
    res.setHeader("Content-Disposition", safeContentDisposition(opened.row.display_name));
    res.setHeader("Content-Length", String(opened.stat.size));
    if (req.method === "HEAD") { res.end(); return; }
    await streamVerifiedArtifact(req, res, opened);
  } catch (error) {
    sendError(res, error);
  } finally {
    if (opened) closeOpenArtifact(opened);
  }
});
