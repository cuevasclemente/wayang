import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  getAttachmentsRoot,
  getSessionAttachmentRoot,
} from "./protected-artifacts.js";

const MAX_ATTACHMENTS = 40;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);
const MIME_EXTENSION_HINTS = new Map([
  ["application/pdf", "pdf"],
  ["message/rfc822", "eml"],
  ["text/plain", "txt"],
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
]);
const MAX_REGISTERED_ATTACHMENTS = 8192;
const attachmentRegistry = new Map<string, PrivateAttachmentRecord>();

function pruneAttachmentRegistry(): void {
  while (attachmentRegistry.size > MAX_REGISTERED_ATTACHMENTS) {
    const oldest = attachmentRegistry.keys().next().value as string | undefined;
    if (!oldest) break;
    attachmentRegistry.delete(oldest);
  }
}

function publicRecord(record: PrivateAttachmentRecord): AttachmentRecord {
  const { filePath: _filePath, device: _device, inode: _inode, ...safe } = record;
  return structuredClone(safe);
}

/** Process-local provenance record. A restart deliberately invalidates old IDs. */
export function getRegisteredAttachment(sourceSessionId: string, attachmentId: string): AttachmentRecord | undefined {
  const record = attachmentRegistry.get(attachmentId);
  if (!record || record.sourceSessionId !== sourceSessionId) return undefined;
  return publicRecord(record);
}

/** Reopen the exact registered upload no-follow and hash/read from that descriptor. */
export function readRegisteredAttachment(sourceSessionId: string, attachmentId: string, maxBytes: number): {
  record: AttachmentRecord;
  bytes: Buffer;
} {
  const record = attachmentRegistry.get(attachmentId);
  if (!record || record.sourceSessionId !== sourceSessionId) throw new Error("Attachment is not registered for this source session");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || record.sourceBytes > maxBytes) throw new Error("Attachment exceeds the permitted byte bound");

  const sessionRoot = getSessionAttachmentRoot(sourceSessionId);
  const canonicalParent = fs.realpathSync.native(path.dirname(record.filePath));
  const canonicalRoot = fs.realpathSync.native(sessionRoot);
  if (canonicalParent !== canonicalRoot) throw new Error("Registered attachment is outside the source session root");

  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(record.filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== record.device || stat.ino !== record.inode || stat.size !== record.sourceBytes) {
      throw new Error("Registered attachment changed after upload");
    }
    if (stat.size > maxBytes) throw new Error("Attachment exceeds the permitted byte bound");
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length !== record.sourceBytes || createHash("sha256").update(bytes).digest("hex") !== record.sourceSha256) {
      throw new Error("Registered attachment content changed after upload");
    }
    return { record: publicRecord(record), bytes };
  } finally {
    fs.closeSync(descriptor);
  }
}

export interface PreparedAttachments {
  images: ImageContent[];
  notes: string[];
  attachmentIds: string[];
  count: number;
}

export interface AttachmentRecord {
  attachmentId: string;
  sourceSessionId: string;
  displayName: string;
  declaredMimeType: string;
  sourceBytes: number;
  sourceSha256: string;
  createdAt: number;
}

interface PrivateAttachmentRecord extends AttachmentRecord {
  filePath: string;
  device: number;
  inode: number;
}

interface ValidatedAttachment {
  buffer: Buffer;
  mimeType: string;
  isImage: boolean;
  originalName: string;
}

function sanitizeUploadName(name: unknown): string {
  if (typeof name !== "string") return "attachment";
  const sanitized = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized.slice(0, 120) || "attachment";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeBase64AttachmentData(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Attachment is missing data");
  }
  const withoutDataUrl = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const normalized = withoutDataUrl.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("Attachment data must be base64-encoded");
  }
  return normalized;
}

function ensureUploadNameHasExtension(name: string, extension: string | undefined): string {
  if (!extension || /\.[a-zA-Z0-9]{1,12}$/.test(name)) return name;
  return `${name}.${extension}`;
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Attachment storage path must be a private directory");
  }
  fs.chmodSync(directory, 0o700);
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function validateAttachments(attachments: unknown): ValidatedAttachment[] {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`Too many attachments (max ${MAX_ATTACHMENTS})`);
  }

  const validated: ValidatedAttachment[] = [];
  let totalBytes = 0;
  for (const rawAttachment of attachments) {
    if (!rawAttachment || typeof rawAttachment !== "object") throw new Error("Invalid attachment");
    const attachment = rawAttachment as Record<string, unknown>;
    const mimeType = typeof attachment.mimeType === "string" && attachment.mimeType.trim()
      ? attachment.mimeType.toLowerCase()
      : "application/octet-stream";
    const imageExtension = ALLOWED_IMAGE_MIME_TYPES.get(mimeType);
    const isImage = Boolean(imageExtension);
    if (mimeType.startsWith("image/") && !imageExtension) {
      throw new Error(`Unsupported image type: ${mimeType}`);
    }

    const data = normalizeBase64AttachmentData(attachment.data);
    const buffer = Buffer.from(data, "base64");
    if (buffer.length === 0) throw new Error("Attachment is empty");
    const maxBytes = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (buffer.length > maxBytes) {
      throw new Error(`Attachment is too large (${formatBytes(buffer.length)}; max ${formatBytes(maxBytes)})`);
    }
    totalBytes += buffer.length;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(`Attachments are too large (${formatBytes(totalBytes)} total; max ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)})`);
    }

    validated.push({
      buffer,
      mimeType,
      isImage,
      originalName: ensureUploadNameHasExtension(
        sanitizeUploadName(attachment.name),
        imageExtension ?? MIME_EXTENSION_HINTS.get(mimeType),
      ),
    });
  }
  return validated;
}

/** Validate first, then persist only into the source Wayang session's private subtree. */
export function prepareAttachments(sessionId: string, attachments: unknown): PreparedAttachments {
  const validated = validateAttachments(attachments);
  if (validated.length === 0) return { images: [], notes: [], attachmentIds: [], count: 0 };

  const attachmentsRoot = getAttachmentsRoot();
  const sessionRoot = getSessionAttachmentRoot(sessionId);
  ensurePrivateDirectory(attachmentsRoot);
  ensurePrivateDirectory(sessionRoot);

  const images: ImageContent[] = [];
  const notes: string[] = [];
  const attachmentIds: string[] = [];
  const created: Array<{ filePath: string; attachmentId: string }> = [];
  try {
    for (const attachment of validated) {
      const attachmentId = randomUUID();
      const fileName = `${Date.now()}-${randomUUID()}-${attachment.originalName}`;
      const filePath = path.join(sessionRoot, fileName);
      fs.writeFileSync(filePath, attachment.buffer, { mode: 0o600, flag: "wx" });
      created.push({ filePath, attachmentId });
      fs.chmodSync(filePath, 0o600);
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Persisted attachment must be a regular file");
      const record: PrivateAttachmentRecord = {
        attachmentId,
        sourceSessionId: sessionId,
        displayName: attachment.originalName,
        declaredMimeType: attachment.mimeType,
        sourceBytes: attachment.buffer.length,
        sourceSha256: createHash("sha256").update(attachment.buffer).digest("hex"),
        createdAt: Date.now(),
        filePath,
        device: stat.dev,
        inode: stat.ino,
      };
      attachmentRegistry.set(attachmentId, record);
      pruneAttachmentRegistry();
      attachmentIds.push(attachmentId);
      const promptPath = escapeXmlAttribute(filePath);
      if (attachment.isImage) {
        images.push({ type: "image", mimeType: attachment.mimeType, data: attachment.buffer.toString("base64") });
        notes.push(`<file name="${promptPath}" attachment_id="${attachmentId}">[Uploaded image ${attachment.originalName}; ${attachment.mimeType}; ${formatBytes(attachment.buffer.length)}]</file>`);
      } else {
        notes.push(`<file name="${promptPath}" attachment_id="${attachmentId}">[Uploaded file ${attachment.originalName}; ${attachment.mimeType}; ${formatBytes(attachment.buffer.length)}. Saved at this path for tool access. Use attachment_id for backend-owned capabilities.]</file>`);
      }
    }
  } catch (error) {
    for (const createdAttachment of created) {
      attachmentRegistry.delete(createdAttachment.attachmentId);
      try { fs.unlinkSync(createdAttachment.filePath); } catch { /* remove only files created by this call */ }
    }
    throw error;
  }
  return { images, notes, attachmentIds, count: notes.length };
}
