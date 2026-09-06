/**
 * tts-text.ts — Extract clean readable text from assistant messages for TTS.
 *
 * Filters out thinking blocks, tool calls, code fences, and other non-speech
 * content so the TTS engine only reads the assistant's actual prose output.
 */

import { Lexer, type Token, type Tokens } from "marked";

export interface MessageEntry {
  id?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    errorMessage?: string;
    stopReason?: string;
  };
  // From serialized history entries
  type?: string;
  messages?: MessageEntry[];
}

export interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
}

// Marked leaves entity references in text tokens. Decode once, at text leaves
// only: a code span containing `&amp;` visibly contains that literal spelling.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", AMP: "&", lt: "<", LT: "<", gt: ">", GT: ">",
  quot: '"', QUOT: '"', apos: "'", nbsp: " ",
};

function decodeSpeechEntities(text: string): string {
  return text.replace(/&(#(?:[xX][0-9a-fA-F]{1,6}|[0-9]{1,7})|[a-zA-Z]+);/g, (raw, entity: string) => {
    if (!entity.startsWith("#")) return NAMED_ENTITIES[entity] ?? raw;
    const hex = /^#x/i.test(entity);
    const point = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
      ? "�" : String.fromCodePoint(point);
  });
}

// Literal punctuation remaining after Markdown parsing is meaningful content,
// not markup. Speak it rather than letting the broker's second Markdown pass
// erase identifier underscores, comparisons, or code-span label punctuation.
const SPOKEN_SYMBOLS: Record<string, string> = {
  "<=": "less than or equal to", ">=": "greater than or equal to",
  "!=": "not equal to", "≤": "less than or equal to", "≥": "greater than or equal to",
  "≠": "not equal to", "=>": "leads to", "→": "leads to",
  "_": "underscore", "<": "less than", ">": "greater than",
  "*": "asterisk", "`": "backtick", "[": "left bracket", "]": "right bracket",
  "#": "hash", "|": "pipe", "&": "and", "+": "plus", "=": "equals",
};

function speechifyCell(cell: Tokens.TableCell | undefined): string {
  return speechTokens(cell?.tokens ?? []).replace(/\s+/g, " ").trim();
}

function describeMarkdownTable(table: Tokens.Table): string {
  const labels = table.header.map((cell, index) => speechifyCell(cell) || `Column ${index + 1}`);
  if (table.rows.length === 0) return `Table with columns: ${labels.join("; ")}.`;

  // GFM pads short rows and ignores excess cells, just like the visible table.
  // Never filter cells: even an empty value must retain its column association.
  const rows = table.rows.map((row, rowIndex) => {
    const pairs = labels.map((label, index) => `${label}: ${speechifyCell(row[index]) || "empty"}`);
    return `Row ${rowIndex + 1}: ${pairs.join("; ")}.`;
  });
  return [`Table with ${rows.length} ${rows.length === 1 ? "row" : "rows"}.`, ...rows].join(" ");
}

/** Walk Markdown structure, not raw source: code cannot become a spoken table. */
function speechTokens(tokens: Token[]): string {
  return tokens.map((token): string => {
    switch (token.type) {
      case "code":
      case "def":
      case "html":
      case "hr":
      case "checkbox":
        return "";
      case "space":
        return "\n\n";
      case "br":
        return "\n";
      case "table":
        return `${describeMarkdownTable(token as Tokens.Table)}\n\n`;
      case "list":
        return "\n" + (token as Tokens.List).items.map((item) => speechTokens(item.tokens).trim()).filter(Boolean).join("\n") + "\n\n";
      case "blockquote":
      case "heading":
      case "paragraph":
        return `${speechTokens(token.tokens ?? [])}\n\n`;
      case "image":
        return token.tokens?.length ? speechTokens(token.tokens) : decodeSpeechEntities(token.text ?? "");
      case "link":
      case "strong":
      case "em":
      case "del":
        return speechTokens(token.tokens ?? []);
      case "text":
        return token.tokens ? speechTokens(token.tokens) : decodeSpeechEntities(token.text);
      case "escape":
      case "codespan":
        // Inline labels are visible prose, not standalone code blocks.
        return token.text;
      default:
        return "";
    }
  }).join("");
}

/**
 * Convert all visible Markdown prose and every labeled table row to speech.
 * Use a fresh lexer with explicit GFM options; do not mutate global Marked state.
 * Fences (including unclosed/nested fences), escapes and links belong to the
 * parser. No generic Markdown stripping may run over the resulting plain text.
 */
export function normalizeSpeechText(markdown: string): string {
  return speechTokens(Lexer.lex(markdown, { gfm: true, pedantic: false }))
    .replace(/<=|>=|!=|=>|[≤≥≠→_<>*`\[\]#|&+=]/g, (symbol) => ` ${SPOKEN_SYMBOLS[symbol]} `)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract the readable text from an assistant message, stripping markup and
 * non-speech content. Returns empty string if there is nothing speakable.
 */
export function extractTtsText(entry: MessageEntry): string {
  const message = entry?.message;
  if (!message) return "";

  // Only assistant messages
  if (message.role !== "assistant") return "";

  // Skip error messages
  if (message.errorMessage || message.stopReason === "error") return "";

  const content = message.content;
  if (!content) return "";

  const parts: string[] = [];

  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (!block || typeof block !== "object") continue;

      // Only include text blocks — skip thinking, tool_use, tool_result
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }

  // The UI renders text blocks independently. Preserve those parser boundaries
  // so an unfinished fence in one block cannot hide a later visible block.
  return parts.map(normalizeSpeechText).filter(Boolean).join("\n\n");
}

/**
 * Return true if a serialized entry is part of the same display bubble that
 * Wayang renders as one assistant response. The frontend groups consecutive
 * assistant/tool entries into one visible assistant bubble; TTS should read the
 * assistant text from that whole group rather than just one raw fragment.
 */
function isAssistantBubbleEntry(entry: MessageEntry): boolean {
  if (entry.type === "assistant" || entry.type === "toolResult" || entry.type === "tool_result") {
    return true;
  }
  const role = entry.message?.role;
  return role === "assistant" || role === "toolResult" || role === "tool_result";
}

function entryContainsMessageId(entry: MessageEntry, messageId: string): boolean {
  if (entry.id === messageId) return true;
  if (Array.isArray(entry.messages)) {
    return entry.messages.some((m) => entryContainsMessageId(m, messageId));
  }
  return false;
}

/**
 * Find a message entry by ID within an array of serialized entries.
 */
export function findMessageById(
  entries: MessageEntry[],
  messageId: string,
): MessageEntry | undefined {
  return entries.find((entry) => entryContainsMessageId(entry, messageId));
}

/**
 * Find the display-level assistant bubble/group containing messageId.
 */
export function findAssistantSpeechGroup(
  entries: MessageEntry[],
  messageId: string,
): MessageEntry[] | undefined {
  const index = entries.findIndex((entry) => entryContainsMessageId(entry, messageId));
  if (index < 0) return undefined;

  if (!isAssistantBubbleEntry(entries[index])) return [entries[index]];

  let start = index;
  while (start > 0 && isAssistantBubbleEntry(entries[start - 1])) start--;

  let end = index;
  while (end + 1 < entries.length && isAssistantBubbleEntry(entries[end + 1])) end++;

  return entries.slice(start, end + 1);
}

/**
 * Extract readable assistant prose from all assistant entries in a display group.
 */
export function extractTtsTextFromEntries(entries: MessageEntry[]): string {
  return entries
    .map((entry) => extractTtsText(entry))
    .filter((text) => text.trim().length > 0)
    .join("\n\n")
    .trim();
}
