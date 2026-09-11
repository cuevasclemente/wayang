/** Async execution is never authorization to release results or facets. */
import { SearchQueryError } from "./query-parser.js";

/** `void` callback types also accept async functions in TypeScript. Requiring
 * undefined rejects Promise-returning callbacks; use a block body with no return.
 */
export type SynchronousSearchRelease<Args extends unknown[]> = (...args: Args) => undefined;

export function assertSynchronousSearchRelease(release: unknown): void {
  if (release === undefined) return;
  if (typeof release !== "function" || Object.prototype.toString.call(release) === "[object AsyncFunction]") {
    throw new TypeError("Search release callback must be synchronous and return undefined.");
  }
}

export function invokeSearchRelease<Args extends unknown[]>(release: SynchronousSearchRelease<Args> | undefined, ...args: Args): void {
  assertSynchronousSearchRelease(release);
  if (!release) return;
  const returned: unknown = release(...args);
  if (returned !== undefined) {
    // Defensive check for untyped callers. Never await a callback or retry it.
    if (returned instanceof Promise) void returned.catch(() => {});
    throw new TypeError("Search release callback must be synchronous and return undefined.");
  }
}

export interface PreparedQuerySnapshot { releaseSnapshot: string }
/** Only the synchronous release callback carries transport-release authority.
 * The returned promise value is useful for fixtures, NOT safe for a later send.
 */
export async function executeRevalidatedSearch<Prepared extends PreparedQuerySnapshot, Result>(options: {
  prepare: () => Prepared;
  execute: (prepared: Prepared) => Promise<Result>;
  guard?: () => void;
  signal?: AbortSignal;
  release?: SynchronousSearchRelease<[Prepared, Result]>;
}): Promise<{ prepared: Prepared; result: Result }> {
  const release = options.release;
  assertSynchronousSearchRelease(release);
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
    if (prepared.releaseSnapshot === current.releaseSnapshot) {
      // No await/microtask between comparison and transport release. Deliberately
      // outside the execute catch: callback failures (even search_changed) must
      // propagate without retrying or duplicating transport side effects.
      invokeSearchRelease(release, current, result);
      return { prepared: current, result };
    }
    // Discard the complete result, including all snippets/facets, and retry once.
  }
  throw new SearchQueryError("search_changed");
}
