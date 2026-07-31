/**
 * search/index.ts — Public surface for the search subsystem.
 *
 * Other modules (routes, app boot) import from this file and never reach
 * into specific implementation files. This keeps the boundary stable while
 * the indexer/embedder internals churn.
 */

export { getSearchDb, getSearchDbPath, closeSearchDb, SCHEMA_VERSION } from "./db.js";
export { startWatcher, stopWatcher, getWatcherStatus, indexSessionNow } from "./watcher.js";
export {
  indexSession,
  reindexAll,
  removeSession,
  purgePolicyDeniedSessions,
  setIncludeThinking,
  getIncludeThinking,
} from "./indexer.js";
export { runSearch, buildFtsExpression, sanitizeSnippet } from "./search.js";
export type {
  Chunk,
  ChunkRole,
  SearchResult,
  SearchFacets,
  SearchResponse,
  SearchFilters,
  SearchHealth,
} from "./types.js";
