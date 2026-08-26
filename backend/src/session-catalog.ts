import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { authorizeProjectAction, getPolicyGeneration } from "./policy.js";
import { recordLatencyMetric } from "./latency-metrics.js";
import { writeDreamPolicyProjection } from "./search/policy-projection.js";
import {
  SessionMetadataWorkerPool,
  fingerprintsEqual,
  type FileFingerprint,
  type SessionFileMetadata,
} from "./session-metadata.js";
import {
  MAX_SESSION_HEADER_BYTES,
  MAX_SESSION_HEADER_ID_BYTES,
  readBoundedSessionHeader,
  type BoundedSessionHeader,
} from "./standard-transcript-authorization.js";

export { MAX_SESSION_HEADER_BYTES, MAX_SESSION_HEADER_ID_BYTES };

export interface CatalogKnownFile {
  fingerprint: FileFingerprint | null;
  mutationVersion: number;
}

export interface CatalogDurableSession {
  filePath: string;
  sessionId: string;
  projectId: string;
  cwd: string;
  mutationVersion: number;
}

export interface CatalogParsedFile {
  metadata: SessionFileMetadata;
  expectedMutationVersion: number;
}

export interface CatalogScanCommit {
  generation: number;
  discovered: Map<string, FileFingerprint>;
  parsed: CatalogParsedFile[];
  parseFailures: number;
}

export interface CatalogScanResult {
  imported: number;
  updated: number;
  archivedLegacy: number;
  discovered: number;
  parsed: number;
  parseBytes: number;
  headerBytes: number;
  parseFailures: number;
  durationMs: number;
  generation: number;
}

export interface SessionCatalogAdapter {
  getKnownFile(filePath: string): CatalogKnownFile;
  /** Universal path gate evaluated before even the bounded header is opened. */
  allowHeaderRead?(filePath: string): boolean;
  /** Resolve one canonical file/header pair against durable Standard-session authority. */
  classifyDurableSession(filePath: string, sessionId: string, headerCwd: string): CatalogDurableSession | null;
  /** Header-only denial-first import seam; must durably commit before returning authority. */
  stageDurableSession?(
    filePath: string,
    header: BoundedSessionHeader,
    fingerprint: FileFingerprint,
  ): { classification: CatalogDurableSession; imported: boolean } | null;
  commit(scan: CatalogScanCommit): { imported: number; updated: number; archivedLegacy: number; changed: boolean };
}

const SAFETY_SCAN_MS = Math.max(1_000, Number.parseInt(process.env.WAYANG_SESSION_CATALOG_SCAN_MS || "30000", 10) || 30_000);
const COMPLETION_COOLDOWN_MS = Math.max(100, Number.parseInt(process.env.WAYANG_SESSION_CATALOG_COOLDOWN_MS || "1000", 10) || 1_000);
const WATCH_DEBOUNCE_MS = 250;
export const MAX_CATALOG_BODY_BYTES = 16 * 1024 * 1024;

export interface SessionCatalogOptions {
  /** Test seams; production uses the central evaluator and atomic projection. */
  authorizeCwd?: (cwd: string) => boolean;
  getPolicyGeneration?: () => number;
  refreshProjection?: () => void;
  observePreAuthorizationBytes?: (bytes: Uint8Array) => void;
  onAuthorizedBodyTransferred?: () => void;
  observeWorkerTasksInFlight?: (count: number) => void;
}

function authorizeCatalogCwd(cwd: string): boolean {
  return authorizeProjectAction({ cwd, actor: "indexer" }).allowed;
}

function durableClassificationsEqual(left: CatalogDurableSession, right: CatalogDurableSession): boolean {
  return left.filePath === right.filePath
    && left.sessionId === right.sessionId
    && left.projectId === right.projectId
    && left.cwd === right.cwd
    && left.mutationVersion === right.mutationVersion;
}

export function getCanonicalSessionsRoot(): string {
  const explicitSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (explicitSessionDir) return path.resolve(explicitSessionDir);
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(path.resolve(agentDir), "sessions");
}

function fingerprintFromStat(stat: fs.Stats): FileFingerprint {
  return {
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    size: stat.size,
    ino: Number(stat.ino) || 0,
  };
}

async function enumerateCanonicalFiles(root: string): Promise<Map<string, FileFingerprint>> {
  const files = new Map<string, FileFingerprint>();
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }

  const candidates: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      candidates.push(entryPath);
      continue;
    }
    if (!entry.isDirectory()) continue;
    try {
      const children = await fsp.readdir(entryPath, { withFileTypes: true });
      for (const child of children) {
        if (child.isFile() && child.name.endsWith(".jsonl")) candidates.push(path.join(entryPath, child.name));
      }
    } catch {
      // A project directory may disappear during enumeration. The next safety
      // scan repairs it and missing-file grace prevents premature archival.
    }
  }

  const concurrency = 64;
  for (let offset = 0; offset < candidates.length; offset += concurrency) {
    const chunk = candidates.slice(offset, offset + concurrency);
    const stats = await Promise.all(chunk.map(async (filePath) => {
      try {
        return [filePath, fingerprintFromStat(await fsp.stat(filePath))] as const;
      } catch {
        return null;
      }
    }));
    for (const item of stats) if (item) files.set(item[0], item[1]);
  }
  return files;
}

export class SessionCatalog {
  private readonly events = new EventEmitter();
  private readonly workerPool = new SessionMetadataWorkerPool();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private generation = 1;
  private scanInFlight: Promise<CatalogScanResult> | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private safetyTimer: NodeJS.Timeout | null = null;
  private lastCompletedAt = 0;
  private pendingScan = false;
  private started = false;
  private lastError: "scan_failed" | null = null;

  constructor(
    private readonly adapter: SessionCatalogAdapter,
    private readonly root = getCanonicalSessionsRoot(),
    private readonly options: SessionCatalogOptions = {},
  ) {}

  getGeneration(): number {
    return this.generation;
  }

  getStatus(): {
    started: boolean;
    scanRunning: boolean;
    watcherCount: number;
    lastCompletedAt: number | null;
    lastError: "scan_failed" | null;
  } {
    return {
      started: this.started,
      scanRunning: this.scanInFlight !== null,
      watcherCount: this.watchers.size,
      lastCompletedAt: this.lastCompletedAt > 0 ? this.lastCompletedAt : null,
      lastError: this.lastError,
    };
  }

  onGeneration(listener: (generation: number) => void): () => void {
    this.events.on("generation", listener);
    return () => this.events.off("generation", listener);
  }

  bumpGeneration(): number {
    this.generation++;
    this.events.emit("generation", this.generation);
    return this.generation;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.requestScan("startup", 0);
    this.safetyTimer = setInterval(() => this.requestScan("safety"), SAFETY_SCAN_MS);
    this.safetyTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    this.scanTimer = null;
    this.safetyTimer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    await this.scanInFlight?.catch(() => undefined);
    await this.workerPool.close();
  }

  requestScan(_reason = "internal", minimumDelayMs = WATCH_DEBOUNCE_MS): void {
    if (!this.started) return;
    this.pendingScan = true;
    if (this.scanInFlight || this.scanTimer) return;
    const cooldownRemaining = Math.max(0, this.lastCompletedAt + COMPLETION_COOLDOWN_MS - Date.now());
    const delay = Math.max(minimumDelayMs, cooldownRemaining);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      if (!this.pendingScan) return;
      this.pendingScan = false;
      void this.scan().catch((error) => console.error("[session-catalog] scan failed", error));
    }, delay);
    this.scanTimer.unref?.();
  }

  scan(): Promise<CatalogScanResult> {
    if (this.scanInFlight) {
      this.pendingScan = true;
      return this.scanInFlight;
    }
    this.scanInFlight = this.performScan()
      .then((result) => {
        this.lastError = null;
        return result;
      })
      .catch((error) => {
        this.lastError = "scan_failed";
        throw error;
      })
      .finally(() => {
        this.lastCompletedAt = Date.now();
        this.scanInFlight = null;
        if (this.pendingScan && this.started) this.requestScan("coalesced");
      });
    return this.scanInFlight;
  }

  private async performScan(): Promise<CatalogScanResult> {
    const startedAt = performance.now();
    const scanGeneration = this.generation;
    const enumerateStartedAt = performance.now();
    const discovered = await enumerateCanonicalFiles(this.root);
    recordLatencyMetric("catalog_enumerate_ms", performance.now() - enumerateStartedAt);
    // Explicit manual import on an administratively paused/unstarted catalog
    // is one-shot and must never install persistent filesystem watchers.
    if (this.started) this.refreshWatchers(discovered);

    const changed: Array<{ filePath: string; fingerprint: FileFingerprint }> = [];
    for (const [filePath, fingerprint] of discovered) {
      const known = this.adapter.getKnownFile(filePath);
      if (!fingerprintsEqual(known.fingerprint, fingerprint)) {
        changed.push({ filePath, fingerprint });
      }
    }

    const workerStartedAt = performance.now();
    const parsedCandidates: Array<CatalogParsedFile & {
      authorizationGeneration: number;
      classification: CatalogDurableSession;
    }> = [];
    let parseBytes = 0;
    let headerBytes = 0;
    let parseFailures = 0;
    let stagedImports = 0;
    let workerTasksInFlight = 0;
    const authorizeCwd = this.options.authorizeCwd ?? authorizeCatalogCwd;
    const policyGeneration = this.options.getPolicyGeneration ?? getPolicyGeneration;

    // Admit at most one task per worker. No whole-corpus Promise.all or main-
    // thread body buffer exists; each worker reopens one bounded authorized file.
    for (let batchOffset = 0; batchOffset < changed.length; batchOffset += this.workerPool.capacity) {
      const batch = changed.slice(batchOffset, batchOffset + this.workerPool.capacity);
      const results = await Promise.all(batch.map(async (task) => {
        try {
          if (this.adapter.allowHeaderRead && !this.adapter.allowHeaderRead(task.filePath)) return null;
          const observed = readBoundedSessionHeader(
            task.filePath,
            task.fingerprint,
            this.options.observePreAuthorizationBytes,
          );
          headerBytes += observed.headerBytes;
          let classification = this.adapter.classifyDurableSession(
            observed.path,
            observed.header.id,
            observed.header.cwd,
          );
          if (!classification) {
            const staged = this.adapter.stageDurableSession?.(observed.path, observed.header, observed.fingerprint) ?? null;
            if (staged?.imported) stagedImports++;
            classification = staged?.classification ?? null;
          }
          if (!classification || !authorizeCwd(classification.cwd)) return null;
          const authorizationGeneration = policyGeneration();
          const rechecked = this.adapter.classifyDurableSession(
            observed.path,
            observed.header.id,
            observed.header.cwd,
          );
          if (!rechecked || !durableClassificationsEqual(classification, rechecked)
            || authorizationGeneration !== policyGeneration()) return null;

          workerTasksInFlight++;
          this.options.observeWorkerTasksInFlight?.(workerTasksInFlight);
          this.options.onAuthorizedBodyTransferred?.();
          try {
            const metadata = await this.workerPool.parseAuthorizedFile(
              observed.path,
              observed.fingerprint,
              MAX_CATALOG_BODY_BYTES,
            );
            return metadata ? {
              metadata,
              expectedMutationVersion: rechecked.mutationVersion,
              authorizationGeneration,
              classification: rechecked,
            } : null;
          } finally {
            workerTasksInFlight--;
            this.options.observeWorkerTasksInFlight?.(workerTasksInFlight);
          }
        } catch {
          parseFailures++;
          return null;
        }
      }));

      for (const result of results) {
        if (!result) continue;
        try {
          const current = fingerprintFromStat(await fsp.stat(result.metadata.path));
          if (!fingerprintsEqual(current, result.metadata.fingerprint)) {
            this.pendingScan = true;
            continue;
          }
        } catch {
          this.pendingScan = true;
          continue;
        }
        parsedCandidates.push(result);
        parseBytes += result.metadata.approximateBytes;
      }
      if (batchOffset + this.workerPool.capacity < changed.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    const workerDuration = performance.now() - workerStartedAt;
    recordLatencyMetric("catalog_worker_ms", workerDuration);
    recordLatencyMetric("catalog_parse_count", parsedCandidates.length);
    recordLatencyMetric("catalog_parse_bytes", parseBytes);
    recordLatencyMetric("catalog_header_bytes", headerBytes);

    // Any direct create/title/model/archive/delete mutation bumps the catalog
    // generation. Do not let work started before that mutation overwrite it;
    // a coalesced scan will re-enumerate against the new state.
    if (scanGeneration !== this.generation) {
      this.pendingScan = true;
      const durationMs = performance.now() - startedAt;
      recordLatencyMetric("catalog_scan_ms", durationMs);
      return {
        imported: 0,
        updated: 0,
        archivedLegacy: 0,
        discovered: discovered.size,
        parsed: 0,
        parseBytes,
        headerBytes,
        parseFailures,
        durationMs,
        // Report the generation this discarded scan actually observed. Callers
        // awaiting a mutation fence must loop and drive a fresh scan rather
        // than mistaking the newer process generation for committed metadata.
        generation: scanGeneration,
      };
    }

    // Worker parsing is deliberately asynchronous. Immediately before commit,
    // require the same unique durable row/path/Project classification plus a
    // fresh policy decision. No await occurs between this barrier and commit.
    const parsed: CatalogParsedFile[] = [];
    for (const candidate of parsedCandidates) {
      const generationBefore = policyGeneration();
      const fresh = this.adapter.classifyDurableSession(
        candidate.metadata.path,
        candidate.metadata.id,
        candidate.metadata.cwd,
      );
      const stillAllowed = Boolean(fresh && authorizeCwd(fresh.cwd));
      const generationAfter = policyGeneration();
      if (!fresh || !durableClassificationsEqual(candidate.classification, fresh)
        || !stillAllowed || candidate.authorizationGeneration !== generationBefore
        || generationBefore !== generationAfter) {
        this.pendingScan = true;
        continue;
      }
      parsed.push({ metadata: candidate.metadata, expectedMutationVersion: fresh.mutationVersion });
    }

    const committed = this.adapter.commit({
      generation: scanGeneration,
      discovered,
      parsed,
      parseFailures,
    });
    if (committed.changed || stagedImports > 0) {
      // Header-only staging is durable before body admission. Publish its new
      // Standard row together with any parsed metadata changes.
      try { (this.options.refreshProjection ?? writeDreamPolicyProjection)(); }
      catch (error) { console.error("[session-catalog] policy projection refresh failed", error); }
      this.bumpGeneration();
    }

    const durationMs = performance.now() - startedAt;
    recordLatencyMetric("catalog_scan_ms", durationMs);
    if (process.env.WAYANG_LATENCY_PROFILE_VERBOSE === "1") {
      console.log(`[session-catalog] discovered=${discovered.size} parsed=${parsed.length} bytes=${parseBytes} header_bytes=${headerBytes} failures=${parseFailures} duration_ms=${durationMs.toFixed(1)}`);
    }
    return {
      imported: committed.imported + stagedImports,
      updated: committed.updated,
      archivedLegacy: committed.archivedLegacy,
      discovered: discovered.size,
      parsed: parsed.length,
      parseBytes,
      headerBytes,
      parseFailures,
      durationMs,
      generation: this.generation,
    };
  }

  private refreshWatchers(discovered: Map<string, FileFingerprint>): void {
    const directories = new Set<string>([this.root]);
    for (const filePath of discovered.keys()) directories.add(path.dirname(filePath));
    for (const [directory, watcher] of this.watchers) {
      if (!directories.has(directory)) {
        watcher.close();
        this.watchers.delete(directory);
      }
    }
    for (const directory of directories) {
      if (this.watchers.has(directory)) continue;
      try {
        const watcher = fs.watch(directory, { persistent: false }, (_event, fileName) => {
          if (!fileName || String(fileName).endsWith(".jsonl") || directory === this.root) this.requestScan("watch");
        });
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(directory);
        });
        this.watchers.set(directory, watcher);
      } catch {
        // Periodic enumeration remains the correctness mechanism.
      }
    }
  }
}
