import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArtifactRenderer } from "@wayang/protocol";
import { reauthorizeArtifactRow, type ArtifactSessionAuthorization } from "./authorization.js";
import type { ArtifactCatalogRow, ArtifactFileClassification } from "./types.js";

export const PREVIEW_LIMITS = Object.freeze({
  text: 2 * 1024 * 1024,
  image: 25 * 1024 * 1024,
  pdf: 50 * 1024 * 1024,
  download: 512 * 1024 * 1024,
  imagePixels: 40_000_000,
});

export interface OpenArtifactFile {
  descriptor: number;
  canonicalPath: string;
  stat: fs.Stats;
  authorization: ArtifactSessionAuthorization;
  row: ArtifactCatalogRow;
  classification: ArtifactFileClassification;
}

const codeLanguages: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rs: "rust", go: "go", java: "java", c: "c", h: "c",
  cpp: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", php: "php",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", json: "json",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", css: "css",
  scss: "scss", sql: "sql", xml: "xml", lua: "lua", txt: "plaintext",
  csv: "csv", log: "plaintext", md: "markdown", markdown: "markdown",
};

function extension(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

function readSlice(descriptor: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(Math.max(0, length));
  let offset = 0;
  while (offset < buffer.length) {
    const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, position + offset);
    if (count === 0) break;
    offset += count;
  }
  return offset === buffer.length ? buffer : buffer.subarray(0, offset);
}

function validUtf8(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function safeDimensions(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    && width <= PREVIEW_LIMITS.imagePixels && height <= PREVIEW_LIMITS.imagePixels
    && width * height <= PREVIEW_LIMITS.imagePixels;
}

function pngDimensions(header: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (header.length < 24 || !header.subarray(0, 8).equals(signature) || header.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  return safeDimensions(width, height) ? { width, height } : null;
}

function jpegDimensions(header: Buffer): { width: number; height: number } | null {
  if (header.length < 4 || header[0] !== 0xff || header[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < header.length) {
    if (header[offset] !== 0xff) { offset += 1; continue; }
    while (offset < header.length && header[offset] === 0xff) offset += 1;
    const marker = header[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > header.length) return null;
    const length = header.readUInt16BE(offset);
    if (length < 2 || offset + length > header.length) return null;
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof && length >= 7) {
      const height = header.readUInt16BE(offset + 3);
      const width = header.readUInt16BE(offset + 5);
      return safeDimensions(width, height) ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

function webpDimensions(header: Buffer): { width: number; height: number; animated: boolean } | null {
  if (header.length < 30 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = header.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    const animated = Boolean(header[20] & 0x02);
    const width = 1 + header.readUIntLE(24, 3);
    const height = 1 + header.readUIntLE(27, 3);
    return safeDimensions(width, height) ? { width, height, animated } : null;
  }
  if (chunk === "VP8 " && header.length >= 30 && header[23] === 0x9d && header[24] === 0x01 && header[25] === 0x2a) {
    const width = header.readUInt16LE(26) & 0x3fff;
    const height = header.readUInt16LE(28) & 0x3fff;
    return safeDimensions(width, height) ? { width, height, animated: false } : null;
  }
  if (chunk === "VP8L" && header.length >= 25 && header[20] === 0x2f) {
    const bits = header.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return safeDimensions(width, height) ? { width, height, animated: false } : null;
  }
  return null;
}

function imageClassification(header: Buffer, size: number): ArtifactFileClassification | null {
  const png = pngDimensions(header);
  if (png) return size <= PREVIEW_LIMITS.image
    ? { renderer: "image", language: null, previewAvailable: true, previewUnavailableReason: null, contentType: "image/png" }
    : { renderer: "image", language: null, previewAvailable: false, previewUnavailableReason: "image_too_large", contentType: "image/png" };
  const jpeg = jpegDimensions(header);
  if (jpeg) return size <= PREVIEW_LIMITS.image
    ? { renderer: "image", language: null, previewAvailable: true, previewUnavailableReason: null, contentType: "image/jpeg" }
    : { renderer: "image", language: null, previewAvailable: false, previewUnavailableReason: "image_too_large", contentType: "image/jpeg" };
  const webp = webpDimensions(header);
  if (webp) return size <= PREVIEW_LIMITS.image && !webp.animated
    ? { renderer: "image", language: null, previewAvailable: true, previewUnavailableReason: null, contentType: "image/webp" }
    : { renderer: "image", language: null, previewAvailable: false, previewUnavailableReason: webp.animated ? "animated_image" : "image_too_large", contentType: "image/webp" };
  return null;
}

export function classifyArtifactFile(descriptor: number, stat: fs.Stats, filePath: string): ArtifactFileClassification {
  const head = readSlice(descriptor, Math.min(stat.size, 256 * 1024), 0);
  const image = imageClassification(head, stat.size);
  if (image) return image;
  const ext = extension(filePath);
  if ((head.length >= 6 && ["GIF87a", "GIF89a"].includes(head.toString("ascii", 0, 6))) || ext === "svg") {
    return {
      renderer: "unsupported",
      language: null,
      previewAvailable: false,
      previewUnavailableReason: ext === "svg" ? "unsafe_vector_image" : "animated_image",
      contentType: ext === "svg" ? "image/svg+xml" : "image/gif",
    };
  }

  if (head.length >= 5 && head.toString("ascii", 0, 5) === "%PDF-") {
    const tail = readSlice(descriptor, Math.min(stat.size, 4096), Math.max(0, stat.size - 4096));
    const plausible = tail.includes(Buffer.from("%%EOF"));
    return {
      renderer: "pdf",
      language: null,
      previewAvailable: plausible && stat.size <= PREVIEW_LIMITS.pdf,
      previewUnavailableReason: !plausible ? "malformed_pdf" : stat.size > PREVIEW_LIMITS.pdf ? "pdf_too_large" : null,
      contentType: "application/pdf",
    };
  }

  if (stat.size <= PREVIEW_LIMITS.text) {
    const entire = stat.size <= head.length ? head : readSlice(descriptor, stat.size, 0);
    if (validUtf8(entire)) {
      const renderer: ArtifactRenderer = ext === "md" || ext === "markdown"
        ? "markdown"
        : ext === "html" || ext === "htm"
          ? "html"
          : "text";
      return {
        renderer,
        language: renderer === "text" ? (codeLanguages[ext] ?? "plaintext") : renderer === "markdown" ? "markdown" : "html",
        previewAvailable: true,
        previewUnavailableReason: null,
        contentType: "application/json; charset=utf-8",
      };
    }
  }

  return {
    renderer: "unsupported",
    language: null,
    previewAvailable: false,
    previewUnavailableReason: stat.size > PREVIEW_LIMITS.text ? "unsupported_or_too_large" : "unsupported_format",
    contentType: null,
  };
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export function openArtifactFile(sessionId: string, row: ArtifactCatalogRow): OpenArtifactFile {
  const initial = reauthorizeArtifactRow(sessionId, row);
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(initial.canonicalPath, fs.constants.O_RDONLY | noFollow);
  try {
    const descriptorStat = fs.fstatSync(descriptor);
    if (!descriptorStat.isFile() || descriptorStat.isSymbolicLink() || descriptorStat.nlink !== 1 || !sameIdentity(initial.stat, descriptorStat)) {
      throw new Error("Artifact changed while opening");
    }
    const final = reauthorizeArtifactRow(sessionId, row);
    if (final.canonicalPath !== initial.canonicalPath || !sameIdentity(descriptorStat, final.stat)) {
      throw new Error("Artifact changed while authorizing");
    }
    const classification = classifyArtifactFile(descriptor, descriptorStat, initial.canonicalPath);
    return {
      descriptor,
      canonicalPath: initial.canonicalPath,
      stat: descriptorStat,
      authorization: final.authorization,
      row,
      classification,
    };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function readOpenArtifact(opened: OpenArtifactFile, maxBytes: number): { bytes: Buffer; sha256: string } {
  if (opened.stat.size > maxBytes) throw new Error("Artifact exceeds the preview limit");
  const bytes = readSlice(opened.descriptor, opened.stat.size, 0);
  if (bytes.length !== opened.stat.size) throw new Error("Artifact changed while reading");
  const current = fs.fstatSync(opened.descriptor);
  if (current.dev !== opened.stat.dev || current.ino !== opened.stat.ino || current.size !== opened.stat.size) {
    throw new Error("Artifact changed while reading");
  }
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function closeOpenArtifact(opened: OpenArtifactFile): void {
  try { fs.closeSync(opened.descriptor); } catch { /* idempotent cleanup path */ }
}
