/**
 * search/chunker.ts — Convert a pi JSONL session transcript into search chunks.
 *
 * v1 rules (see docs/session-history-search.md):
 *   1. Stream JSONL line by line; skip non-`message` types.
 *   2. Keep only items where message.role ∈ {user, assistant} and each
 *      content item has type="text".
 *   3. Concatenate consecutive same-role text into one role-prefixed
 *      utterance: `User: …\n\nAssistant: …`.
 *   4. Greedy-pack utterances into ≤ MAX_CHUNK_CHARS chunks, breaking only
 *      on utterance boundaries; allow OVERLAP_CHARS overlap with the previous
 *      chunk for context.
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

      if (pending && pending.role === partRole) {
        pending.text += `\n\n${text}`;
        // Keep the original messageId/offset of the first contributor.
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

  // Greedy-pack utterances into chunks ≤ MAX_CHUNK_CHARS, with OVERLAP_CHARS
  // tail of the previous chunk prepended for context. We never split mid-utterance.
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

  const packStream = (
    stream: Utterance[],
    fallbackRole: "user" | "assistant" | "thinking",
  ): void => {
    let localBuffer = "";
    let localStart: { messageId: string | null; sourceOffset: number } | null = null;
    let localLastRole: Utterance["role"] = fallbackRole;
    let lastEmittedTail = "";

    const localEmit = (): void => {
      if (!localBuffer || !localStart) return;
      chunks.push({
        chunkIndex: chunkIndex++,
        role: localLastRole,
        text: localBuffer,
        messageId: localStart.messageId,
        sourceOffset: localStart.sourceOffset,
      });
      lastEmittedTail = overlapTail(localBuffer);
      localBuffer = "";
      localStart = null;
    };

    for (const u of stream) {
      const utteranceText = utteranceToText(u);
      const nextLenIfAdded = localBuffer
        ? localBuffer.length + 2 + utteranceText.length
        : utteranceText.length;

      // If a single utterance is longer than MAX, hard-split it at MAX boundaries.
      if (utteranceText.length > MAX_CHUNK_CHARS && !localBuffer) {
        for (let i = 0; i < utteranceText.length; i += MAX_CHUNK_CHARS) {
          const slice = utteranceText.slice(i, i + MAX_CHUNK_CHARS);
          chunks.push({
            chunkIndex: chunkIndex++,
            role: u.role,
            text: lastEmittedTail ? `${lastEmittedTail}\n\n${slice}` : slice,
            messageId: u.messageId,
            sourceOffset: u.sourceOffset,
          });
          lastEmittedTail = overlapTail(slice);
        }
        continue;
      }

      if (nextLenIfAdded > MAX_CHUNK_CHARS && localBuffer) {
        localEmit();
      }

      if (!localBuffer) {
        const prefix = lastEmittedTail ? `${lastEmittedTail}\n\n` : "";
        localBuffer = prefix + utteranceText;
        localStart = { messageId: u.messageId, sourceOffset: u.sourceOffset };
      } else {
        localBuffer += `\n\n${utteranceText}`;
      }
      localLastRole = u.role;
    }
    localEmit();
  };

  packStream(transcriptStream, "user");
  if (options.includeThinking && thinkingStream.length > 0) {
    packStream(thinkingStream, "thinking");
  }

  return { chunks, stats };
}
