/** Bounded literal keyword/optional-phrase grammar. No Boolean or prefix syntax. */
import Database, { type Database as DatabaseType } from "better-sqlite3";

export const MAX_QUERY_CHARS = 2048;
export const MAX_QUERY_UNITS = 16;
export const MAX_UNIT_CHARS = 128;
// Current coverage indexes complete bounded message documents. Phrase matches
// never cross message IDs; legacy BODY is hidden until its revision is rebuilt.
// Currently authorized legacy metadata remains searchable.

export type SearchQueryErrorCode =
  | "query_too_long" | "too_many_units" | "unit_too_long"
  | "unmatched_quote" | "empty_unit"
  | "invalid_query" | "search_unavailable";

/** Fixed public messages only: never attach SQL, paths, or the query as a cause. */
export class SearchQueryError extends Error {
  constructor(public readonly code: SearchQueryErrorCode) {
    const messages: Record<SearchQueryErrorCode, string> = {
      query_too_long: `Search is limited to ${MAX_QUERY_CHARS} characters.`,
      too_many_units: `Search is limited to ${MAX_QUERY_UNITS} words or phrases.`,
      unit_too_long: `Each search word or phrase is limited to ${MAX_UNIT_CHARS} characters.`,
      unmatched_quote: "Close each quoted search phrase.",
      empty_unit: "Each search word or phrase must contain searchable text.",
      invalid_query: "Separate search words and quoted phrases with whitespace.",
      search_unavailable: "Search is temporarily unavailable.",
    };
    super(messages[code]);
    this.name = "SearchQueryError";
  }
}

export interface SearchUnit {
  /** NFC, case-folded literal text. Punctuation is interpreted by FTS5. */
  text: string;
  phrase: boolean;
  /** Column-restricted literal expression, safe to bind to MATCH. */
  match: string;
}

export interface ParsedSearchQuery {
  units: SearchUnit[];
  match: string | null;
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
  if (typeof query !== "string") throw new SearchQueryError("invalid_query");
  if (query.length > MAX_QUERY_CHARS) throw new SearchQueryError("query_too_long");
  // Reject controls rather than silently changing the input. Ordinary whitespace is allowed.
  if (/[\u0000-\u0008\u000e-\u001f\u007f]/u.test(query)) throw new SearchQueryError("invalid_query");
  const units: SearchUnit[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let suppliedUnits = 0;
  while (offset < query.length) {
    if (/\s/u.test(query[offset])) { offset++; continue; }
    if (++suppliedUnits > MAX_QUERY_UNITS) throw new SearchQueryError("too_many_units");
    const phrase = query[offset] === '"';
    let raw: string;
    if (phrase) {
      const end = query.indexOf('"', offset + 1);
      if (end === -1) throw new SearchQueryError("unmatched_quote");
      raw = query.slice(offset + 1, end);
      offset = end + 1;
      if (offset < query.length && !/\s/u.test(query[offset])) throw new SearchQueryError("invalid_query");
    } else {
      const start = offset;
      while (offset < query.length && !/\s/u.test(query[offset])) offset++;
      raw = query.slice(start, offset);
      if (raw.includes('"')) throw new SearchQueryError("invalid_query");
    }
    if (raw.length > MAX_UNIT_CHARS) throw new SearchQueryError("unit_too_long");
    // unicode61 treats ASCII punctuation as separators. Canonicalizing those
    // separators also deduplicates e.g. "alpha-beta" and "alpha beta".
    const text = raw.normalize("NFC").toLowerCase()
      .replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/gu, " ")
      .replace(/\s+/gu, " ").trim();
    if (text.length > MAX_UNIT_CHARS) throw new SearchQueryError("unit_too_long");
    if (!/[\p{L}\p{N}\p{Co}]/u.test(text)) throw new SearchQueryError("empty_unit");
    if (seen.has(text)) continue;
    seen.add(text);
    units.push({ text, phrase, match: `text : "${text.replaceAll('"', '""')}"` });
  }
  const distinct = deduplicateTokenizedUnits(units);
  return { units: distinct, match: distinct.length ? distinct.map((unit) => unit.match).join(" OR ") : null };
}

/**
 * Use SQLite's actual tokenizer, not JS Unicode categories/diacritic heuristics.
 * Query material is bounded above before allocation, lives only in a disposable
 * :memory: database, and is never inserted into the transcript index or logs.
 * Instance vocabulary preserves token order AND repetitions inside each phrase.
 */
function deduplicateTokenizedUnits(units: SearchUnit[]): SearchUnit[] {
  if (!units.length) return [];
  let db: DatabaseType | undefined;
  try {
    db = new Database(":memory:");
    db.exec(`CREATE VIRTUAL TABLE query_input USING fts5(text, tokenize='unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE query_vocab USING fts5vocab(query_input, 'instance');`);
    const insert = db.prepare("INSERT INTO query_input(rowid, text) VALUES (?, ?)");
    db.transaction(() => units.forEach((unit, index) => insert.run(index + 1, unit.text)))();
    const vocabulary = db.prepare("SELECT doc, term FROM query_vocab ORDER BY doc, offset").all() as Array<{ doc: number; term: string }>;
    const sequences = units.map(() => [] as string[]);
    for (const token of vocabulary) sequences[token.doc - 1].push(token.term);
    const seen = new Set<string>();
    return units.filter((_unit, index) => {
      if (!sequences[index].length) throw new SearchQueryError("empty_unit");
      const key = JSON.stringify(sequences[index]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (error) {
    if (error instanceof SearchQueryError) throw error;
    throw new SearchQueryError("search_unavailable");
  } finally {
    try { db?.close(); } catch { throw new SearchQueryError("search_unavailable"); }
  }
}

export function buildFtsExpression(query: string): string | null {
  return parseSearchQuery(query).match;
}
