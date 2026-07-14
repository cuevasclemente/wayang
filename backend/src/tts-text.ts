/**
 * tts-text.ts — Extract clean readable text from assistant messages for TTS.
 *
 * Filters out thinking blocks, tool calls, code fences, and other non-speech
 * content so the TTS engine only reads the assistant's actual prose output.
 */

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

const TTS_TABLE_MAX_ROWS = 6;
const TTS_TABLE_MAX_COLUMNS = 4;

function splitMarkdownTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim()).filter((cell) => cell.length > 0);
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function looksLikeMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  return splitMarkdownTableRow(trimmed).length >= 2;
}

function speechifyCell(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/\s*\+\s*/g, " plus ")
    .replace(/\s*→\s*/g, " leads to ")
    .replace(/\s*=>\s*/g, " leads to ")
    .replace(/\s*=\s*/g, " equals ")
    .replace(/\s+/g, " ")
    .trim();
}

function describeMarkdownTable(header: string[], rows: string[][]): string {
  if (rows.length === 0) return "";
  if (header.length > TTS_TABLE_MAX_COLUMNS || rows.length > TTS_TABLE_MAX_ROWS) {
    return `Table omitted: ${rows.length} rows and ${header.length} columns.`;
  }

  const describedRows = rows.map((row, rowIndex) => {
    const pairs = header.map((heading, index) => {
      const value = speechifyCell(row[index] ?? "");
      if (!value) return "";
      return `${speechifyCell(heading)}: ${value}`;
    }).filter(Boolean);
    return `Row ${rowIndex + 1}: ${pairs.join("; ")}.`;
  });

  return [`Table with ${rows.length} ${rows.length === 1 ? "row" : "rows"}.`, ...describedRows].join(" ");
}

/**
 * Convert markdown structures that are painful for TTS into compact prose.
 * In particular, small markdown tables become row descriptions; large/wide
 * tables are announced and omitted instead of being read as pipes/dashes.
 */
export function normalizeSpeechText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (
      i + 1 < lines.length &&
      looksLikeMarkdownTableRow(lines[i]) &&
      isMarkdownTableSeparator(lines[i + 1])
    ) {
      const header = splitMarkdownTableRow(lines[i]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && looksLikeMarkdownTableRow(lines[i])) {
        if (!isMarkdownTableSeparator(lines[i])) rows.push(splitMarkdownTableRow(lines[i]));
        i++;
      }
      i--;
      const description = describeMarkdownTable(header, rows);
      if (description) out.push(description, "");
      continue;
    }

    // Drop stray separator rows from malformed/partial markdown tables.
    if (isMarkdownTableSeparator(lines[i])) continue;
    out.push(lines[i]);
  }

  return out.join("\n");
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

  let parts: string[] = [];

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

  const raw = parts.join("\n\n").trim();
  if (!raw) return "";

  // Convert tables before generic Markdown stripping removes their structure.
  const tableSafe = normalizeSpeechText(raw);

  // Strip Markdown code fences (``` … ```)
  const noFences = tableSafe.replace(/```[\s\S]*?```/g, "");

  // Strip inline code spans (`code`)
  const noInline = noFences.replace(/`([^`]+)`/g, "$1");

  // Strip image syntax ![alt](url) before generic links.
  const noImages = noInline.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Strip Markdown link syntax [text](url) → text
  const noLinks = noImages.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Strip bold/italic markers
  const noEmphasis = noLinks.replace(/(\*\*|__)(.*?)\1/g, "$2").replace(/(\*|_)(.*?)\1/g, "$2");

  // Strip heading markers (# ## etc.)
  const noHeadings = noEmphasis.replace(/^#{1,6}\s+/gm, "");

  // Strip horizontal rules
  const noHr = noHeadings.replace(/^[-*_]{3,}\s*$/gm, "");

  // Strip blockquote markers
  const noBlockquote = noHr.replace(/^>\s?/gm, "");

  // Strip HTML tags
  const noHtml = noBlockquote.replace(/<[^>]*>/g, "");

  // Strip ordered/unordered list markers (keep text)
  const noLists = noHtml.replace(/^[\s]*[-*+]\s+/gm, "").replace(/^[\s]*\d+\.\s+/gm, "");

  // Collapse whitespace
  const clean = noLists
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  return clean;
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
