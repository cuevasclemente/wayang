/**
 * search/types.ts — Shared types for the search subsystem.
 *
 * Kept separate from db.ts to avoid pulling in better-sqlite3 just to use
 * the type names from other modules (chunker, indexer, search.ts, routes).
 */

export type ChunkRole = "user" | "assistant" | "meta" | "thinking";

export interface Chunk {
  /** 0-based index within the session, in message order. */
  chunkIndex: number;
  role: ChunkRole;
  text: string;
  /** Exact pi message id contributing to this message-bound chunk, if any. */
  messageId?: string | null;
  /** Byte offset in the source JSONL for the first contributing line. */
  sourceOffset?: number | null;
}

export interface SearchResult {
  session_id: string;
  title: string;
  cwd: string;
  model: string | null;
  last_active: number;
  archived: boolean;
  score: number;
  best_role: ChunkRole;
  snippet_html: string;
  best_message_id?: string | null;
  best_message_active?: boolean;
  best_transcript_epoch?: string | null;
  best_anchor_status?: "active" | "unavailable";
}

export interface SearchFacets {
  cwds: Array<{ value: string; count: number }>;
  models: Array<{ value: string; count: number }>;
}

export interface SearchResponse {
  query: string;
  took_ms: number;
  results: SearchResult[];
  facets: SearchFacets;
  degraded?: "semantic_off" | "indexing_in_progress";
}

export interface SearchFilters {
  cwd?: string;
  archived?: "true" | "false" | "any";
  since?: number;
  until?: number;
  model?: string;
  has_goal?: boolean;
  has_error?: boolean;
  limit?: number;
}

export interface SearchHealth {
  total_sessions: number;
  indexed_sessions: number;
  pending: number;
  last_error?: string;
  schema_version: number;
  embedder: "off" | "http";
}
