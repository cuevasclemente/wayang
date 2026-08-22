/**
 * search/chunker.ts — Convert a pi JSONL session transcript into search chunks.
 *
 * v1 rules (see docs/session-history-search.md):
 *   1. Stream JSONL line by line; skip non-`message` types.
 *   2. Keep only items where message.role ∈ {user, assistant} and each
 *      content item has type="text".
 *   3. Keep one exact message id per utterance (multiple text blocks from the
 *      same message may coalesce; adjacent same-role messages may not).
 *   4. Emit message-bound chunks of ≤ MAX_CHUNK_CHARS. Oversized messages are
 *      split with bounded within-message overlap so every result anchor remains exact.
 *   5. One synthetic role='meta' chunk per session, so metadata-only sessions
 *      are still searchable.
 *
 * v1 also supports an opt-in `role='thinking'` chunk stream for `searchIncludeThinking`.
 */

import * as fs from "node:fs";
import * as readline from "node:readline";
import type { Chunk } from "./types.js";

export const MAX_CHUNK_CHARS = 2000;
export const OVERLAP_CHARS = 200;

export interface MetaForChunker {
  title: string;
  goal?: string | null;
  cwd: string;
  model?: string | null;
}

export interface ChunkerOptions {
  includeThinking?: boolean;
}

export interface ChunkerStats {
  linesRead: number;
  messagesUsed: number;
  utterancesEmitted: number;
  skippedParseErrors: number;
}

export interface ChunkerResult {
  chunks: Chunk[];
  stats: ChunkerStats;
}

interface Utterance {
  role: "user" | "assistant" | "thinking";
  text: string;
  messageId: string | null;
  sourceOffset: number;
}

/**
 * Synchronous chunker reading a JSONL file. Streams line by line to avoid
 * holding the whole file in memory.
 *
 * Returns a synthetic `meta` chunk first, then transcript-derived chunks.
 */
export async function chunkJsonlFile(
  filePath: string,
  meta: MetaForChunker,
  options: ChunkerOptions = {},
): Promise<ChunkerResult> {
  const stats: ChunkerStats = {
    linesRead: 0,
    messagesUsed: 0,
    utterancesEmitted: 0,
    skippedParseErrors: 0,
  };

  const utterances: Utterance[] = [];
  let pending: Utterance | null = null;

  const flushPending = (): void => {
    if (pending) {
      utterances.push(pending);
      stats.utterancesEmitted++;
      pending = null;
    }
  };

  let byteOffset = 0;

  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const lineByteLen = Buffer.byteLength(rawLine, "utf-8") + 1; // +1 for \n
    const currentOffset = byteOffset;
    byteOffset += lineByteLen;
    stats.linesRead++;

    if (!rawLine) continue;
    let obj: any;
    try {
      obj = JSON.parse(rawLine);
    } catch {
      stats.skippedParseErrors++;
      continue;
    }

    if (!obj || obj.type !== "message") continue;
    const message = obj.message ?? obj;
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue;

    const content = message.content;
    if (content == null) continue;

    const parts: Array<{ kind: "text" | "thinking"; text: string }> = [];
    if (typeof content === "string") {
      parts.push({ kind: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const t = part.type;
        if (t === "text" && typeof part.text === "string") {
          parts.push({ kind: "text", text: part.text });
        } else if (
          options.includeThinking &&
          t === "thinking" &&
          typeof part.thinking === "string"
        ) {
          parts.push({ kind: "thinking", text: part.thinking });
        }
      }
    } else {
      continue;
    }

    if (parts.length === 0) continue;
    stats.messagesUsed++;

    const messageId = typeof obj.id === "string" ? obj.id : null;

    for (const part of parts) {
      const partRole: Utterance["role"] = part.kind === "thinking" ? "thinking" : role;
      const text = part.text.trim();
      if (!text) continue;

      if (pending && pending.role === partRole && pending.messageId === messageId) {
        pending.text += `\n\n${text}`;
      } else {
        flushPending();
        pending = {
          role: partRole,
          text,
          messageId,
          sourceOffset: currentOffset,
        };
      }
    }
  }
  flushPending();

  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  // Meta chunk first.
  const metaParts: string[] = [];
  if (meta.title) metaParts.push(meta.title);
  if (meta.goal) metaParts.push(meta.goal);
  metaParts.push(`cwd: ${meta.cwd}`);
  if (meta.model) metaParts.push(`model: ${meta.model}`);
  chunks.push({
    chunkIndex: chunkIndex++,
    role: "meta",
    text: metaParts.join("\n\n"),
    messageId: null,
    sourceOffset: null,
  });

  // Keep chunks message-bound so best_message_id identifies the exact
  // searchable event rather than the first contributor to a coalesced chunk.
  const utteranceToText = (u: Utterance): string => {
    const prefix =
      u.role === "user" ? "User: " : u.role === "assistant" ? "Assistant: " : "Thinking: ";
    return prefix + u.text;
  };

  const overlapTail = (s: string): string => {
    if (s.length <= OVERLAP_CHARS) return "";
    return s.slice(s.length - OVERLAP_CHARS);
  };

  // We emit per role-group: thinking chunks should never mix with user/assistant
  // so they are kept in their own buffer. Simpler: split utterances into two
  // streams and pack each independently.
  const transcriptStream: Utterance[] = [];
  const thinkingStream: Utterance[] = [];
  for (const u of utterances) {
    if (u.role === "thinking") thinkingStream.push(u);
    else transcriptStream.push(u);
  }

  const packStream = (stream: Utterance[]): void => {
    for (const utterance of stream) {
      const text = utteranceToText(utterance);
      if (text.length <= MAX_CHUNK_CHARS) {
        chunks.push({
          chunkIndex: chunkIndex++,
          role: utterance.role,
          text,
          messageId: utterance.messageId,
          sourceOffset: utterance.sourceOffset,
        });
        continue;
      }
      let offset = 0;
      let priorTail = "";
      while (offset < text.length) {
        const available = Math.max(1, MAX_CHUNK_CHARS - (priorTail ? priorTail.length + 2 : 0));
        const slice = text.slice(offset, offset + available);
        const projected = priorTail ? `${priorTail}\n\n${slice}` : slice;
        chunks.push({
          chunkIndex: chunkIndex++,
          role: utterance.role,
          text: projected,
          messageId: utterance.messageId,
          sourceOffset: utterance.sourceOffset,
        });
        offset += available;
        priorTail = overlapTail(slice);
      }
    }
  };

  packStream(transcriptStream);
  if (options.includeThinking && thinkingStream.length > 0) packStream(thinkingStream);

  return { chunks, stats };
}
