/** Compiled read-only query budgets; no deployment environment switches. */
import type { ParsedSearchQuery } from "./query-parser.js";
import type { SearchBodyAuthorization } from "./query-authorization.js";
import type { SearchFilters } from "./types.js";
import type { queryKeywordSessions } from "./query-sql.js";

export const QUERY_WORKER_BUDGETS = Object.freeze({
  workers: 1,
  queued: 4,
  deadlineMs: 5_000, // includes time waiting in the queue
  busyMs: 100,
  heapMb: 64, // V8 heap, NOT a bound on SQLite's native allocations
  requestBytes: 2 * 1024 * 1024,
  snapshotBytes: 4 * 1024 * 1024,
  resultBytes: 512 * 1024,
  authorizedSessions: 4096,
});

export interface QueryWorkerRequest {
  dbPath: string;
  parsed: ParsedSearchQuery;
  filters: SearchFilters;
  metadataSessionIds: string[];
  allowedCwds: string[];
  bodies: SearchBodyAuthorization[];
  databaseSnapshot: string;
}
export type QueryWorkerResult = ReturnType<typeof queryKeywordSessions>;
export interface QueryWorkerEnvelope {
  request: QueryWorkerRequest;
  deadlineAt: number;
  resultBytes: number;
}
export type QueryWorkerReply = { kind: "result"; json: string }
  | { kind: "failure"; code: "search_changed" | "search_timeout" | "search_result_too_large" | "search_request_too_large" | "search_unavailable" };
