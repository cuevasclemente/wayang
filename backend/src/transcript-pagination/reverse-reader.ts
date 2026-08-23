import { createHash } from "node:crypto";
import * as fs from "node:fs";

export const TRANSCRIPT_PAGE_MAX_ROWS = 200;
export const TRANSCRIPT_PAGE_MAX_BYTES = 512 * 1024;
export const TRANSCRIPT_REVERSE_MAX_SCAN_BYTES = 16 * 1024 * 1024;
const HEADER_MAX_BYTES = 256 * 1024;
const REVERSE_BOUNDARY_BLOCK_BYTES = 64 * 1024;
const OVERSIZED_ENVELOPE_PREFIX_BYTES = 256 * 1024;

export interface TranscriptFileRevision {
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  headerDigest: string;
  mutationEpoch: string;
}

export interface ReversePageContinuation {
  beforeOffset: number;
  nextAncestorId: string | null;
}

export interface ReverseTranscriptPage {
  entries: any[];
  revision: TranscriptFileRevision;
  branchTipId: string | null;
  entryOffsets: Readonly<Record<string, number>>;
  continuation: ReversePageContinuation | null;
  hasOlder: boolean;
  scanCeilingReached: boolean;
}

export class TranscriptRevisionChangedError extends Error {
  readonly code = "transcript_revision_changed";
  constructor() {
    super("Transcript changed while a page was being read");
  }
}

interface ParsedPhysicalLine {
  start: number;
  end: number;
  value: any;
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function openRegularNoFollow(filePath: string): number {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("Transcript is not a regular file");
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readHeader(fd: number, size: number): { digest: string; mutationEpoch: string } {
  const length = Math.min(size, HEADER_MAX_BYTES);
  const bytes = Buffer.allocUnsafe(length);
  const read = fs.readSync(fd, bytes, 0, length, 0);
  const view = bytes.subarray(0, read);
  const newline = view.indexOf(0x0a);
  const header = view.subarray(0, newline >= 0 ? newline : view.length);
  const headerDigest = digest(header);
  let mutationEpoch = headerDigest;
  try {
    const parsed = JSON.parse(header.toString("utf8").replace(/\r$/u, ""));
    const explicit = parsed?.mutationEpoch ?? parsed?.mutation_epoch ?? parsed?.wayangMutationEpoch;
    if (typeof explicit === "string" || typeof explicit === "number") mutationEpoch = String(explicit);
  } catch { /* a malformed header is represented by its digest */ }
  return { digest: headerDigest, mutationEpoch };
}

function revisionFromDescriptor(fd: number): TranscriptFileRevision {
  const stat = fs.fstatSync(fd);
  const header = readHeader(fd, stat.size);
  return {
    device: Number(stat.dev) || 0,
    inode: Number(stat.ino) || 0,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    headerDigest: header.digest,
    mutationEpoch: header.mutationEpoch,
  };
}

function assertPathStillMatches(filePath: string, fd: number, expected: TranscriptFileRevision): void {
  const descriptor = revisionFromDescriptor(fd);
  let pathStat: fs.Stats;
  try { pathStat = fs.lstatSync(filePath); }
  catch { throw new TranscriptRevisionChangedError(); }
  if (!pathStat.isFile()
    || descriptor.device !== expected.device
    || descriptor.inode !== expected.inode
    || descriptor.size !== expected.size
    || descriptor.mtimeMs !== expected.mtimeMs
    || descriptor.ctimeMs !== expected.ctimeMs
    || descriptor.headerDigest !== expected.headerDigest
    || Number(pathStat.dev) !== expected.device
    || Number(pathStat.ino) !== expected.inode
    || pathStat.size !== expected.size) {
    throw new TranscriptRevisionChangedError();
  }
}

function newestPhysicalLineBounds(fd: number, end: number): { start: number; end: number } | null {
  if (end <= 0) return null;
  let lineEnd = end;
  const trailing = Buffer.allocUnsafe(1);
  if (fs.readSync(fd, trailing, 0, 1, end - 1) === 1 && trailing[0] === 0x0a) lineEnd--;
  if (lineEnd <= 0) return null;
  let cursor = lineEnd;
  while (cursor > 0) {
    const start = Math.max(0, cursor - REVERSE_BOUNDARY_BLOCK_BYTES);
    const block = Buffer.allocUnsafe(cursor - start);
    const read = fs.readSync(fd, block, 0, block.length, start);
    for (let index = read - 1; index >= 0; index--) {
      if (block[index] === 0x0a) return { start: start + index + 1, end: lineEnd };
    }
    cursor = start;
  }
  return { start: 0, end: lineEnd };
}

function decodeJsonStringField(prefix: string, name: string): string | null | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"${escapedName}"\\s*:\\s*(null|"(?:\\\\.|[^"\\\\])*")`, "u").exec(prefix);
  if (!match) return undefined;
  if (match[1] === "null") return null;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" ? value : undefined;
  } catch { return undefined; }
}

function oversizedEnvelopePlaceholder(
  fd: number,
  bounds: { start: number; end: number },
): { entry: any; eventType: string; id: string; parentId: string | null } {
  const prefixLength = Math.min(bounds.end - bounds.start, OVERSIZED_ENVELOPE_PREFIX_BYTES);
  const bytes = Buffer.allocUnsafe(prefixLength);
  const read = fs.readSync(fd, bytes, 0, bytes.length, bounds.start);
  const prefix = bytes.subarray(0, read).toString("utf8");
  const type = decodeJsonStringField(prefix, "type");
  const id = decodeJsonStringField(prefix, "id");
  const parentId = decodeJsonStringField(prefix, "parentId");
  if (typeof type !== "string" || typeof id !== "string" || id.length === 0 || parentId === undefined) {
    throw new Error("Oversized transcript row has no bounded stable envelope");
  }
  return {
    eventType: type,
    id,
    parentId,
    entry: {
      type: "custom_message",
      id,
      parentId,
      customType: "wayang-transcript-event-placeholder-v1",
      content: "This transcript event is too large to include in a bounded window.",
      display: true,
      details: { reason: "payload_limit", encoded_bytes: bounds.end - bounds.start },
    },
  };
}

function parseReverseRange(fd: number, start: number, end: number): ParsedPhysicalLine[] {
  if (end <= start) return [];
  const bytes = Buffer.allocUnsafe(end - start);
  const count = fs.readSync(fd, bytes, 0, bytes.length, start);
  const view = bytes.subarray(0, count);
  const lines: ParsedPhysicalLine[] = [];
  let lineStart = 0;
  for (let index = 0; index <= view.length; index++) {
    if (index !== view.length && view[index] !== 0x0a) continue;
    // A bounded range beginning mid-line cannot safely parse that first suffix.
    if (!(start > 0 && lineStart === 0)) {
      let lineEnd = index;
      if (lineEnd > lineStart && view[lineEnd - 1] === 0x0d) lineEnd--;
      const raw = view.subarray(lineStart, lineEnd);
      if (raw.length > 0) {
        try {
          lines.push({ start: start + lineStart, end: start + index + (index < view.length ? 1 : 0), value: JSON.parse(raw.toString("utf8")) });
        } catch { /* tolerate malformed/partial physical lines like Pi */ }
      }
    }
    lineStart = index + 1;
  }
  return lines.reverse();
}

/** Structural visibility only. Exact serialization remains owned by pi-bridge. */
export function isStructurallyVisibleTranscriptEntry(entry: any): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (entry.type === "message" || entry.type === "custom_message") return true;
  if (entry.type === "branch_summary" || entry.type === "compaction") return typeof entry.summary === "string" && entry.summary.length > 0;
  if (entry.type !== "custom") return false;
  return entry.customType === "wayang-deleted-event-v1" || entry.customType === "wayang-agent-change";
}

export function sameTranscriptIdentity(
  left: Pick<TranscriptFileRevision, "device" | "inode" | "headerDigest" | "mutationEpoch">,
  right: Pick<TranscriptFileRevision, "device" | "inode" | "headerDigest" | "mutationEpoch">,
): boolean {
  return left.device === right.device && left.inode === right.inode
    && left.headerDigest === right.headerDigest && left.mutationEpoch === right.mutationEpoch;
}

export function readTranscriptFileRevision(filePath: string): TranscriptFileRevision {
  const fd = openRegularNoFollow(filePath);
  try { return revisionFromDescriptor(fd); }
  finally { fs.closeSync(fd); }
}

/**
 * Read the active branch backwards without opening a Pi SessionManager.
 * Continuations carry server-side offsets only and must never be exposed directly.
 */
export function readReverseTranscriptPage(
  filePath: string,
  options: {
    continuation?: ReversePageContinuation;
    maxRows?: number;
    maxScanBytes?: number;
  } = {},
): ReverseTranscriptPage {
  const fd = openRegularNoFollow(filePath);
  try {
    const revision = revisionFromDescriptor(fd);
    let end = Math.min(options.continuation?.beforeOffset ?? revision.size, revision.size);
    const maxScanBytes = options.maxScanBytes ?? TRANSCRIPT_REVERSE_MAX_SCAN_BYTES;
    if (!options.continuation) {
      const newestBounds = newestPhysicalLineBounds(fd, end);
      if (newestBounds && newestBounds.end - newestBounds.start > maxScanBytes) {
        const oversized = oversizedEnvelopePlaceholder(fd, newestBounds);
        if (oversized.eventType === "session" || oversized.eventType === "session_info") {
          end = newestBounds.start;
        } else {
          const continuation = oversized.parentId === null
            ? null
            : { beforeOffset: newestBounds.start, nextAncestorId: oversized.parentId };
          assertPathStillMatches(filePath, fd, revision);
          return {
            entries: [oversized.entry],
            revision,
            branchTipId: oversized.id,
            entryOffsets: Object.freeze({ [oversized.id]: newestBounds.start }),
            continuation,
            hasOlder: continuation !== null,
            scanCeilingReached: continuation !== null,
          };
        }
      }
    }
    const start = Math.max(0, end - maxScanBytes);
    const lines = parseReverseRange(fd, start, end);
    const maxRows = options.maxRows ?? TRANSCRIPT_PAGE_MAX_ROWS;
    let neededId = options.continuation?.nextAncestorId ?? null;
    let branchTipId: string | null = options.continuation ? null : null;
    const newestToOldest: any[] = [];
    const entryOffsets: Record<string, number> = Object.create(null);
    let visibleRows = 0;
    let oldestOffset = end;
    let foundTip = Boolean(options.continuation);

    for (const line of lines) {
      const entry = line.value;
      if (!entry || typeof entry !== "object") continue;
      if (!foundTip) {
        if (entry.type === "session" || entry.type === "session_info" || typeof entry.id !== "string") continue;
        foundTip = true;
        branchTipId = entry.id;
        neededId = entry.id;
      }
      if (typeof entry.id !== "string" || entry.id !== neededId) continue;
      newestToOldest.push(entry);
      entryOffsets[entry.id] = line.start;
      oldestOffset = line.start;
      neededId = typeof entry.parentId === "string" ? entry.parentId : null;
      if (isStructurallyVisibleTranscriptEntry(entry)) visibleRows++;
      if (visibleRows >= maxRows) break;
      if (neededId === null) break;
    }

    const continuation = neededId === null
      ? null
      : newestToOldest.length > 0
        ? { beforeOffset: oldestOffset, nextAncestorId: neededId }
        : options.continuation && start > 0
          ? { beforeOffset: start, nextAncestorId: neededId }
          : null;
    assertPathStillMatches(filePath, fd, revision);
    return {
      entries: newestToOldest.reverse(),
      revision,
      branchTipId,
      entryOffsets,
      continuation,
      hasOlder: continuation !== null,
      scanCeilingReached: continuation !== null && start > 0 && visibleRows < maxRows,
    };
  } finally {
    fs.closeSync(fd);
  }
}
