/** Bounded search queue -> exact structural offsets -> worker -> staged generation -> synchronous CAS flip. */
import { createHash } from "node:crypto";
import { getStore, type SessionRow } from "../db.js";
import { getPolicyGeneration } from "../policy.js";
import { authorizeExactStandardTranscript } from "../standard-transcript-authorization.js";
import { listSessions } from "../sessions.js";
import { eventRecoveryMarkerForSession, clearTranscriptRecoveryMarker } from "../transcript-recovery-journal.js";
import { getSearchDb, SCHEMA_VERSION } from "./db.js";
import { isSessionIndexable } from "./policy-filter.js";
import { DreamPolicyProjectionUnavailableError, ensureDreamPolicyProjection } from "./policy-projection.js";
import { invalidateTranscriptPaginationSession } from "../transcript-pagination/service.js";
import { getStructuralTranscriptIndex, SearchStructuralStaleError, SearchStructuralUnsupportedError, type StructuralIndexRevision } from "../transcript-pagination/structural-index.js";
import { SearchQueue, SearchQueueUnavailableError, type SearchPriority } from "./queue.js";
import { extractSearchDocuments } from "./extraction.js";
import { SEARCH_EXTRACTION_VERSION, searchSourceRevisionKey, getPublishedSearchRevision } from "./revision.js";
import { beginGeneration, cleanupSearchChunks, getIndexCoverageSnapshot as coverageSnapshot,
  getSearchPublicationMetrics, invalidatePublication, metadataRevision, publishGeneration, publishMetadata,
  recordSearchOutcome, recordSearchQueued, stageDocuments, yieldSearchTurn, SearchMetadataUnsupportedError, type SearchOutcome } from "./publication.js";

export interface IndexResult {
  sessionId: string; chunkCount: number; skipped: boolean;
  policySkipped?: boolean; mutationFenced?: boolean; retryable?: boolean; error?: string;
  outcome?: SearchOutcome;
  /** Backend reconciliation receipt; must still be verified at marker clearance. */
  publicationGeneration?: string;
}
export interface IndexBatchSummary { total: number; indexed: number; skipped: number; errors: number; durationMs: number }
export interface IndexerOptions {
  includeThinking?: boolean;
  force?: boolean;
  recoveryMarkerId?: string;
  priority?: SearchPriority;
  delayMs?: number;
  afterChunkingForTests?: () => void | Promise<void>;
  afterStageForTests?: () => void | Promise<void>;
}
const queue = new SearchQueue<IndexResult>();
const transcriptMutationFences = new Set<string>();
const invalidations = new Map<string, number>();
let includeThinking = false;
let phase = "idle";
let projectionPaused = false;
let ownerStopped = false;
let producerEpoch = 0;
const producers = new Set<Promise<unknown>>();
// One marker denotes one reconciliation operation, not successive force jobs.
// Keep a successful receipt until acknowledgement; duplicate callers revalidate it.
const recoveryRequests = new Map<string, {sessionId:string;work:Promise<IndexResult>}>();
function trackProducer<T>(work: Promise<T>): Promise<T> {
  producers.add(work);
  void work.then(() => producers.delete(work),() => producers.delete(work));
  return work;
}
export function setIncludeThinking(v: boolean): void { includeThinking = v; }
export function getIncludeThinking(): boolean { return includeThinking; }
export function startSearchQueue(): void { producerEpoch++; ownerStopped = false; projectionPaused = false; queue.start(); }
export async function stopSearchQueue(): Promise<void> {
  ownerStopped = true;
  producerEpoch++;
  recoveryRequests.clear();
  await queue.stop();
  await Promise.allSettled([...producers]);
}
export function resumeSearchQueueAfterProjection(): void {
  if (projectionPaused && !ownerStopped) { projectionPaused = false; queue.start(); }
}
export function getSearchQueueStatus() { return { ...queue.status(), phase, projectionPaused, publication: getSearchPublicationMetrics() }; }
export function getIndexCoverageSnapshot(allowedIds: ReadonlySet<string>) {
  if (ownerStopped) throw new SearchQueueUnavailableError("Search owner stopped");
  return coverageSnapshot(getSearchDb(), allowedIds);
}

/** Cheap discovery only: no structural build, extraction, staging or raw stat.
 * The watcher calls this in small yielded batches independently of queue drain.
 * Exact Standard header authorization still precedes file revision observation.
 */
export function searchSessionNeedsIndex(sessionId: string): boolean {
  if (ownerStopped || projectionPaused || queue.status().stopped
    || queue.hasWork((key) => JSON.parse(key)[0] === sessionId)) return false;
  const durable = getStore().sessions.find((candidate) => candidate.id === sessionId);
  if (!durable) return false;
  const row = {...durable};
  if (policyDenial(row)) return false;
  const authorized = row.pi_session_file
    ? authorizeExactStandardTranscript(row.pi_session_file,{expectedSessionId:sessionId}) : null;
  if (row.pi_session_file && !authorized) return false;
  const revisionKey = searchSourceRevisionKey(row.pi_session_file,authorized?.fingerprint ?? null);
  const db = getSearchDb();
  const state = db.prepare(`SELECT w.*,p.valid,p.source_revision,m.revision AS metadata_revision FROM search_work_state w
    LEFT JOIN search_publication p ON p.session_id=w.session_id
    LEFT JOIN search_session_metadata m ON m.session_id=w.session_id WHERE w.session_id=?`).get(sessionId) as {
      successful_revision:string|null;attempted_revision:string|null;outcome:string;retry_at:number;error_code:string|null;
      valid:number|null;source_revision:string|null;metadata_revision:string|null;queued_at:number;chunk_bytes:number;
    } | undefined;
  if (!state) return true;
  const metadata = metadataRevision(row);
  const current = getStore().sessions.find((candidate) => candidate.id === sessionId);
  if (!current || current.pi_session_file !== row.pi_session_file || metadataRevision(current) !== metadata) return true;
  const sameComplete = state.successful_revision === revisionKey && state.error_code === null;
  const samePartial = state.outcome === "partial" && state.attempted_revision === revisionKey;
  if (state.valid === 1 && state.source_revision !== null && state.metadata_revision === metadata && (sameComplete || samePartial)) {
    // Reconstruct deferred admission after a restart/overflow without extracting
    // an already-current body or leaving the coverage projection stuck queued.
    if (state.queued_at) recordSearchOutcome(db,sessionId,revisionKey,
      samePartial ? "partial" : row.pi_session_file ? "current" : "metadata_only",state.error_code,state.chunk_bytes);
    return false;
  }
  if (negativeOutcomeMatches(state,revisionKey,row)) return false;
  return true;
}

function metadataFailureRevision(sourceKey: string, row: SessionRow): string {
  // Only fields contributing to the bounded metadata document belong here;
  // recency/archive churn must not repeatedly retry the same oversized goal.
  const digest = createHash("sha256").update(JSON.stringify([row.title,row.goal,row.cwd,row.model])).digest("hex");
  return JSON.stringify(["metadata",sourceKey,digest]);
}
function negativeOutcomeMatches(state: {attempted_revision:string|null;outcome:string;retry_at:number;error_code:string|null},
  sourceKey: string, row: SessionRow): boolean {
  const expected = state.error_code === "metadata_unsupported" ? metadataFailureRevision(sourceKey,row) : sourceKey;
  const stable = state.error_code === "metadata_unsupported" || state.error_code === "unsupported_structure" || state.error_code === "malformed_record";
  // Old mixed 'unsupported_structure_or_metadata' rows are ambiguous and get
  // one normal retry rather than retaining the prior poisoned negative cache.
  return state.attempted_revision === expected && ((state.outcome === "unsupported" && stable) || state.retry_at > Date.now());
}

class Invalidated extends Error {}
class MetadataChanged extends Error {}

function recoveryMarkerMatches(sessionId: string, markerId: string): boolean {
  const marker = eventRecoveryMarkerForSession(sessionId);
  const row = getStore().sessions.find((candidate) => candidate.id === sessionId);
  return marker?.id === markerId && Boolean(row?.pi_session_file) && marker.pi_session_file === row!.pi_session_file;
}

function recoveryDeferred(sessionId: string): IndexResult {
  return {sessionId,chunkCount:0,skipped:true,retryable:true,error:"Search deferred while transcript recovery is pending or changed"};
}

/** Revalidate the exact successful flip, not merely an enqueue/result flag. */
export function isSearchRecoveryPublicationCurrent(sessionId: string, markerId: string, result: IndexResult): boolean {
  if (ownerStopped || result.sessionId !== sessionId || result.error || result.skipped || result.outcome !== "current"
    || !result.publicationGeneration || !recoveryMarkerMatches(sessionId,markerId)) return false;
  try {
    const policyGeneration = getPolicyGeneration();
    const row = getStore().sessions.find((candidate) => candidate.id === sessionId);
    if (!row?.pi_session_file || policyDenial(row,markerId)) return false;
    const db = getSearchDb();
    const published = getPublishedSearchRevision(db,sessionId);
    if (published.kind !== "published" || published.generation !== result.publicationGeneration
      || published.filePath !== row.pi_session_file || !published.fingerprint || !published.transcriptEpoch
      || published.extractionVersion !== SEARCH_EXTRACTION_VERSION) return false;
    if (!authorizeExactStandardTranscript(row.pi_session_file,{expectedSessionId:sessionId,expectedFingerprint:published.fingerprint})) return false;
    const state = db.prepare(`SELECT w.outcome,w.successful_revision,w.error_code,m.revision AS metadata_revision
      FROM search_work_state w JOIN search_session_metadata m ON m.session_id=w.session_id WHERE w.session_id=?`)
      .get(sessionId) as {outcome:string;successful_revision:string|null;error_code:string|null;metadata_revision:string}|undefined;
    const current = getStore().sessions.find((candidate) => candidate.id === sessionId);
    if (!current || state?.outcome !== "current" || state.error_code !== null
      || state.successful_revision !== searchSourceRevisionKey(published.filePath,published.fingerprint)
      || state.metadata_revision !== metadataRevision(current)) return false;
    const final = getPublishedSearchRevision(db,sessionId);
    return !ownerStopped && getPolicyGeneration() === policyGeneration && recoveryMarkerMatches(sessionId,markerId)
      && final.kind === "published" && final.generation === result.publicationGeneration;
  } catch { return false; }
}
function checkedRecoveryResult(sessionId: string, markerId: string, result: IndexResult): IndexResult {
  if (isSearchRecoveryPublicationCurrent(sessionId,markerId,result)) return result;
  return {...result,error:result.error ?? "Search recovery did not retain its complete current publication"};
}

/** No await between fresh publication/policy/fingerprint CAS and marker clear. */
export function acknowledgeSearchRecovery(sessionId: string, markerId: string, result: IndexResult): boolean {
  if (!isSearchRecoveryPublicationCurrent(sessionId,markerId,result)) return false;
  const cleared = clearTranscriptRecoveryMarker(markerId);
  if (cleared) recoveryRequests.delete(markerId);
  return cleared;
}

export function indexSession(sessionId: string, options: IndexerOptions = {}): Promise<IndexResult> {
  // Admission rejection must precede even getSearchDb()/queued bookkeeping:
  // shutdown may already have closed the handle and must never reopen it.
  if (ownerStopped) return Promise.resolve({sessionId,chunkCount:0,skipped:true,retryable:true,error:"Search owner stopped"});
  const marker = options.recoveryMarkerId;
  if (marker) {
    const previous = recoveryRequests.get(marker);
    if (previous?.sessionId === sessionId) return trackProducer(previous.work.then(result => {
      const checked = checkedRecoveryResult(sessionId,marker,result);
      if (checked.error && recoveryRequests.get(marker)?.work===previous.work) recoveryRequests.delete(marker);
      return checked;
    }));
    const work = trackProducer(indexSessionRequest(sessionId,options));
    recoveryRequests.set(marker,{sessionId,work});
    const forget = () => {if(recoveryRequests.get(marker)?.work===work)recoveryRequests.delete(marker);};
    void work.then(result => {if(result.error || !recoveryMarkerMatches(sessionId,marker))forget();},forget);
    return work;
  }
  return trackProducer(indexSessionRequest(sessionId,options));
}

async function indexSessionRequest(sessionId: string, options: IndexerOptions): Promise<IndexResult> {
  if (!options.recoveryMarkerId && eventRecoveryMarkerForSession(sessionId)) return recoveryDeferred(sessionId);
  if (options.recoveryMarkerId && !recoveryMarkerMatches(sessionId,options.recoveryMarkerId)) {
    return {sessionId,chunkCount:0,skipped:true,retryable:true,error:"Search recovery marker changed"};
  }
  if (transcriptMutationFences.has(sessionId)) {
    return {sessionId,chunkCount:0,skipped:true,mutationFenced:true,
      ...(options.recoveryMarkerId ? {error:"Search recovery is mutation-fenced"} : {})};
  }
  const requestedInvalidation = invalidations.get(sessionId) ?? 0;
  // Exact marker is part of the coalescing key: ordinary work can never inherit
  // mutation recovery authority or resolve a recovery waiter by enqueue alone.
  const key = JSON.stringify([sessionId, options.recoveryMarkerId ?? null, Boolean(options.force)]);
  const priority = options.recoveryMarkerId ? "mutation" : options.priority ?? "manual";
  const db = getSearchDb();
  recordSearchQueued(db,sessionId);
  try {
    const result = await queue.enqueue(key,priority, async (signal) => {
      try {
        if (signal.aborted || (invalidations.get(sessionId) ?? 0) !== requestedInvalidation) {
          return {sessionId,chunkCount:0,skipped:true,retryable:true,error:"Search request invalidated"};
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          try { return await indexSessionAttempt(sessionId,options,signal); }
          catch (error) { if (!(error instanceof MetadataChanged)) throw error; }
        }
        purgeSessionIndex(sessionId);
        recordSearchOutcome(db,sessionId,null,"failed","metadata_churn");
        return { sessionId,chunkCount:0,skipped:true,retryable:true,
          error:"Session metadata changed repeatedly during indexing; retry later." };
      } catch (error) {
        if (error instanceof DreamPolicyProjectionUnavailableError) {
          // A global prerequisite outage is one failure, not one body admission
          // attempt per queued session. Only a successful watcher heartbeat resumes.
          projectionPaused = true;
          void queue.stop();
        }
        throw error;
      } finally {
        if (queue.hasPending((pendingKey) => JSON.parse(pendingKey)[0] === sessionId)) recordSearchQueued(db,sessionId);
        phase = "idle";
      }
    }, options.delayMs ?? 0);
    // Existing mutation/startup callers interpret !error as reconciliation. Do
    // not let partial, denied, fenced, cancelled, stale-marker or skipped work
    // clear their durable recovery barrier, including shortcut results.
    return options.recoveryMarkerId ? checkedRecoveryResult(sessionId,options.recoveryMarkerId,result) : result;
  } catch (error) {
    if (error instanceof SearchQueueUnavailableError) {
      // Durable dirty state survives admission pressure and is revisited by the
      // next bounded sweep. Do not overwrite another running request's state.
      return { sessionId,chunkCount:0,skipped:true,retryable:true,error:"Search queue unavailable" };
    }
    throw error;
  }
}

async function indexSessionAttempt(sessionId: string, options: IndexerOptions, signal: AbortSignal): Promise<IndexResult> {
  // An ordinary request queued before marker creation is deferred, not a
  // reason to purge the recovery operation's newly published generation.
  if (!options.recoveryMarkerId && eventRecoveryMarkerForSession(sessionId)) return recoveryDeferred(sessionId);
  if (options.recoveryMarkerId && !recoveryMarkerMatches(sessionId,options.recoveryMarkerId)) return recoveryDeferred(sessionId);
  if (transcriptMutationFences.has(sessionId)) {
    purgeSessionIndex(sessionId);
    return {sessionId,chunkCount:0,skipped:true,mutationFenced:true};
  }
  const durable = getStore().sessions.find((r) => r.id === sessionId);
  if (!durable) { purgeSessionIndex(sessionId); return {sessionId,chunkCount:0,skipped:true,error:"session not found"}; }
  const row = {...durable};
  ensureDreamPolicyProjection();
  if (policyDenial(row,options.recoveryMarkerId)) return purgePolicyDeniedSession(sessionId);
  const filePath = row.pi_session_file;
  const authorization = filePath ? authorizeExactStandardTranscript(filePath,{expectedSessionId:sessionId}) : null;
  if (filePath && !authorization) return purgePolicyDeniedSession(sessionId);
  const fingerprint = authorization?.fingerprint;
  const policyGeneration = getPolicyGeneration();
  const invalidation = invalidations.get(sessionId) ?? 0;
  const expectedMetadata = JSON.stringify([metadataRevision(row),row.catalog_mutation_version ?? 0,row.pi_session_file]);
  const db = getSearchDb();
  const revisionKey = searchSourceRevisionKey(filePath,fingerprint ?? null);
  const authCurrent = (): boolean => !signal.aborted && !transcriptMutationFences.has(sessionId)
    && (invalidations.get(sessionId) ?? 0) === invalidation
    && getPolicyGeneration() === policyGeneration && !policyDenial(row,options.recoveryMarkerId)
    && (!options.recoveryMarkerId || recoveryMarkerMatches(sessionId,options.recoveryMarkerId))
    && (!filePath || Boolean(fingerprint && authorizeExactStandardTranscript(filePath,{
      expectedSessionId:sessionId,expectedFingerprint:fingerprint})))
    && getPolicyGeneration() === policyGeneration;
  let structural: StructuralIndexRevision | undefined;
  let generation: string | undefined;
  const guard = (): void => {
    if (!authCurrent()) throw new Invalidated("search_invalidated");
    const current = getStore().sessions.find((r) => r.id === sessionId);
    if (!current || JSON.stringify([metadataRevision(current),current.catalog_mutation_version ?? 0,current.pi_session_file]) !== expectedMetadata) throw new MetadataChanged();
    if (structural) getStructuralTranscriptIndex().assertSearchRevision(structural,() => true,{exactFileAlreadyAuthorized:true});
  };
  const state = db.prepare("SELECT * FROM search_work_state WHERE session_id=?").get(sessionId) as {
    outcome:string;successful_revision:string|null;attempted_revision:string|null;retry_at:number;error_code:string|null;chunk_bytes:number } | undefined;
  try {
    guard();
    // Independent metadata CAS. Body revision is exact inode/ctime/mtime/size,
    // not mtime+size, and failed/partial legacy states never satisfy success.
    const sameComplete = state?.successful_revision === revisionKey && state.error_code === null;
    const samePartial = state?.outcome === "partial" && state.attempted_revision === revisionKey;
    if (state && !options.force && !options.recoveryMarkerId && (sameComplete || samePartial)) {
      const publication = db.prepare("SELECT valid,source_revision FROM search_publication WHERE session_id=?").get(sessionId) as {valid:number;source_revision:string|null}|undefined;
      if (publication?.valid === 1 && publication.source_revision !== null) {
        db.transaction(() => publishMetadata(db,row))();
        const outcome: SearchOutcome = state.error_code === "included_record_limit" ? "partial" : filePath ? "current" : "metadata_only";
        recordSearchOutcome(db,sessionId,revisionKey,outcome,state.error_code,state.chunk_bytes);
        return {sessionId,chunkCount:0,skipped:true,outcome,
          ...(outcome === "partial" ? {error:"Some included transcript records exceed search limits"} : {})};
      }
    }
    if (!options.force && !options.recoveryMarkerId && state && negativeOutcomeMatches(state,revisionKey,row)) {
      // Preserve stable negatives/backoff despite the queued admission marker.
      db.prepare("UPDATE search_work_state SET queued_at=0,requested_revision=? WHERE session_id=?").run(revisionKey,sessionId);
      return {sessionId,chunkCount:0,skipped:true,outcome:state.outcome as SearchOutcome,retryable:state.outcome !== "unsupported"};
    }
    // Once changed/uncertain input is observed, stale text loses visibility
    // before any worker or cleanup yield. Legacy results remain until refreshed.
    invalidatePublication(db,sessionId);
    recordSearchOutcome(db,sessionId,revisionKey,"running");
    await cleanupSearchChunks(db,{sessionId,maxBatches:4});
    guard();
    phase = "structure";
    if (filePath && fingerprint) {
      structural = await getStructuralTranscriptIndex().searchRevision(sessionId,filePath,fingerprint,authCurrent);
      guard();
    }
    generation = beginGeneration(db,sessionId);
    let documents = 0;
    let bytes = 0;
    let unsupported = 0;
    if (structural) {
      phase = "extracting";
      const stats = await extractSearchDocuments({revision:structural,signal,guard,
        // The dispatcher just reauthorized this exact fingerprint synchronously.
        sources: (after) => getStructuralTranscriptIndex().searchSourcePage(structural!,after,() => true,64,{exactFileAlreadyAuthorized:true}),
        stage: async (chunks) => {
          // Parent extraction dispatcher just performed guard(), without a yield.
          phase = "staging";
          stageDocuments(db,sessionId,generation!,structural!.transcriptEpoch,chunks);
          if (options.afterStageForTests) { await options.afterStageForTests(); guard(); }
          await yieldSearchTurn();
          // The dispatcher reauthorizes after this await before acknowledging.
          phase = "extracting";
        }});
      documents = stats.documents; bytes = stats.textBytes; unsupported = stats.unsupportedRecords;
    }
    await options.afterChunkingForTests?.();
    guard();
    const outcome: SearchOutcome = unsupported ? "partial" : filePath ? "current" : "metadata_only";
    if (options.recoveryMarkerId && outcome !== "current") {
      // Partial extraction is useful for ordinary search, never positive
      // evidence that a mutation has completely reconciled its text.
      recordSearchOutcome(db,sessionId,revisionKey,outcome,"included_record_limit",bytes);
      return {sessionId,chunkCount:0,skipped:true,outcome,error:"Search recovery requires complete transcript coverage"};
    }
    phase = "staging_metadata";
    db.transaction(() => publishMetadata(db,row))();
    guard();
    phase = "publishing";
    // No await between fresh policy/fingerprint/metadata/active-revision CAS and
    // the short publication flip. Text was already staged in bounded slices.
    publishGeneration(db,row,generation,() => {
      db.prepare(`INSERT INTO session_index_state(session_id,pi_session_file,file_mtime_ms,file_size,indexed_at_ms,
        chunk_count,vector_count,schema_version,error) VALUES(?,?,?,?,?,?,0,?,?) ON CONFLICT(session_id) DO UPDATE SET
        pi_session_file=excluded.pi_session_file,file_mtime_ms=excluded.file_mtime_ms,file_size=excluded.file_size,
        indexed_at_ms=excluded.indexed_at_ms,chunk_count=excluded.chunk_count,schema_version=excluded.schema_version,error=excluded.error`).run(
        sessionId,filePath,fingerprint?.mtimeMs ?? null,fingerprint?.size ?? null,Date.now(),documents+1,SCHEMA_VERSION,
        unsupported ? "included_record_limit" : null);
      recordSearchOutcome(db,sessionId,revisionKey,outcome,unsupported ? "included_record_limit" : null,bytes);
    },{filePath,fingerprint:fingerprint ?? null,extractionVersion:SEARCH_EXTRACTION_VERSION,
      transcriptEpoch:structural?.transcriptEpoch ?? null});
    phase = "cleanup";
    await cleanupSearchChunks(db,{sessionId,maxBatches:4});
    guard();
    return {sessionId,chunkCount:documents+1,skipped:false,outcome,publicationGeneration:generation,
      ...(unsupported ? {error:"Some included transcript records exceed search limits"} : {})};
  } catch (error) {
    if (error instanceof MetadataChanged) throw error;
    if (error instanceof DreamPolicyProjectionUnavailableError) throw error;
    if (error instanceof Invalidated || !authCurrent()) {
      if ((!options.recoveryMarkerId && eventRecoveryMarkerForSession(sessionId))
        || (options.recoveryMarkerId && !recoveryMarkerMatches(sessionId,options.recoveryMarkerId))) return recoveryDeferred(sessionId);
      // A prior fence already denied and purged this job. Do not let a late
      // predecessor invalidate/cancel a newly queued exact recovery request.
      if ((invalidations.get(sessionId) ?? 0) !== invalidation) {
        return {sessionId,chunkCount:0,skipped:true,retryable:true,error:"Search request invalidated"};
      }
      return purgePolicyDeniedSession(sessionId);
    }
    invalidatePublication(db,sessionId);
    const code = error instanceof Error ? error.message : "index_failed";
    const metadataFailure = error instanceof SearchMetadataUnsupportedError;
    const stale = error instanceof SearchStructuralStaleError;
    const stable = metadataFailure || error instanceof SearchStructuralUnsupportedError || code === "malformed_record";
    const outcome = stale ? "stale" : stable ? "unsupported" : "failed";
    // Typed cache invalidation is immediately retryable. Stable negatives bind
    // the inputs that can repair them, never an arbitrary exception substring.
    recordSearchOutcome(db,sessionId,metadataFailure ? metadataFailureRevision(revisionKey,row) : revisionKey,outcome,
      metadataFailure ? "metadata_unsupported" : stale ? "structural_stale" : error instanceof SearchStructuralUnsupportedError
        ? "unsupported_structure" : code === "malformed_record" ? "malformed_record" : "index_failed");
    return {sessionId,chunkCount:0,skipped:true,retryable:!stable,outcome,error:stable ? "Search input unsupported" : "Search indexing failed"};
  } finally {
    if (generation) db.prepare("UPDATE search_generations SET active=0 WHERE generation=?").run(generation);
  }
}

function cancelSessionWork(sessionId: string): void {
  queue.cancelWhere((key) => JSON.parse(key)[0] === sessionId);
}
export function removeSession(sessionId: string): Promise<void> {
  if (ownerStopped) return Promise.reject(new SearchQueueUnavailableError("Search owner stopped"));
  const epoch = producerEpoch;
  cancelSessionWork(sessionId);
  purgeSessionIndex(sessionId);
  invalidateTranscriptPaginationSession(sessionId);
  return trackProducer(cleanupSearchChunks(getSearchDb(),{sessionId,maxBatches:4,
    shouldContinue:() => !ownerStopped && epoch === producerEpoch}).then(() => undefined));
}
export function beginTranscriptMutationSearchFence(sessionId: string): void {
  if (ownerStopped) throw new SearchQueueUnavailableError("Search owner stopped");
  if (transcriptMutationFences.has(sessionId)) throw new Error("A transcript mutation search fence is already active");
  transcriptMutationFences.add(sessionId);
  cancelSessionWork(sessionId);
  try { purgeSessionIndex(sessionId); invalidateTranscriptPaginationSession(sessionId); }
  catch (error) { transcriptMutationFences.delete(sessionId); throw error; }
}
export function endTranscriptMutationSearchFence(sessionId: string): void { transcriptMutationFences.delete(sessionId); }
export function purgePolicyDeniedSessions(options: {ensureSearchDb?: () => unknown} = {}): {purged:number;errors:number} {
  if (ownerStopped) return {purged:0,errors:1};
  try { (options.ensureSearchDb ?? getSearchDb)(); }
  catch { console.error("[search] policy purge unavailable"); return {purged:0,errors:1}; }
  let purged = 0; let errors = 0;
  const reclaimBudget = {bytes:128*1024,rows:16};
  for (const row of listSessions(true)) {
    const recovery = eventRecoveryMarkerForSession(row.id);
    // A recovery marker alone denies ordinary queries/work, not its own exact
    // reconciliation. Real privacy/quarantine revocation must still purge it.
    if (recovery && !policyDenial(row,recovery.id)) continue;
    if (!policyDenial(row)) continue;
    try { cancelSessionWork(row.id); purgeSessionIndex(row.id,reclaimBudget); invalidateTranscriptPaginationSession(row.id); purged++; }
    catch { errors++; }
  }
  return {purged,errors};
}
export function reindexAll(options: IndexerOptions = {}): Promise<IndexBatchSummary> {
  if (ownerStopped) return Promise.resolve({total:0,indexed:0,skipped:0,errors:1,durationMs:0});
  return trackProducer(reindexAllAttempt(options,producerEpoch));
}
async function reindexAllAttempt(options: IndexerOptions, epoch: number): Promise<IndexBatchSummary> {
  const start = Date.now();
  ensureDreamPolicyProjection();
  const sessions = listSessions(true);
  let indexed = 0; let skipped = 0; let errors = 0;
  for (const row of sessions) {
    // Manual and background corpus producers share the same lifecycle fence.
    // A rapid stop/start must not revive a predecessor's loop either.
    if (ownerStopped || epoch !== producerEpoch || queue.status().stopped) break;
    try {
      const result = await indexSession(row.id,options);
      if (result.skipped) skipped++; else indexed++;
      if (result.error) errors++;
    } catch (error) { if (error instanceof DreamPolicyProjectionUnavailableError) throw error; errors++; }
    await yieldSearchTurn();
  }
  return {total:sessions.length,indexed,skipped,errors,durationMs:Date.now()-start};
}
function policyDenial(row: SessionRow, recoveryMarkerId?: string): boolean {
  const current = getStore().sessions.find((candidate) => candidate.id === row.id);
  return !current || !isSessionIndexable(current,{recoveryMarkerId});
}
function purgeSessionIndex(sessionId: string, reclaimBudget = {bytes:128*1024,rows:16}): void {
  invalidations.set(sessionId,(invalidations.get(sessionId) ?? 0)+1);
  for (const [marker,request] of recoveryRequests) if(request.sessionId===sessionId)recoveryRequests.delete(marker);
  const db = getSearchDb();
  db.transaction(() => {
    invalidatePublication(db,sessionId);
    db.prepare("UPDATE search_generations SET active=0 WHERE session_id=?").run(sessionId);
    db.prepare("DELETE FROM session_index_state WHERE session_id=?").run(sessionId);
    db.prepare("DELETE FROM search_session_metadata WHERE session_id=?").run(sessionId);
    db.prepare("DELETE FROM search_work_state WHERE session_id=?").run(sessionId);
    // Fast small-session reclamation; large purges remain invisible and are
    // reclaimed by the bounded maintenance pass, never one giant FTS cascade.
    if (reclaimBudget.rows > 0 && reclaimBudget.bytes > 0) {
      const rows = db.prepare("SELECT id,length(CAST(text AS BLOB)) AS bytes FROM chunks WHERE session_id=? LIMIT ?")
        .all(sessionId,reclaimBudget.rows) as Array<{id:number;bytes:number}>;
      for (const row of rows) {
        if (row.bytes > reclaimBudget.bytes) break;
        db.prepare("DELETE FROM chunks WHERE id=?").run(row.id);
        reclaimBudget.bytes -= row.bytes; reclaimBudget.rows--;
      }
    }
  })();
}
function purgePolicyDeniedSession(sessionId: string): IndexResult {
  try { purgeSessionIndex(sessionId); invalidateTranscriptPaginationSession(sessionId);
    return {sessionId,chunkCount:0,skipped:true,policySkipped:true}; }
  catch { return {sessionId,chunkCount:0,skipped:true,policySkipped:true,error:"Denied search cleanup failed"}; }
}
