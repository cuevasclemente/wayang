/** Async execution is never authorization to release results or facets. */
import { SearchQueryError } from "./query-parser.js";

export interface PreparedQuerySnapshot { releaseSnapshot: string }
export async function executeRevalidatedSearch<Prepared extends PreparedQuerySnapshot, Result>(options: {
  prepare: () => Prepared;
  execute: (prepared: Prepared) => Promise<Result>;
  guard?: () => void;
  signal?: AbortSignal;
}): Promise<{ prepared: Prepared; result: Result }> {
  const guard = () => {
    options.guard?.();
    if (options.signal?.aborted) throw new SearchQueryError("search_cancelled");
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    guard();
    const prepared = options.prepare();
    let result: Result;
    try { result = await options.execute(prepared); }
    catch (error) {
      guard();
      if (attempt === 0 && error instanceof SearchQueryError && error.code === "search_changed") continue;
      throw error;
    }
    guard();
    // Reauthorize the WHOLE catalog/projection, including absent/deleted/new
    // rows. Filtering only returned results would retain stale facets/ranking.
    const current = options.prepare();
    guard();
    if (prepared.releaseSnapshot === current.releaseSnapshot) return { prepared: current, result };
    // Discard the complete result, including all snippets/facets, and retry once.
  }
  throw new SearchQueryError("search_changed");
}
