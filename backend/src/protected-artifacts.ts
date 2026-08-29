import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { commandGuardIdentityPinPath } from "./command-guard-pin.js";
import { getConfig } from "./config.js";
import { getStore, getStorePublicationGeneration } from "./db.js";

export const LEGACY_ATTACHMENT_ROOT = "/tmp/wayang-attachments";
export const ATTACHMENTS_DIRECTORY_NAME = "attachments";
export const PSEUDO_CONTROL_ROOTS = ["/proc", "/sys", "/dev"] as const;

interface ProtectedArtifactManifest {
  key: string;
  dataRoot: string;
  checkoutRoot: string;
  agentRoot: string;
  pinPath: string;
  sessionRoots: string[];
  projectRoots: string[];
  knownTranscripts: string[];
}

export interface ProtectedArtifactRootSnapshot {
  readonly manifestKey: string;
  readonly nonTranscriptReadDenyRoots: readonly string[];
  readonly piSessionStorageRoots: readonly string[];
  readonly knownTranscriptPaths: readonly string[];
  readonly registeredProjectBrowserRoots: readonly string[];
  readonly registeredProjectSecretPaths: readonly string[];
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly restrictedAgentRoots: readonly string[];
}

interface SnapshotCacheEntry {
  snapshot: ProtectedArtifactRootSnapshot;
  watchers: fs.FSWatcher[];
  transientInvalidation: NodeJS.Immediate | null;
}

interface ProtectedArtifactTestHooks {
  observeCanonicalize?: (target: string) => void;
  watch?: (target: string, listener: fs.WatchListener<string>) => fs.FSWatcher;
  observeInvalidation?: (reason: string) => void;
}

let snapshotCache: SnapshotCacheEntry | null = null;
let manifestCache: {
  storeGeneration: number;
  environmentKey: string;
  manifest: ProtectedArtifactManifest;
} | null = null;
let testHooks: ProtectedArtifactTestHooks | null = null;

function canonicalExistingOrResolved(target: string): string {
  const absolute = path.resolve(target);
  testHooks?.observeCanonicalize?.(absolute);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    const missing: string[] = [];
    let cursor = absolute;
    while (!fs.existsSync(cursor)) {
      const parent = path.dirname(cursor);
      if (parent === cursor) return absolute;
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
    try {
      return path.join(fs.realpathSync.native(cursor), ...missing);
    } catch {
      return absolute;
    }
  }
}

/** Retain both lexical aliases and canonical targets for OS-sandbox mounts. */
function uniqueCanonicalPaths(paths: Iterable<string>): string[] {
  return [...new Set([...paths].flatMap((target) => [path.resolve(target), canonicalExistingOrResolved(target)]))];
}

function lexicalWayangDataRoot(): string {
  return path.resolve(getConfig().dataDir);
}

function lexicalWayangCheckoutRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function lexicalPiAgentRoot(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim()
    || path.join(os.homedir(), ".pi", "agent");
  return path.resolve(configured);
}

function lexicalPiSessionRoots(agentRoot = lexicalPiAgentRoot()): string[] {
  const configuredSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  return [...new Set([
    path.join(agentRoot, "sessions"),
    ...(configuredSessionDir ? [path.resolve(configuredSessionDir)] : []),
  ].map((target) => path.resolve(target)))];
}

function captureManifest(): ProtectedArtifactManifest {
  const store = getStore();
  const storeGeneration = getStorePublicationGeneration();
  const dataRoot = lexicalWayangDataRoot();
  const checkoutRoot = lexicalWayangCheckoutRoot();
  const agentRoot = lexicalPiAgentRoot();
  const pinPath = path.resolve(commandGuardIdentityPinPath());
  const sessionRoots = lexicalPiSessionRoots(agentRoot).sort();
  const environmentKey = JSON.stringify({ dataRoot, checkoutRoot, agentRoot, pinPath, sessionRoots });
  if (manifestCache?.storeGeneration === storeGeneration && manifestCache.environmentKey === environmentKey) {
    return manifestCache.manifest;
  }
  const projectRoots = [...new Set(store.projects.map((project) => path.resolve(project.cwd)))].sort();
  const knownTranscripts = [...new Set(store.sessions.flatMap((session) => (
    session.pi_session_file ? [path.resolve(session.pi_session_file)] : []
  )))].sort();
  const key = createHash("sha256").update(JSON.stringify({
    dataRoot,
    checkoutRoot,
    agentRoot,
    pinPath,
    sessionRoots,
    projectRoots,
    knownTranscripts,
  })).digest("hex");
  const manifest = { key, dataRoot, checkoutRoot, agentRoot, pinPath, sessionRoots, projectRoots, knownTranscripts };
  manifestCache = { storeGeneration, environmentKey, manifest };
  return manifest;
}

function invalidateSnapshot(reason: string, expected?: SnapshotCacheEntry): void {
  const entry = snapshotCache;
  if (!entry || (expected && entry !== expected)) return;
  snapshotCache = null;
  if (entry.transientInvalidation) clearImmediate(entry.transientInvalidation);
  entry.transientInvalidation = null;
  for (const watcher of entry.watchers) {
    try { watcher.close(); } catch { /* already closed */ }
  }
  entry.watchers.length = 0;
  testHooks?.observeInvalidation?.(reason);
}

interface WatchSpec {
  names: Set<string>;
  required: boolean;
}

function addWatchSpec(specs: Map<string, WatchSpec>, directory: string, names: Iterable<string>, required: boolean): void {
  const resolved = path.resolve(directory);
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(resolved);
    if (metadata.isSymbolicLink()) metadata = fs.statSync(resolved);
  } catch {
    if (required) specs.set(resolved, { names: new Set(names), required: true });
    return;
  }
  if (!metadata.isDirectory()) {
    if (required) specs.set(resolved, { names: new Set(names), required: true });
    return;
  }
  const existing = specs.get(resolved);
  if (existing) {
    for (const name of names) existing.names.add(name);
    existing.required ||= required;
  } else {
    specs.set(resolved, { names: new Set(names), required });
  }
}

function installSnapshotWatchers(
  entry: SnapshotCacheEntry,
  manifest: ProtectedArtifactManifest,
  forceTurnScoped: boolean,
): void {
  const specs = new Map<string, WatchSpec>();
  addWatchSpec(specs, path.dirname(manifest.dataRoot), [path.basename(manifest.dataRoot)], true);
  addWatchSpec(specs, manifest.checkoutRoot, [".env", ".env.backup"], true);
  addWatchSpec(specs, path.dirname(manifest.agentRoot), [path.basename(manifest.agentRoot)], true);
  addWatchSpec(specs, manifest.agentRoot, ["auth.json", "settings.json", "models.json", "sessions"], true);
  addWatchSpec(specs, path.dirname(manifest.pinPath), [path.basename(manifest.pinPath)], true);
  for (const sessionRoot of manifest.sessionRoots) {
    addWatchSpec(specs, path.dirname(sessionRoot), [path.basename(sessionRoot)], true);
  }

  for (const projectRoot of manifest.projectRoots) {
    addWatchSpec(specs, projectRoot, [".env", ".env.backup", ".pi"], true);
    addWatchSpec(specs, path.join(projectRoot, ".pi"), ["browser-workbench"], false);
  }
  const transcriptNamesByParent = new Map<string, Set<string>>();
  for (const transcript of manifest.knownTranscripts) {
    const parent = path.dirname(transcript);
    const names = transcriptNamesByParent.get(parent) ?? new Set<string>();
    names.add(path.basename(transcript));
    transcriptNamesByParent.set(parent, names);
  }
  for (const [parent, names] of transcriptNamesByParent) addWatchSpec(specs, parent, names, true);

  let reusable = !forceTurnScoped;
  const watch = testHooks?.watch
    ?? ((target: string, listener: fs.WatchListener<string>) => fs.watch(target, { persistent: false }, listener));
  for (const [directory, spec] of specs) {
    try {
      const watcher = watch(directory, (eventType, fileName) => {
        if (eventType !== "rename") return;
        const name = fileName === null ? null : String(fileName);
        if (name !== null && spec.names.size > 0 && !spec.names.has(name)) return;
        invalidateSnapshot("filesystem_change", entry);
      });
      watcher.unref?.();
      watcher.on("error", () => invalidateSnapshot("watch_error", entry));
      entry.watchers.push(watcher);
    } catch {
      if (spec.required) reusable = false;
    }
  }
  if (!reusable) {
    const reason = forceTurnScoped ? "symlink_alias" : "unwatchable_root";
    entry.transientInvalidation = setImmediate(() => invalidateSnapshot(reason, entry));
    entry.transientInvalidation.unref?.();
  }
}

function buildSnapshot(manifest: ProtectedArtifactManifest): SnapshotCacheEntry {
  const projectSecretPaths = manifest.projectRoots.flatMap((projectRoot) => [
    path.join(projectRoot, ".env"),
    path.join(projectRoot, ".env.backup"),
  ]);
  const projectBrowserRoots = manifest.projectRoots.map((projectRoot) => (
    path.join(projectRoot, ".pi", "browser-workbench")
  ));
  const checkoutSecretPaths = [
    path.join(manifest.checkoutRoot, ".env"),
    path.join(manifest.checkoutRoot, ".env.backup"),
  ];
  const piSecretPaths = [
    path.join(manifest.agentRoot, "auth.json"),
    path.join(manifest.agentRoot, "settings.json"),
    path.join(manifest.agentRoot, "models.json"),
  ];
  const nonTranscriptInputs = [
    manifest.dataRoot,
    LEGACY_ATTACHMENT_ROOT,
    manifest.pinPath,
    ...piSecretPaths,
    ...checkoutSecretPaths,
    ...projectSecretPaths,
    ...projectBrowserRoots,
    ...PSEUDO_CONTROL_ROOTS,
  ];
  const allInputs = [...new Set([
    ...nonTranscriptInputs,
    ...manifest.sessionRoots,
    ...manifest.knownTranscripts,
    manifest.agentRoot,
  ].map((target) => path.resolve(target)))];
  const canonical = new Map(allInputs.map((target) => [target, canonicalExistingOrResolved(target)]));
  // A watcher on the lexical parent cannot prove that every nested symlink in
  // a canonical target chain remained unchanged. Keep such snapshots scoped to
  // the current event-loop turn; the next authorization rebuilds from disk.
  const canonicalAliasInputs = [
    manifest.dataRoot,
    manifest.agentRoot,
    manifest.pinPath,
    ...manifest.sessionRoots,
    ...manifest.knownTranscripts,
    ...piSecretPaths,
    ...checkoutSecretPaths,
    ...projectSecretPaths,
    ...projectBrowserRoots,
  ].map((target) => path.resolve(target));
  const hasCanonicalAlias = canonicalAliasInputs.some((target) => canonical.get(target) !== target);
  const expand = (inputs: Iterable<string>): readonly string[] => Object.freeze([...new Set(
    [...inputs].flatMap((target) => {
      const lexical = path.resolve(target);
      return [lexical, canonical.get(lexical) ?? lexical];
    }),
  )]);
  const nonTranscriptReadDenyRoots = expand(nonTranscriptInputs);
  const piSessionStorageRoots = expand(manifest.sessionRoots);
  const knownTranscriptPaths = expand(manifest.knownTranscripts);
  const registeredProjectBrowserRoots = expand(projectBrowserRoots);
  const registeredProjectSecretPaths = expand(projectSecretPaths);
  const readRoots = expand([
    ...nonTranscriptReadDenyRoots,
    ...piSessionStorageRoots,
    ...knownTranscriptPaths,
  ]);
  const restrictedAgentRoots = expand([manifest.agentRoot, ...readRoots]);
  const snapshot: ProtectedArtifactRootSnapshot = Object.freeze({
    manifestKey: manifest.key,
    nonTranscriptReadDenyRoots,
    piSessionStorageRoots,
    knownTranscriptPaths,
    registeredProjectBrowserRoots,
    registeredProjectSecretPaths,
    readRoots,
    writeRoots: readRoots,
    restrictedAgentRoots,
  });
  const entry: SnapshotCacheEntry = { snapshot, watchers: [], transientInvalidation: null };
  snapshotCache = entry;
  installSnapshotWatchers(entry, manifest, hasCanonicalAlias);
  return entry;
}

/** One coherent lexical+canonical policy image shared by a synchronous authorization phase. */
export function getProtectedArtifactRootSnapshot(): ProtectedArtifactRootSnapshot {
  const manifest = captureManifest();
  if (snapshotCache?.snapshot.manifestKey !== manifest.key) {
    invalidateSnapshot("manifest_change");
  }
  return (snapshotCache ?? buildSnapshot(manifest)).snapshot;
}

/** @internal Synthetic cache/watch seams; production never marks a snapshot valid. */
export function setProtectedArtifactTestHooksForTests(hooks: ProtectedArtifactTestHooks | null): void {
  invalidateSnapshot("test_reset");
  testHooks = hooks;
}

export function getWayangDataRoot(): string {
  return canonicalExistingOrResolved(lexicalWayangDataRoot());
}

/** Source and built layouts both place this module two levels below checkout root. */
export function getWayangCheckoutRoot(): string {
  return canonicalExistingOrResolved(lexicalWayangCheckoutRoot());
}

/** Launcher configuration is sensitive even when the checkout is not a registered project. */
export function getWayangCheckoutSecretPaths(): string[] {
  const root = getWayangCheckoutRoot();
  return uniqueCanonicalPaths([
    path.join(root, ".env"),
    path.join(root, ".env.backup"),
  ]);
}

export function getAttachmentsRoot(): string {
  return path.join(getWayangDataRoot(), ATTACHMENTS_DIRECTORY_NAME);
}

export function validateAttachmentSessionId(sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) {
    throw new Error("Invalid attachment session id");
  }
  return sessionId;
}

export function getSessionAttachmentRoot(sessionId: string): string {
  return path.join(getAttachmentsRoot(), validateAttachmentSessionId(sessionId));
}

export function getPiAgentRoot(): string {
  return canonicalExistingOrResolved(lexicalPiAgentRoot());
}

/** Pi's default/configured session roots are protected even before cataloging. */
export function getPiSessionStorageRoots(): string[] {
  return uniqueCanonicalPaths(lexicalPiSessionRoots());
}

/** Exact known transcript files remain OS-denied even outside configured session roots. */
export function getKnownPiTranscriptPaths(): string[] {
  return [...getProtectedArtifactRootSnapshot().knownTranscriptPaths];
}

/** Managed browser profiles are bearer-sensitive regardless of project policy. */
export function getRegisteredProjectBrowserRoots(): string[] {
  return [...getProtectedArtifactRootSnapshot().registeredProjectBrowserRoots];
}

/** Documented project-root configuration files that may contain provider keys. */
export function getRegisteredProjectSecretPaths(): string[] {
  return [...getProtectedArtifactRootSnapshot().registeredProjectSecretPaths];
}

/** Exact command-guard PIN aliases and canonical target; values are never opened here. */
export function getCommandGuardIdentityPinProtectedPaths(): string[] {
  return uniqueCanonicalPaths([commandGuardIdentityPinPath()]);
}

/** Exact global Pi files that direct tools must never expose to any profile. */
export function getPiSecretBearingPaths(): string[] {
  const agentDir = getPiAgentRoot();
  return uniqueCanonicalPaths([
    path.join(agentDir, "auth.json"),
    path.join(agentDir, "settings.json"),
    path.join(agentDir, "models.json"),
  ]);
}

/** Universal denies that can never be overridden by Standard transcript ownership. */
export function getNonTranscriptUniversalReadDenyRoots(): string[] {
  return [...getProtectedArtifactRootSnapshot().nonTranscriptReadDenyRoots];
}

/** Universal direct-tool/sandbox deny roots; backend and UI code remain unaffected. */
export function getProtectedArtifactReadRoots(): string[] {
  return [...getProtectedArtifactRootSnapshot().readRoots];
}

export function getProtectedArtifactWriteRoots(): string[] {
  return [...getProtectedArtifactRootSnapshot().writeRoots];
}

/** Restricted profiles additionally receive no direct access anywhere in Pi's global root. */
export function getRestrictedAgentArtifactRoots(): string[] {
  return [...getProtectedArtifactRootSnapshot().restrictedAgentRoots];
}
