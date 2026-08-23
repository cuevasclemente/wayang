import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type {
  TranscriptAnchorResolution,
  TranscriptIntent,
  TranscriptWindowMessage,
  TranscriptWindowReason,
} from "@wayang/protocol";
import { serializeHistoryEntries, type SerializedMessage } from "../pi-bridge.js";
import { TranscriptCursorError, TranscriptCursorRegistry } from "./cursor-registry.js";
import {
  readReverseTranscriptPage,
  readTranscriptFileRevision,
  TranscriptPhysicalRowUnsupportedError,
  sameTranscriptIdentity,
  TRANSCRIPT_PAGE_MAX_BYTES,
  TRANSCRIPT_PAGE_MAX_ROWS,
  type ReversePageContinuation,
  type TranscriptFileRevision,
} from "./reverse-reader.js";
import {
  StructuralTranscriptIndex,
  closeStructuralTranscriptIndex,
  getStructuralTranscriptIndex,
  purgeSharedStructuralTranscriptSession,
  type IndexedWindowSelection,
} from "./structural-index.js";

interface ReverseCursorState {
  kind: "reverse";
  filePath: string;
  continuation: ReversePageContinuation;
  branchTipId: string | null;
}

interface IndexCursorState {
  kind: "index";
  filePath: string;
  indexEpoch: string;
  boundaryVisibleOrdinal: number;
}

type CursorState = ReverseCursorState | IndexCursorState;

interface ColdEpochState {
  revision: TranscriptFileRevision;
  transcriptEpoch: string;
  branchTipId: string | null;
  tailWitness: string;
}

const TRANSCRIPT_STREAMING_MESSAGE_BUDGET = 128 * 1024;
const TRANSCRIPT_MESSAGE_BUDGET = TRANSCRIPT_PAGE_MAX_BYTES - TRANSCRIPT_STREAMING_MESSAGE_BUDGET - 4_096;

interface BoundedSerialization {
  messages: SerializedMessage[];
  payloadBytes: number;
  firstId: string | null;
  lastId: string | null;
  /** True only when byte bounding removed one or more earlier serialized rows. */
  trimmedEarlier: boolean;
}

export interface OpenTranscriptWindowInput {
  sessionId: string;
  selectionId: string;
  sessionFile: string | null | undefined;
  intent: TranscriptIntent;
  anchorId?: string;
  reason?: TranscriptWindowReason;
  requestId?: string;
  streamingAtSnapshot?: boolean;
  compactingAtSnapshot?: boolean;
  /** Already-frozen ID-less runtime overlay captured by the transport. */
  streamingMessage?: SerializedMessage | null;
  /** Descendant tail reconciliation keeps still-valid older edge cursors. */
  preserveCursors?: boolean;
}

export interface PageTranscriptWindowInput {
  sessionId: string;
  selectionId: string;
  sessionFile: string | null | undefined;
  requestId: string;
  direction: "before" | "after";
  cursor: string;
}

function rowPlaceholder(row: SerializedMessage, encodedBytes: number): SerializedMessage {
  return {
    type: "custom",
    ...(typeof row.id === "string" ? { id: row.id } : {}),
    ...(row.parentId === null || typeof row.parentId === "string" ? { parentId: row.parentId } : {}),
    message: {
      role: "custom",
      customType: "wayang-transcript-event-placeholder-v1",
      content: "This transcript event is too large to include in a bounded window.",
      display: true,
      details: { reason: "payload_limit", encoded_bytes: encodedBytes },
    },
  };
}

function boundedSerialization(
  entries: any[],
  preference: "latest" | "earliest" | "around",
  anchorId?: string | null,
): BoundedSerialization {
  let messages = serializeHistoryEntries(entries).slice(0, TRANSCRIPT_PAGE_MAX_ROWS);
  messages = messages.map((row) => {
    const bytes = Buffer.byteLength(JSON.stringify(row));
    return bytes > TRANSCRIPT_MESSAGE_BUDGET - 1024 ? rowPlaceholder(row, bytes) : row;
  });
  let anchorIndex = anchorId ? messages.findIndex((row) => row.id === anchorId) : -1;
  let trimmedEarlier = false;
  if (anchorIndex < 0) anchorIndex = Math.floor(Math.max(0, messages.length - 1) / 2);
  const bytes = () => Buffer.byteLength(JSON.stringify(messages));
  while (messages.length > 1 && bytes() > TRANSCRIPT_MESSAGE_BUDGET) {
    if (preference === "latest") {
      messages.shift();
      trimmedEarlier = true;
    }
    else if (preference === "earliest") messages.pop();
    else {
      const leftDistance = anchorIndex;
      const rightDistance = messages.length - 1 - anchorIndex;
      if (leftDistance > rightDistance) {
        messages.shift();
        trimmedEarlier = true;
        anchorIndex--;
      } else messages.pop();
    }
  }
  if (messages.length === 1 && bytes() > TRANSCRIPT_MESSAGE_BUDGET) {
    messages = [rowPlaceholder(messages[0], bytes())];
  }
  const firstRow = messages[0];
  const lastRow = messages.at(-1);
  return {
    messages,
    payloadBytes: Buffer.byteLength(JSON.stringify(messages)),
    firstId: typeof firstRow?.id === "string" ? firstRow.id : null,
    lastId: typeof lastRow?.id === "string" ? lastRow.id : null,
    trimmedEarlier,
  };
}

function streamingMessagePlaceholder(encodedBytes: number): SerializedMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{
        type: "text",
        text: "The in-progress assistant message is too large to include in this bounded snapshot.",
      }],
      streamingPlaceholder: true,
      encodedBytes,
    },
  };
}

function boundedStreamingMessage(message: SerializedMessage | null | undefined): SerializedMessage | undefined {
  if (!message) return undefined;
  const idLessMessage: SerializedMessage = { type: message.type };
  for (const [key, value] of Object.entries(message)) {
    if (key !== "id" && key !== "parentId" && key !== "type") idLessMessage[key] = value;
  }
  const encodedBytes = Buffer.byteLength(JSON.stringify(idLessMessage));
  return encodedBytes <= TRANSCRIPT_STREAMING_MESSAGE_BUDGET
    ? idLessMessage
    : streamingMessagePlaceholder(encodedBytes);
}

function boundedReverseContinuation(
  reverse: ReturnType<typeof readReverseTranscriptPage>,
  bounded: BoundedSerialization,
): ReversePageContinuation | null {
  // The reverse reader is authoritative about reaching the branch root. A
  // hidden parent (for example session_info) of the first displayed row must
  // not recreate an edge after that hidden entry was already scanned. Only
  // reconstruct from the displayed boundary when byte bounding actually
  // removed earlier serialized rows.
  if (!bounded.trimmedEarlier) return reverse.continuation;
  if (!bounded.firstId) return reverse.continuation;
  const firstEntry = reverse.entries.find((entry) => entry?.id === bounded.firstId);
  const beforeOffset = reverse.entryOffsets[bounded.firstId];
  if (!firstEntry || beforeOffset === undefined || typeof firstEntry.parentId !== "string") return null;
  return { beforeOffset, nextAncestorId: firstEntry.parentId };
}

function prefixTailWitness(filePath: string, end: number): string {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < end) return "";
    const start = Math.max(0, end - 4_096);
    const bytes = Buffer.allocUnsafe(end - start);
    const read = fs.readSync(fd, bytes, 0, bytes.length, start);
    return createHash("sha256").update(bytes.subarray(0, read)).digest("hex");
  } catch { return ""; }
  finally { fs.closeSync(fd); }
}

export class TranscriptPaginationService {
  private readonly cursors = new TranscriptCursorRegistry<CursorState>();
  private readonly index: StructuralTranscriptIndex;
  private readonly sharedIndex: boolean;
  private readonly coldEpochs = new Map<string, ColdEpochState>();
  private readonly selectionEpochs = new Map<string, string>();

  constructor(index?: StructuralTranscriptIndex) {
    this.index = index ?? getStructuralTranscriptIndex();
    this.sharedIndex = index === undefined;
  }

  async open(input: OpenTranscriptWindowInput): Promise<TranscriptWindowMessage> {
    if (!input.preserveCursors) this.cursors.invalidateSelection(input.sessionId, input.selectionId);
    if (!input.sessionFile) {
      const transcriptEpoch = this.selectionEpochs.get(this.selectionKey(input.sessionId, input.selectionId)) ?? randomUUID();
      this.selectionEpochs.set(this.selectionKey(input.sessionId, input.selectionId), transcriptEpoch);
      return this.message(input, transcriptEpoch, null, [], 2, null, null, false, false);
    }
    if (input.intent === "around" && input.anchorId) {
      try { return await this.openAround(input, input.anchorId); }
      catch {
        void this.index.ensure(input.sessionId, input.sessionFile!).catch(() => undefined);
        const latest = this.openLatestWithStructuralFallback({ ...input, intent: "latest" });
        latest.anchor = { requested_id: input.anchorId, resolved_id: null, status: "pending" };
        return latest;
      }
    }
    return this.openLatestWithStructuralFallback(input);
  }

  async page(input: PageTranscriptWindowInput): Promise<TranscriptWindowMessage> {
    if (!input.sessionFile) throw new TranscriptCursorError("unknown_cursor");
    const selectionKey = this.selectionKey(input.sessionId, input.selectionId);
    const expectedEpoch = this.selectionEpochs.get(selectionKey);
    if (!expectedEpoch) throw new TranscriptCursorError("selection_mismatch");
    const record = this.cursors.resolve(input.cursor, {
      sessionId: input.sessionId,
      selectionId: input.selectionId,
      transcriptEpoch: expectedEpoch,
      direction: input.direction,
    });
    if (record.state.filePath !== input.sessionFile) throw new TranscriptCursorError("session_mismatch");
    if (record.state.kind === "reverse") {
      if (input.direction !== "before") throw new TranscriptCursorError("direction_mismatch");
      let reverse: ReturnType<typeof readReverseTranscriptPage>;
      try {
        reverse = readReverseTranscriptPage(input.sessionFile, { continuation: record.state.continuation });
      } catch (error) {
        if (!(error instanceof TranscriptPhysicalRowUnsupportedError)) throw error;
        const indexed = record.state.continuation.nextAncestorId
          ? this.index.tryBeforeEventCurrent(
              input.sessionId, input.sessionFile, record.state.continuation.nextAncestorId, TRANSCRIPT_PAGE_MAX_ROWS,
            )
          : null;
        if (!indexed) throw error;
        return this.indexedMessage(
          { ...input, intent: "latest", reason: "prepend" }, indexed, "latest", expectedEpoch,
        );
      }
      const priorCold = this.coldEpochs.get(input.sessionId);
      const tailProbe = priorCold && priorCold.revision.size !== reverse.revision.size
        ? readReverseTranscriptPage(input.sessionFile, { maxRows: TRANSCRIPT_PAGE_MAX_ROWS })
        : null;
      if (tailProbe && (tailProbe.revision.size !== reverse.revision.size
        || tailProbe.revision.mtimeMs !== reverse.revision.mtimeMs
        || tailProbe.revision.ctimeMs !== reverse.revision.ctimeMs
        || !sameTranscriptIdentity(tailProbe.revision, reverse.revision))) {
        throw new Error("Transcript changed while an adjacent page was being read");
      }
      const currentBranchTip = tailProbe?.branchTipId ?? priorCold?.branchTipId ?? record.state.branchTipId;
      const epoch = this.resolveColdEpoch(
        input.sessionId,
        input.sessionFile,
        reverse.revision,
        currentBranchTip,
        tailProbe?.entries ?? [],
      );
      if (epoch !== expectedEpoch) throw new TranscriptCursorError("epoch_mismatch");
      if (reverse.scanCeilingReached) void this.index.ensure(input.sessionId, input.sessionFile).catch(() => undefined);
      const bounded = boundedSerialization(reverse.entries, "latest");
      const continuation = boundedReverseContinuation(reverse, bounded);
      const beforeCursor = continuation ? this.cursors.issue({
        sessionId: input.sessionId, selectionId: input.selectionId, transcriptEpoch: epoch, direction: "before",
      }, { kind: "reverse", filePath: input.sessionFile, continuation, branchTipId: currentBranchTip }) : null;
      return this.message({ ...input, intent: "latest", reason: "prepend" }, epoch,
        currentBranchTip, bounded.messages, bounded.payloadBytes, beforeCursor, null, Boolean(beforeCursor), true);
    }
    const selection = await this.index.adjacent(input.sessionId, input.sessionFile, input.direction,
      record.state.boundaryVisibleOrdinal, TRANSCRIPT_PAGE_MAX_ROWS);
    if (selection.revision.transcriptEpoch !== record.state.indexEpoch) throw new TranscriptCursorError("epoch_mismatch");
    return this.indexedMessage({ ...input, intent: "latest", reason: input.direction === "before" ? "prepend" : "append" }, selection,
      input.direction === "before" ? "latest" : "earliest", expectedEpoch);
  }

  isDerivedProjectionCurrent(
    sessionId: string,
    filePath: string,
    transcriptEpoch: string,
    fingerprint: TranscriptFileRevision,
  ): boolean {
    const state = this.coldEpochs.get(sessionId);
    if (!state || state.transcriptEpoch !== transcriptEpoch
      || state.revision.size !== fingerprint.size
      || state.revision.mtimeMs !== fingerprint.mtimeMs
      || state.revision.ctimeMs !== fingerprint.ctimeMs
      || !sameTranscriptIdentity(state.revision, fingerprint)) return false;
    try {
      const current = readTranscriptFileRevision(filePath);
      return current.size === fingerprint.size
        && current.mtimeMs === fingerprint.mtimeMs
        && current.ctimeMs === fingerprint.ctimeMs
        && sameTranscriptIdentity(current, fingerprint);
    } catch { return false; }
  }

  discardSelection(sessionId: string, selectionId: string): void {
    this.cursors.invalidateSelection(sessionId, selectionId);
    this.selectionEpochs.delete(this.selectionKey(sessionId, selectionId));
  }

  invalidateSession(sessionId: string): void {
    this.cursors.invalidateSession(sessionId);
    this.coldEpochs.delete(sessionId);
    for (const key of this.selectionEpochs.keys()) if (key.startsWith(`${sessionId}\0`)) this.selectionEpochs.delete(key);
    this.index.purge(sessionId);
  }

  async close(): Promise<void> {
    this.cursors.clear();
    this.coldEpochs.clear();
    this.selectionEpochs.clear();
    if (this.sharedIndex) await closeStructuralTranscriptIndex();
    else await this.index.close();
  }

  private openLatestWithStructuralFallback(input: OpenTranscriptWindowInput): TranscriptWindowMessage {
    try { return this.openLatest(input); }
    catch (error) {
      if (!(error instanceof TranscriptPhysicalRowUnsupportedError) || !input.sessionFile) throw error;
      const indexed = this.index.tryLatestCurrent(input.sessionId, input.sessionFile, TRANSCRIPT_PAGE_MAX_ROWS);
      if (!indexed) throw error;
      const existingCold = this.coldEpochs.get(input.sessionId);
      const wireEpoch = existingCold && sameTranscriptIdentity(existingCold.revision, indexed.revision)
        && existingCold.revision.size === indexed.revision.size
        && existingCold.revision.mtimeMs === indexed.revision.mtimeMs
        && existingCold.revision.ctimeMs === indexed.revision.ctimeMs
        ? existingCold.transcriptEpoch
        : indexed.revision.transcriptEpoch;
      this.coldEpochs.set(input.sessionId, {
        revision: indexed.revision,
        transcriptEpoch: wireEpoch,
        branchTipId: indexed.revision.branchTipId,
        tailWitness: prefixTailWitness(input.sessionFile, indexed.revision.size),
      });
      this.selectionEpochs.set(this.selectionKey(input.sessionId, input.selectionId), wireEpoch);
      return this.indexedMessage(input, indexed, "latest", wireEpoch);
    }
  }

  private openLatest(input: OpenTranscriptWindowInput): TranscriptWindowMessage {
    const reverse = readReverseTranscriptPage(input.sessionFile!);
    const epoch = this.resolveColdEpoch(input.sessionId, input.sessionFile!, reverse.revision, reverse.branchTipId, reverse.entries);
    if (reverse.scanCeilingReached) void this.index.ensure(input.sessionId, input.sessionFile!).catch(() => undefined);
    const selectionKey = this.selectionKey(input.sessionId, input.selectionId);
    const previousEpoch = this.selectionEpochs.get(selectionKey);
    this.selectionEpochs.set(selectionKey, epoch);
    const epochChangedDuringReconcile = Boolean(input.preserveCursors && previousEpoch && previousEpoch !== epoch);
    if (epochChangedDuringReconcile) this.cursors.invalidateSelection(input.sessionId, input.selectionId);
    const effectiveInput = epochChangedDuringReconcile
      ? { ...input, reason: "reset" as const, preserveCursors: false }
      : input;
    const bounded = boundedSerialization(reverse.entries, "latest");
    const continuation = boundedReverseContinuation(reverse, bounded);
    const beforeCursor = continuation ? this.cursors.issue({
      sessionId: input.sessionId, selectionId: input.selectionId, transcriptEpoch: epoch, direction: "before",
    }, { kind: "reverse", filePath: input.sessionFile!, continuation, branchTipId: reverse.branchTipId }) : null;
    return this.message(effectiveInput, epoch, reverse.branchTipId, bounded.messages, bounded.payloadBytes,
      beforeCursor, null, Boolean(beforeCursor), false);
  }

  private async openAround(input: OpenTranscriptWindowInput, anchorId: string): Promise<TranscriptWindowMessage> {
    const selection = await this.index.around(input.sessionId, input.sessionFile!, anchorId, TRANSCRIPT_PAGE_MAX_ROWS);
    const existingCold = this.coldEpochs.get(input.sessionId);
    const wireEpoch = existingCold && sameTranscriptIdentity(existingCold.revision, selection.revision)
      && existingCold.revision.size === selection.revision.size
      && existingCold.revision.mtimeMs === selection.revision.mtimeMs
      && existingCold.revision.ctimeMs === selection.revision.ctimeMs
      ? existingCold.transcriptEpoch
      : selection.revision.transcriptEpoch;
    this.coldEpochs.set(input.sessionId, {
      revision: selection.revision,
      transcriptEpoch: wireEpoch,
      branchTipId: selection.revision.branchTipId,
      tailWitness: prefixTailWitness(input.sessionFile!, selection.revision.size),
    });
    this.selectionEpochs.set(this.selectionKey(input.sessionId, input.selectionId), wireEpoch);
    return this.indexedMessage(input, selection, "around", wireEpoch);
  }

  private indexedMessage(
    input: OpenTranscriptWindowInput,
    selection: IndexedWindowSelection,
    preference: "latest" | "earliest" | "around",
    wireEpoch = selection.revision.transcriptEpoch,
  ): TranscriptWindowMessage {
    const indexedRead = this.index.readBoundedEntries(selection.revision, selection.rows, {
      preference,
      anchorEventId: selection.anchor?.resolved_id,
    });
    const bounded = boundedSerialization(indexedRead.entries, preference, selection.anchor?.resolved_id);
    const rowById = new Map(indexedRead.rows.map((row) => [row.eventId, row]));
    const first = (bounded.firstId && rowById.get(bounded.firstId)) ?? indexedRead.rows[0];
    const last = (bounded.lastId && rowById.get(bounded.lastId)) ?? indexedRead.rows.at(-1);
    const beforeCursor = first && (selection.hasOlder || first.visibleOrdinal > 0)
      ? this.cursors.issue({ sessionId: input.sessionId, selectionId: input.selectionId,
          transcriptEpoch: wireEpoch, direction: "before" },
        { kind: "index", filePath: selection.revision.filePath, indexEpoch: selection.revision.transcriptEpoch, boundaryVisibleOrdinal: first.visibleOrdinal })
      : null;
    const selectedLast = selection.rows.at(-1);
    const afterCursor = last && (selection.hasNewer
      || Boolean(selectedLast && last.visibleOrdinal < selectedLast.visibleOrdinal))
      ? this.cursors.issue({ sessionId: input.sessionId, selectionId: input.selectionId,
          transcriptEpoch: wireEpoch, direction: "after" },
        { kind: "index", filePath: selection.revision.filePath, indexEpoch: selection.revision.transcriptEpoch, boundaryVisibleOrdinal: last.visibleOrdinal })
      : null;
    return this.message(input, wireEpoch, selection.revision.branchTipId,
      bounded.messages, bounded.payloadBytes, beforeCursor, afterCursor, Boolean(beforeCursor), Boolean(afterCursor),
      selection.anchor ?? undefined);
  }

  private resolveColdEpoch(
    sessionId: string,
    filePath: string,
    revision: TranscriptFileRevision,
    branchTipId: string | null,
    scannedEntries: readonly any[],
  ): string {
    const existing = this.coldEpochs.get(sessionId);
    if (existing && sameTranscriptIdentity(existing.revision, revision)) {
      if ((revision.size === existing.revision.size
          && revision.mtimeMs === existing.revision.mtimeMs
          && revision.ctimeMs === existing.revision.ctimeMs)
        || (revision.size > existing.revision.size
          && prefixTailWitness(filePath, existing.revision.size) === existing.tailWitness
          && (existing.branchTipId === branchTipId || existing.branchTipId === null
            || scannedEntries.some((entry) => entry?.id === existing.branchTipId)))) {
        existing.revision = revision;
        existing.branchTipId = branchTipId;
        existing.tailWitness = prefixTailWitness(filePath, revision.size);
        return existing.transcriptEpoch;
      }
    }
    const created = {
      revision,
      transcriptEpoch: randomUUID(),
      branchTipId,
      tailWitness: prefixTailWitness(filePath, revision.size),
    };
    this.coldEpochs.set(sessionId, created);
    return created.transcriptEpoch;
  }

  private message(
    input: OpenTranscriptWindowInput,
    transcriptEpoch: string,
    branchTipId: string | null,
    messages: SerializedMessage[],
    payloadBytes: number,
    beforeCursor: string | null,
    afterCursor: string | null,
    hasOlder: boolean,
    hasNewer: boolean,
    anchor?: TranscriptAnchorResolution,
  ): TranscriptWindowMessage {
    const streamingMessage = boundedStreamingMessage(input.streamingMessage);
    if (streamingMessage) payloadBytes += Buffer.byteLength(JSON.stringify(streamingMessage));
    return {
      type: "transcript_window",
      session_id: input.sessionId,
      selection_id: input.selectionId,
      ...(input.requestId ? { request_id: input.requestId } : {}),
      reason: input.reason ?? "initial",
      transcript_epoch: transcriptEpoch,
      branch_tip_id: branchTipId,
      messages,
      ...(streamingMessage ? { streaming_message: streamingMessage } : {}),
      before_cursor: beforeCursor,
      after_cursor: afterCursor,
      has_older: hasOlder,
      has_newer: hasNewer,
      ...(anchor ? { anchor } : {}),
      ...(input.streamingAtSnapshot === undefined ? {} : { streaming_at_snapshot: input.streamingAtSnapshot }),
      ...(input.compactingAtSnapshot === undefined ? {} : { compacting_at_snapshot: input.compactingAtSnapshot }),
      message_count: messages.length,
      payload_bytes: payloadBytes,
    };
  }

  private selectionKey(sessionId: string, selectionId: string): string {
    return `${sessionId}\0${selectionId}`;
  }
}

let singleton: TranscriptPaginationService | null = null;

export function getTranscriptPaginationService(): TranscriptPaginationService {
  return singleton ??= new TranscriptPaginationService();
}

export function invalidateTranscriptPaginationSession(sessionId: string): void {
  if (singleton) singleton.invalidateSession(sessionId);
  else purgeSharedStructuralTranscriptSession(sessionId);
}

export async function closeTranscriptPagination(): Promise<void> {
  const service = singleton;
  singleton = null;
  if (service) await service.close();
  else await closeStructuralTranscriptIndex();
}
