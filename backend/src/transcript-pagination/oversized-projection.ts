import * as fs from "node:fs";
import type { SerializedMessage } from "../pi-bridge.js";

export const TRANSCRIPT_OVERSIZED_PROJECTION_MAX_BYTES = 64 * 1024;
export const TRANSCRIPT_OVERSIZED_SAMPLE_BYTES = 64 * 1024;
const PROJECTION_TEXT_BUDGET = 24 * 1024;
const PROJECTION_MAX_BLOCKS = 64;

interface ProjectionState {
  remainingTextBytes: number;
  omitted: Set<string>;
  binaryBlocks: number;
  previewTruncated: boolean;
}

export interface OversizedProjectionMetadata {
  kind: "oversized_event";
  original_encoded_bytes: number;
  omitted: string[];
  binary_blocks_omitted: number;
  preview_truncated: boolean;
}

export interface SampledTranscriptEnvelope {
  eventType: string;
  id: string;
  parentId: string | null;
  encodedBytes: number;
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
  return text.slice(0, end);
}

function utf8Suffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(text.length - length)) <= maxBytes) low = length;
    else high = length - 1;
  }
  let start = text.length - low;
  if (start < text.length && /[\uDC00-\uDFFF]/u.test(text[start]!)) start++;
  return text.slice(start);
}

function boundedText(value: string, state: ProjectionState): string {
  const available = state.remainingTextBytes;
  if (available <= 0) {
    state.previewTruncated = true;
    state.omitted.add("text");
    return "";
  }
  const bytes = Buffer.byteLength(value);
  if (bytes <= available) {
    state.remainingTextBytes -= bytes;
    return value;
  }
  state.previewTruncated = true;
  state.omitted.add("text");
  const marker = "\n… [text omitted from bounded transcript projection] …\n";
  const markerBytes = Buffer.byteLength(marker);
  const contentBudget = Math.max(0, available - markerBytes);
  const headBudget = Math.floor(contentBudget * 0.75);
  const tailBudget = contentBudget - headBudget;
  const head = utf8Prefix(value, headBudget);
  const tail = utf8Suffix(value, tailBudget);
  const result = `${head}${marker}${tail}`;
  state.remainingTextBytes = Math.max(0, available - Buffer.byteLength(result));
  return result;
}

function smallScalar(value: unknown): unknown {
  if (typeof value === "boolean" || typeof value === "number" || value === null) return value;
  if (typeof value === "string" && Buffer.byteLength(value) <= 4 * 1024) return value;
  return undefined;
}

function boundedJsonValue(value: unknown, state: ProjectionState, depth = 0): unknown {
  if (depth > 3) {
    state.omitted.add("nested_value");
    return "[nested value omitted]";
  }
  if (typeof value === "string") return boundedText(value, state);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length > PROJECTION_MAX_BLOCKS) state.omitted.add("array_items");
    return value.slice(0, PROJECTION_MAX_BLOCKS).map((item) => boundedJsonValue(item, state, depth + 1));
  }
  if (!value || typeof value !== "object") return String(value ?? "");
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > PROJECTION_MAX_BLOCKS) state.omitted.add("object_fields");
  for (const [key, nested] of entries.slice(0, PROJECTION_MAX_BLOCKS)) {
    if (/^(data|base64|bytes|buffer)$/iu.test(key) && typeof nested === "string" && nested.length > 1024) {
      state.binaryBlocks++;
      state.omitted.add("binary_data");
      output[key] = `[${Buffer.byteLength(nested)} encoded bytes omitted]`;
      continue;
    }
    output[key] = boundedJsonValue(nested, state, depth + 1);
  }
  return output;
}

function projectedContent(content: unknown, state: ProjectionState): unknown {
  if (typeof content === "string") return boundedText(content, state);
  if (!Array.isArray(content)) return boundedJsonValue(content, state);

  const projected: unknown[] = [];
  if (content.length > PROJECTION_MAX_BLOCKS) state.omitted.add("content_blocks");
  for (const block of content.slice(0, PROJECTION_MAX_BLOCKS)) {
    if (typeof block === "string") {
      const text = boundedText(block, state);
      if (text) projected.push(text);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const value = block as Record<string, unknown>;
    if (value.type === "image" && typeof value.data === "string") {
      state.binaryBlocks++;
      state.omitted.add("image_data");
      const mimeType = typeof value.mimeType === "string" ? value.mimeType : "image";
      projected.push({
        type: "text",
        text: `[Attached ${mimeType} omitted from bounded history; ${Buffer.byteLength(value.data)} encoded bytes]`,
      });
      continue;
    }
    if (value.type === "text" && typeof value.text === "string") {
      projected.push({ type: "text", text: boundedText(value.text, state) });
      continue;
    }
    if (value.type === "thinking" && typeof value.thinking === "string") {
      projected.push({ type: "thinking", thinking: boundedText(value.thinking, state) });
      continue;
    }
    projected.push(boundedJsonValue(value, state));
  }
  return projected;
}

function projectionMetadata(encodedBytes: number, state: ProjectionState): OversizedProjectionMetadata {
  return {
    kind: "oversized_event",
    original_encoded_bytes: encodedBytes,
    omitted: [...state.omitted].sort(),
    binary_blocks_omitted: state.binaryBlocks,
    preview_truncated: state.previewTruncated,
  };
}

function projectionNotice(metadata: OversizedProjectionMetadata): string {
  const kib = Math.max(1, Math.ceil(metadata.original_encoded_bytes / 1024));
  const what = metadata.binary_blocks_omitted > 0
    ? `${metadata.binary_blocks_omitted} binary/media block${metadata.binary_blocks_omitted === 1 ? "" : "s"}`
    : "oversized content";
  return `[Large event projected for legibility: ${what} omitted; original event ${kib} KiB]`;
}

function withProjectionNotice(content: unknown, notice: string): unknown {
  if (typeof content === "string") return content ? `${content}\n\n${notice}` : notice;
  if (Array.isArray(content)) return [...content, { type: "text", text: notice }];
  return notice;
}

function minimalRolePreservingProjection(row: SerializedMessage, encodedBytes: number): SerializedMessage {
  const source = row.message && typeof row.message === "object"
    ? row.message as Record<string, unknown>
    : {};
  const role = typeof source.role === "string" ? source.role : row.type;
  const metadata: OversizedProjectionMetadata = {
    kind: "oversized_event",
    original_encoded_bytes: encodedBytes,
    omitted: ["content"],
    binary_blocks_omitted: 0,
    preview_truncated: true,
  };
  return {
    type: row.type,
    ...(typeof row.id === "string" ? { id: row.id } : {}),
    ...(row.parentId === null || typeof row.parentId === "string" ? { parentId: row.parentId } : {}),
    ...(row.mutation_status ? { mutation_status: row.mutation_status } : {}),
    message: {
      role,
      content: projectionNotice(metadata),
      ...(smallScalar(source.timestamp) !== undefined ? { timestamp: source.timestamp } : {}),
      ...(smallScalar(source.toolName) !== undefined ? { toolName: source.toolName } : {}),
      ...(smallScalar(source.customType) !== undefined ? { customType: source.customType } : {}),
      transcriptProjection: metadata,
    },
  };
}

/** Preserve event semantics while removing only the fields that make a serialized row oversized. */
export function projectOversizedSerializedMessage(row: SerializedMessage, encodedBytes: number): SerializedMessage {
  const source = row.message && typeof row.message === "object"
    ? row.message as Record<string, unknown>
    : {};
  const state: ProjectionState = {
    remainingTextBytes: PROJECTION_TEXT_BUDGET,
    omitted: new Set<string>(),
    binaryBlocks: 0,
    previewTruncated: false,
  };
  const message: Record<string, unknown> = {
    role: typeof source.role === "string" ? source.role : row.type,
    content: projectedContent(source.content, state),
  };
  for (const key of [
    "timestamp", "model", "stopReason", "errorMessage", "errorKind", "customType",
    "toolCallId", "toolName", "isError", "display", "command", "exitCode", "cancelled", "truncated",
  ]) {
    const value = smallScalar(source[key]);
    if (value !== undefined) message[key] = value;
  }
  if (source.usage !== undefined) message.usage = boundedJsonValue(source.usage, state);
  if (source.output !== undefined) message.output = boundedJsonValue(source.output, state);
  if (source.details !== undefined) {
    state.omitted.add("details");
    const details = boundedJsonValue(source.details, state);
    if (Buffer.byteLength(JSON.stringify(details)) <= 8 * 1024) message.details = details;
  }
  const metadata = projectionMetadata(encodedBytes, state);
  message.content = withProjectionNotice(message.content, projectionNotice(metadata));
  message.transcriptProjection = metadata;
  const projected: SerializedMessage = {
    type: row.type,
    ...(typeof row.id === "string" ? { id: row.id } : {}),
    ...(row.parentId === null || typeof row.parentId === "string" ? { parentId: row.parentId } : {}),
    ...(row.mutation_status ? { mutation_status: row.mutation_status } : {}),
    message,
  };
  return Buffer.byteLength(JSON.stringify(projected)) <= TRANSCRIPT_OVERSIZED_PROJECTION_MAX_BYTES
    ? projected
    : minimalRolePreservingProjection(row, encodedBytes);
}

function decodedJsonStrings(sample: string, field: string, maxValues = 8): string[] {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`"${escaped}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, "gu");
  const values: string[] = [];
  for (const match of sample.matchAll(expression)) {
    try {
      const decoded = JSON.parse(match[1]!);
      if (typeof decoded === "string" && !values.includes(decoded)) values.push(decoded);
    } catch { /* an incomplete sampled token is deliberately ignored */ }
    if (values.length >= maxValues) break;
  }
  return values;
}

function sampleText(prefix: string, suffix: string): string {
  const values = [
    ...decodedJsonStrings(prefix, "text"),
    ...decodedJsonStrings(suffix, "text"),
    ...decodedJsonStrings(prefix, "content"),
    ...decodedJsonStrings(suffix, "content"),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const state: ProjectionState = {
    remainingTextBytes: PROJECTION_TEXT_BUDGET,
    omitted: new Set<string>(),
    binaryBlocks: 0,
    previewTruncated: false,
  };
  return values.map((value) => boundedText(value, state)).filter(Boolean).join("\n");
}

/**
 * Build a role-preserving entry from fixed-size samples. Stable topology comes
 * from the caller's already-validated envelope/index row, never sampled text.
 */
export function projectSampledTranscriptEntry(
  envelope: SampledTranscriptEnvelope,
  prefixBytes: Buffer,
  suffixBytes: Buffer = Buffer.alloc(0),
): any {
  const prefix = prefixBytes.toString("utf8");
  const suffix = suffixBytes.toString("utf8");
  const both = `${prefix}\n${suffix}`;
  const role = decodedJsonStrings(both, "role", 1)[0] ?? "custom";
  const timestamp = decodedJsonStrings(both, "timestamp", 1)[0];
  const toolName = decodedJsonStrings(both, "toolName", 1)[0];
  const customType = decodedJsonStrings(both, "customType", 1)[0];
  const preview = sampleText(prefix, suffix);
  const notice = `[Large ${role} event projected for legibility; original event ${Math.max(1, Math.ceil(envelope.encodedBytes / 1024))} KiB]`;

  if (envelope.eventType === "message") {
    return {
      type: "message",
      id: envelope.id,
      parentId: envelope.parentId,
      ...(timestamp ? { timestamp } : {}),
      message: {
        role,
        content: preview ? `${preview}\n\n${notice}` : notice,
        ...(timestamp ? { timestamp } : {}),
        ...(toolName ? { toolName } : {}),
        transcriptProjection: {
          kind: "oversized_event",
          original_encoded_bytes: envelope.encodedBytes,
          omitted: ["unsampled_content"],
          binary_blocks_omitted: 0,
          preview_truncated: true,
        },
      },
    };
  }

  return {
    type: "custom_message",
    id: envelope.id,
    parentId: envelope.parentId,
    ...(timestamp ? { timestamp } : {}),
    customType: customType ?? `wayang-${envelope.eventType}-projection-v1`,
    content: preview ? `${preview}\n\n${notice}` : notice,
    display: true,
    details: {
      transcriptProjection: {
        kind: "oversized_event",
        original_encoded_bytes: envelope.encodedBytes,
        omitted: ["unsampled_content"],
        binary_blocks_omitted: 0,
        preview_truncated: true,
      },
    },
  };
}

export function projectSampledSessionReadLine(
  prefixBytes: Buffer,
  suffixBytes: Buffer,
  options: { lineNumber: number; encodedBytes?: number; encodedBytesAtLeast?: number },
): string {
  const prefix = prefixBytes.toString("utf8");
  const suffix = suffixBytes.toString("utf8");
  const both = `${prefix}\n${suffix}`;
  const preview = sampleText(prefix, suffix);
  const eventType = decodedJsonStrings(prefix, "type", 1)[0] ?? "unknown";
  const eventId = decodedJsonStrings(prefix, "id", 1)[0];
  const role = decodedJsonStrings(both, "role", 1)[0];
  const toolName = decodedJsonStrings(both, "toolName", 1)[0];
  return JSON.stringify({
    type: "wayang_session_read_projection_v1",
    canonical_line_number: options.lineNumber,
    ...(options.encodedBytes !== undefined ? { canonical_encoded_bytes: options.encodedBytes } : {}),
    ...(options.encodedBytesAtLeast !== undefined ? { canonical_encoded_bytes_at_least: options.encodedBytesAtLeast } : {}),
    event_type: eventType,
    ...(eventId ? { event_id: eventId } : {}),
    ...(role ? { role } : {}),
    ...(toolName ? { tool_name: toolName } : {}),
    preview,
    omitted: true,
    note: "Canonical transcript line exceeded the bounded reader; this is a semantic projection, not the complete event.",
  });
}

export function readSampledTranscriptEntry(
  fd: number,
  envelope: SampledTranscriptEnvelope & { sourceOffset: number },
  observeBytesRead?: (bytes: number) => void,
): any {
  const sampleBytes = Math.min(TRANSCRIPT_OVERSIZED_SAMPLE_BYTES, envelope.encodedBytes);
  const prefix = Buffer.allocUnsafe(sampleBytes);
  const prefixRead = fsRead(fd, prefix, envelope.sourceOffset);
  observeBytesRead?.(prefixRead);
  const remaining = envelope.encodedBytes - prefixRead;
  let suffix = Buffer.alloc(0);
  if (remaining > 0) {
    const suffixLength = Math.min(TRANSCRIPT_OVERSIZED_SAMPLE_BYTES, remaining);
    suffix = Buffer.allocUnsafe(suffixLength);
    const suffixRead = fsRead(fd, suffix, envelope.sourceOffset + envelope.encodedBytes - suffixLength);
    observeBytesRead?.(suffixRead);
    suffix = suffix.subarray(0, suffixRead);
  }
  return projectSampledTranscriptEntry(envelope, prefix.subarray(0, prefixRead), suffix);
}

function fsRead(fd: number, buffer: Buffer, position: number): number {
  let read = 0;
  while (read < buffer.length) {
    const count = fs.readSync(fd, buffer, read, buffer.length - read, position + read);
    if (count === 0) break;
    read += count;
  }
  return read;
}
