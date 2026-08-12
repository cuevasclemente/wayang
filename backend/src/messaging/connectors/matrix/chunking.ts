import { createHash } from "node:crypto";
import { isLoopbackHost } from "../../../loopback.js";

export const DEFAULT_MATRIX_TEXT_CHUNK_BYTES = 12 * 1024;
const MAX_SOURCE_TEXT_BYTES = 1024 * 1024;

function boundedOpaque(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")
    || Buffer.byteLength(value, "utf8") > 512 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new Error(`Invalid Matrix ${label}`);
  }
  return value;
}

/** Deterministic paragraph-preferred splitting which never divides a Unicode grapheme. */
export function chunkMatrixText(
  text: string,
  maxBytes = DEFAULT_MATRIX_TEXT_CHUNK_BYTES,
): readonly string[] {
  if (typeof text !== "string" || text.length === 0 || text !== text.normalize("NFC")
    || Buffer.byteLength(text, "utf8") > MAX_SOURCE_TEXT_BYTES
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
    throw new Error("Invalid Matrix chunk source text");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 64 || maxBytes > 64 * 1024) {
    throw new Error("Invalid Matrix chunk byte ceiling");
  }
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  const graphemes = [...segmenter.segment(text)].map((entry) => entry.segment);
  const chunks: string[] = [];
  let start = 0;
  while (start < graphemes.length) {
    let end = start;
    let bytes = 0;
    let preferredEnd = -1;
    let priorNewline = false;
    while (end < graphemes.length) {
      const grapheme = graphemes[end]!;
      const size = Buffer.byteLength(grapheme, "utf8");
      if (size > maxBytes) throw new Error("A Matrix message grapheme exceeds the chunk byte ceiling");
      if (bytes + size > maxBytes) break;
      bytes += size;
      end++;
      const newline = grapheme === "\n" || grapheme === "\r\n";
      if (newline && priorNewline) preferredEnd = end;
      priorNewline = newline;
    }
    if (end === start) throw new Error("Matrix chunking made no progress");
    const selectedEnd = end < graphemes.length && preferredEnd > start ? preferredEnd : end;
    chunks.push(graphemes.slice(start, selectedEnd).join(""));
    start = selectedEnd;
  }
  return Object.freeze(chunks);
}

/** Stable across retries and process restarts; no payload or secret material is embedded. */
export function deriveMatrixDeliveryTransactionId(
  deliveryId: string,
  chunkIndex: number,
  subchunkIndex: number,
): string {
  const id = boundedOpaque(deliveryId, "delivery identity");
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || !Number.isSafeInteger(subchunkIndex) || subchunkIndex < 0) {
    throw new Error("Invalid Matrix delivery chunk index");
  }
  const digest = createHash("sha256").update(JSON.stringify({
    version: 1,
    delivery_id: id,
    chunk_index: chunkIndex,
    subchunk_index: subchunkIndex,
  }), "utf8").digest("hex");
  return `wayang.${digest}`;
}

export function matrixHandoffUrl(wayangBaseUrl: string, sessionId: string): string {
  const base = new URL(wayangBaseUrl);
  if (base.origin !== wayangBaseUrl || base.pathname !== "/" || base.search || base.hash || base.username || base.password
    || (base.protocol !== "https:" && base.protocol !== "http:")
    || (base.protocol === "http:" && !isLoopbackHost(base.hostname))) {
    throw new Error("Invalid Wayang handoff base URL");
  }
  const id = boundedOpaque(sessionId, "session identity");
  return `${wayangBaseUrl}/sessions/${encodeURIComponent(id)}`;
}
