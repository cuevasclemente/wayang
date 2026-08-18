import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { authorizeProjectAction, getPolicyGeneration } from "./policy.js";
import { ensureProjectForCwd } from "./projects.js";
import { recordLatencyMetric } from "./latency-metrics.js";
import { writeDreamPolicyProjection } from "./search/policy-projection.js";
import {
  SessionMetadataWorkerPool,
  fingerprintsEqual,
  type FileFingerprint,
  type SessionFileMetadata,
} from "./session-metadata.js";

export interface CatalogKnownFile {
  fingerprint: FileFingerprint | null;
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
  commit(scan: CatalogScanCommit): { imported: number; updated: number; archivedLegacy: number; changed: boolean };
}

const SAFETY_SCAN_MS = Math.max(1_000, Number.parseInt(process.env.WAYANG_SESSION_CATALOG_SCAN_MS || "30000", 10) || 30_000);
const COMPLETION_COOLDOWN_MS = Math.max(100, Number.parseInt(process.env.WAYANG_SESSION_CATALOG_COOLDOWN_MS || "1000", 10) || 1_000);
const WATCH_DEBOUNCE_MS = 250;
export const MAX_SESSION_HEADER_BYTES = 64 * 1024;

export interface SessionCatalogOptions {
  /** Test seams; production uses the central evaluator and atomic projection. */
  authorizeCwd?: (cwd: string) => boolean;
  getPolicyGeneration?: () => number;
  refreshProjection?: () => void;
  observePreAuthorizationBytes?: (bytes: Uint8Array) => void;
  onAuthorizedBodyTransferred?: () => void;
}

function authorizeCatalogCwd(cwd: string): boolean {
  let decision = authorizeProjectAction({ cwd, actor: "indexer" });
  if (decision.code === "project_not_registered") {
    // Catalog discovery has always reconciled new cwd values into Projects.
    // Registration happens after bounded header parsing and before body access.
    ensureProjectForCwd(cwd);
    decision = authorizeProjectAction({ cwd, actor: "indexer" });
  }
  return decision.allowed;
}

function readAuthorizedContent(
  filePath: string,
  fingerprint: FileFingerprint,
  authorizeCwd: (cwd: string) => boolean,
  observePreAuthorizationBytes?: (bytes: Uint8Array) => void,
): { content: Uint8Array | null; headerBytes: number; denied: boolean } {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(filePath, flags);
  try {
    const before = fingerprintFromStat(fs.fstatSync(fd));
    if (!fingerprintsEqual(before, fingerprint)) throw new Error("Session file changed before header authorization");
    // Read exactly through LF, one byte at a time. Chunked pread/read calls may
    // fill their buffer with body bytes after a short header, which would cross
    // the authorization boundary even if those bytes were not parsed.
    const maximum = Math.min(MAX_SESSION_HEADER_BYTES, fingerprint.size);
    const headerBuffer = new Uint8Array(maximum);
    const singleByte = new Uint8Array(1);
    let headerLength = 0;
    let foundNewline = false;
    while (headerLength < maximum) {
      const count = fs.readSync(fd, singleByte, 0, 1, null);
      if (count === 0) break;
      headerBuffer[headerLength++] = singleByte[0]!;
      if (singleByte[0] === 0x0a) {
        foundNewline = true;
        break;
      }
    }
    if (!foundNewline && fingerprint.size > headerLength) {
      throw new Error("Session header exceeds the bounded authorization limit");
    }
    const authorizedPrefix = headerBuffer.subarray(0, headerLength);
    observePreAuthorizationBytes?.(authorizedPrefix);
    const lineLength = foundNewline ? headerLength - 1 : headerLength;
    const headerLine = Buffer.from(authorizedPrefix.subarray(0, lineLength)).toString("utf8").replace(/\r$/, "").trim();
    let header: unknown;
    try { header = JSON.parse(headerLine); } catch { throw new Error("Session header is malformed"); }
    if (!header || typeof header !== "object" || (header as { type?: unknown }).type !== "session") {
      throw new Error("Session header is missing");
    }
    const cwd = (header as { cwd?: unknown }).cwd;
    if (typeof cwd !== "string" || !cwd.trim()) throw new Error("Session header cwd is missing");
    if (!authorizeCwd(cwd)) return { content: null, headerBytes: headerLength, denied: true };

    // No await/yield occurs between the central decision and this read. Policy
    // writes run on the same main event loop, so tightening cannot interleave.
    // The fd offset is exactly after the header LF; continue from there and
    // prepend only the already-authorized header for off-thread parsing.
    const content = new Uint8Array(fingerprint.size);
    content.set(authorizedPrefix, 0);
    let offset = headerLength;
    while (offset < content.byteLength) {
      const count = fs.readSync(fd, content, offset, content.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fingerprintFromStat(fs.fstatSync(fd));
    if (!fingerprintsEqual(after, fingerprint) || offset !== fingerprint.size) {
      throw new Error("Session file changed during authorized metadata read");
    }
    return { content, headerBytes: headerLength, denied: false };
  } finally {
    fs.closeSync(fd);
  }
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

  constructor(
    private readonly adapter: SessionCatalogAdapter,
    private readonly root = getCanonicalSessionsRoot(),
    private readonly options: SessionCatalogOptions = {},
  ) {}

  getGeneration(): number {
    return this.generation;
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
    this.scanInFlight = this.performScan().finally(() => {
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
    this.refreshWatchers(discovered);

    const changed: Array<{ filePath: string; fingerprint: FileFingerprint; mutationVersion: number }> = [];
    for (const [filePath, fingerprint] of discovered) {
      const known = this.adapter.getKnownFile(filePath);
      if (!fingerprintsEqual(known.fingerprint, fingerprint)) {
        changed.push({ filePath, fingerprint, mutationVersion: known.mutationVersion });
      }
    }

    const workerStartedAt = performance.now();
    const parsedCandidates: Array<CatalogParsedFile & { authorizationGeneration: number }> = [];
    let parseBytes = 0;
    let headerBytes = 0;
    let parseFailures = 0;
    const authorizeCwd = this.options.authorizeCwd ?? authorizeCatalogCwd;
    const policyGeneration = this.options.getPolicyGeneration ?? getPolicyGeneration;
    const results = await Promise.all(changed.map(async (task) => {
      try {
        const authorizationGeneration = policyGeneration();
        const gated = readAuthorizedContent(
          task.filePath,
          task.fingerprint,
          authorizeCwd,
          this.options.observePreAuthorizationBytes,
        );
        headerBytes += gated.headerBytes;
        if (gated.denied || gated.content === null) return null;
        const metadataPromise = this.workerPool.parseAuthorizedContent(task.filePath, task.fingerprint, gated.content);
        this.options.onAuthorizedBodyTransferred?.();
        const metadata = await metadataPromise;
        return metadata ? { metadata, expectedMutationVersion: task.mutationVersion, authorizationGeneration } : null;
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
    // require both a fresh cwd authorization and the exact generation captured
    // before authorized body transfer. No await occurs between this barrier and
    // adapter.commit(), so a policy write cannot interleave on the main thread.
    const parsed: CatalogParsedFile[] = [];
    for (const candidate of parsedCandidates) {
      const generationBefore = policyGeneration();
      const stillAllowed = authorizeCwd(candidate.metadata.cwd);
      const generationAfter = policyGeneration();
      if (!stillAllowed || candidate.authorizationGeneration !== generationBefore || generationBefore !== generationAfter) {
        this.pendingScan = true;
        continue;
      }
      parsed.push({ metadata: candidate.metadata, expectedMutationVersion: candidate.expectedMutationVersion });
    }

    const committed = this.adapter.commit({
      generation: scanGeneration,
      discovered,
      parsed,
      parseFailures,
    });
    if (committed.changed) {
      // The projection is atomic and complete; publish after catalog metadata
      // commits. Until publication, a newly seen path is unknown-deny.
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
      imported: committed.imported,
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
