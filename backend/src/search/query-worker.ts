/** Disposable read-only query process. Imports the production SQL; no duplicated query. */
import Database from "better-sqlite3";
import { queryKeywordSessions } from "./query-sql.js";
import { queryDatabaseSnapshot } from "./query-snapshot.js";
import { SearchQueryError } from "./query-parser.js";
import { QUERY_WORKER_BUDGETS, type QueryWorkerEnvelope, type QueryWorkerReply } from "./query-worker-protocol.js";

function execute(message: unknown): QueryWorkerReply {
  if (typeof message !== "string" || Buffer.byteLength(message) > QUERY_WORKER_BUDGETS.requestBytes) {
    return { kind: "failure", code: "search_request_too_large" };
  }
  let db: InstanceType<typeof Database> | undefined;
  try {
    const envelope = JSON.parse(message) as QueryWorkerEnvelope;
    const r = envelope.request;
    if (!r || typeof r.dbPath !== "string" || !r.dbPath || r.dbPath.length > 4096
      || !Array.isArray(r.metadataSessionIds) || r.metadataSessionIds.length > QUERY_WORKER_BUDGETS.authorizedSessions
      || !Array.isArray(r.bodies) || r.bodies.length > QUERY_WORKER_BUDGETS.authorizedSessions
      || !Array.isArray(r.allowedCwds) || r.allowedCwds.length > QUERY_WORKER_BUDGETS.authorizedSessions
      || !r.parsed || !Array.isArray(r.parsed.units) || r.parsed.units.length > 16
      || typeof r.databaseSnapshot !== "string" || !/^[a-f0-9]{64}$/.test(r.databaseSnapshot)
      || !Number.isFinite(envelope.deadlineAt) || !Number.isSafeInteger(envelope.resultBytes)
      || envelope.resultBytes < 1 || envelope.resultBytes > QUERY_WORKER_BUDGETS.resultBytes) {
      throw new SearchQueryError("search_unavailable");
    }
    if (Date.now() >= envelope.deadlineAt) throw new SearchQueryError("search_timeout");
    db = new Database(r.dbPath, { readonly: true, fileMustExist: true, timeout: QUERY_WORKER_BUDGETS.busyMs });
    db.pragma("query_only = ON");
    db.pragma("temp_store = MEMORY");
    db.pragma("cache_size = -4096");
    // One read snapshot binds publication/metadata attestation and MATCH, so a
    // transient different generation cannot slip between separate statements.
    const output = db.transaction(() => {
      if (queryDatabaseSnapshot(db!, r.metadataSessionIds) !== r.databaseSnapshot) throw new SearchQueryError("search_changed");
      return queryKeywordSessions(db!, r.parsed, r.metadataSessionIds, r.allowedCwds, r.filters, r.bodies);
    })();
    if (Date.now() >= envelope.deadlineAt) throw new SearchQueryError("search_timeout");
    const json = JSON.stringify(output);
    if (Buffer.byteLength(json) > envelope.resultBytes) throw new SearchQueryError("search_result_too_large");
    return { kind: "result", json };
  } catch (error) {
    const code = error instanceof SearchQueryError && ["search_changed", "search_timeout", "search_result_too_large", "search_request_too_large"].includes(error.code)
      ? error.code as "search_changed" | "search_timeout" | "search_result_too_large" | "search_request_too_large" : "search_unavailable";
    return { kind: "failure", code };
  } finally {
    // Must run before replying; success never retains a reader/WAL snapshot.
    try { db?.close(); } catch { /* process exit below also closes OS handles */ }
  }
}

process.once("message", (message: unknown) => {
  const reply = execute(message);
  if (!process.send) { process.exitCode = 1; return; }
  process.send(reply, () => { if (process.connected) process.disconnect(); });
});
