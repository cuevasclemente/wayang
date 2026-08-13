import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceCapabilityAssociationRow } from "../workspace-types.js";

export const MAX_BROWSER_PROFILE_ROWS = 128;
export const MAX_BROWSER_PROFILE_TRASH_ROWS = 16;
export const MAX_BROWSER_CLEANUP_ROWS = 512;
export const MAX_BROWSER_CLEANUP_DOWNLOAD_OWNERS = 64;

export type BrowserProfileStorageSource =
  | { kind: "managed"; storage_key: string }
  | { kind: "legacy_shared" }
  | { kind: "standard_pair_v1"; project_id: string; agent_profile_id: string }
  | { kind: "legacy_scoped"; migration_id: string };

export type BrowserProfileState = "active" | "disabled" | "trash_pending" | "trashed" | "purge_pending";

export interface BrowserProfileRow {
  id: string;
  name: string;
  storage_source: BrowserProfileStorageSource;
  storage_identity_digest: string;
  state: BrowserProfileState;
  revision: number;
  created_at: number;
  updated_at: number;
}

export interface ProjectBrowserDefaultRow {
  project_id: string;
  profile_id: string | null;
  revision: number;
  updated_at: number;
  updated_by: "owner" | "agent";
}

export interface SessionBrowserStateRow {
  session_id: string;
  active_profile_id: string | null;
  revision: number;
  updated_at: number;
}

export interface BrowserCleanupRow {
  id: string;
  subject_kind: "session_workspace" | "profile" | "host";
  profile_id: string;
  source_session_id: string | null;
  workspace_generation: string | null;
  storage_identity_digest: string;
  immutable_download_owner_ids: string[];
  recovery_entry_id: string | null;
  state: "pending" | "verified" | "cleanup_failed";
  attempts: number;
  last_attempt_at: number | null;
  created_at: number;
  updated_at: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const STORAGE_KEY_PATTERN = /^[0-9a-z][0-9a-z_-]{0,63}$/u;
const BIDI_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value === value.normalize("NFC") && !/[\u0000-\u001f\u007f]/u.test(value);
}

function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < Number.MAX_SAFE_INTEGER;
}

function timestamp(value: unknown, nullable = false): boolean {
  return (nullable && value === null) || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

export function validBrowserProfileName(value: unknown): value is string {
  return typeof value === "string" && value === value.normalize("NFC") && value.trim() === value
    && value.length > 0 && Buffer.byteLength(value, "utf8") <= 120
    && !/[\u0000-\u001f\u007f]/u.test(value) && !BIDI_PATTERN.test(value);
}

function storageIdSegment(prefix: "project" | "profile", immutableId: string): string {
  const digest = createHash("sha256").update(immutableId, "utf8").digest("base64url");
  return `${prefix}-${digest}`;
}

export function browserProfileStorageRoot(dataDir: string, source: BrowserProfileStorageSource): string {
  const requestedBase = path.resolve(dataDir);
  const base = fs.realpathSync.native(requestedBase);
  if (source.kind === "managed") return path.join(base, "browser-profiles", "v1", "profiles", source.storage_key);
  if (source.kind === "legacy_shared") return path.join(base, "browser-workbench", "profiles", "shared");
  if (source.kind === "standard_pair_v1") {
    return path.join(base, "standard-browser", "v1", storageIdSegment("project", source.project_id), storageIdSegment("profile", source.agent_profile_id), "profile");
  }
  return path.join(base, "browser-profiles", "v1", "legacy-scoped", source.migration_id);
}

export function browserProfileStorageIdentityDigest(dataDir: string, source: BrowserProfileStorageSource): string {
  const root = browserProfileStorageRoot(dataDir, source);
  return createHash("sha256").update(`wayang-browser-storage-v1\0${root}`, "utf8").digest("hex");
}

function validStorageSource(value: unknown): value is BrowserProfileStorageSource {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<BrowserProfileStorageSource> & Record<string, unknown>;
  if (source.kind === "managed") return exactKeys(source, ["kind", "storage_key"])
    && typeof source.storage_key === "string" && STORAGE_KEY_PATTERN.test(source.storage_key);
  if (source.kind === "legacy_shared") return exactKeys(source, ["kind"]);
  if (source.kind === "standard_pair_v1") return exactKeys(source, ["kind", "project_id", "agent_profile_id"])
    && stableId(source.project_id) && stableId(source.agent_profile_id);
  if (source.kind === "legacy_scoped") return exactKeys(source, ["kind", "migration_id"])
    && stableId(source.migration_id);
  return false;
}

export interface BrowserCatalogValidationInput {
  dataDir: string;
  browserProfiles: unknown;
  projectBrowserDefaults: unknown;
  sessionBrowserStates: unknown;
  browserCleanups: unknown;
  projectIds: ReadonlySet<string>;
  sessionIds: ReadonlySet<string>;
}

export function validateBrowserCatalogRows(input: BrowserCatalogValidationInput): void {
  if (!Array.isArray(input.browserProfiles) || !Array.isArray(input.projectBrowserDefaults)
    || !Array.isArray(input.sessionBrowserStates) || !Array.isArray(input.browserCleanups)) {
    throw new Error("Wayang store browser catalog fields must be arrays");
  }
  if (input.browserProfiles.length > MAX_BROWSER_PROFILE_ROWS) throw new Error("Wayang browser profile limit exceeded");
  if (input.browserCleanups.length > MAX_BROWSER_CLEANUP_ROWS) throw new Error("Wayang browser cleanup limit exceeded");

  const profileIds = new Set<string>();
  const profileNames = new Set<string>();
  const storageDigests = new Set<string>();
  const profilesById = new Map<string, BrowserProfileRow>();
  let trashRows = 0;
  for (const [index, candidate] of input.browserProfiles.entries()) {
    const value = candidate as Partial<BrowserProfileRow> | null;
    if (!value || typeof value !== "object"
      || !exactKeys(value, ["id", "name", "storage_source", "storage_identity_digest", "state", "revision", "created_at", "updated_at"])
      || typeof value.id !== "string" || !UUID_PATTERN.test(value.id)
      || !validBrowserProfileName(value.name) || !validStorageSource(value.storage_source)
      || typeof value.storage_identity_digest !== "string" || !SHA256_PATTERN.test(value.storage_identity_digest)
      || value.storage_identity_digest !== browserProfileStorageIdentityDigest(input.dataDir, value.storage_source)
      || !["active", "disabled", "trash_pending", "trashed", "purge_pending"].includes(value.state ?? "")
      || !positiveRevision(value.revision) || !timestamp(value.created_at) || !timestamp(value.updated_at)
      || value.updated_at! < value.created_at!) {
      throw new Error(`Wayang store contains a malformed browser profile at index ${index}`);
    }
    const normalizedName = value.name.toLocaleLowerCase("en-US");
    if (profileIds.has(value.id) || profileNames.has(normalizedName) || storageDigests.has(value.storage_identity_digest)) {
      throw new Error("Wayang store contains duplicate browser profile identity");
    }
    profileIds.add(value.id);
    profileNames.add(normalizedName);
    storageDigests.add(value.storage_identity_digest);
    const row = value as BrowserProfileRow;
    profilesById.set(row.id, row);
    if (["trash_pending", "trashed", "purge_pending"].includes(row.state)) trashRows += 1;
  }
  if (trashRows > MAX_BROWSER_PROFILE_TRASH_ROWS) throw new Error("Wayang browser profile trash limit exceeded");

  const defaultProjects = new Set<string>();
  for (const [index, candidate] of input.projectBrowserDefaults.entries()) {
    const value = candidate as Partial<ProjectBrowserDefaultRow> | null;
    if (!value || typeof value !== "object"
      || !exactKeys(value, ["project_id", "profile_id", "revision", "updated_at", "updated_by"])
      || !stableId(value.project_id) || !input.projectIds.has(value.project_id)
      || !(value.profile_id === null || (stableId(value.profile_id) && profileIds.has(value.profile_id)))
      || !positiveRevision(value.revision) || !timestamp(value.updated_at)
      || !["owner", "agent"].includes(value.updated_by ?? "")) {
      throw new Error(`Wayang store contains a malformed project browser default at index ${index}`);
    }
    if (defaultProjects.has(value.project_id)) throw new Error("Wayang store contains duplicate project browser defaults");
    defaultProjects.add(value.project_id);
  }

  const cleanupSessionIds = new Set<string>();
  const cleanupIds = new Set<string>();
  for (const [index, candidate] of input.browserCleanups.entries()) {
    const value = candidate as Partial<BrowserCleanupRow> | null;
    if (!value || typeof value !== "object"
      || !exactKeys(value, ["id", "subject_kind", "profile_id", "source_session_id", "workspace_generation", "storage_identity_digest", "immutable_download_owner_ids", "recovery_entry_id", "state", "attempts", "last_attempt_at", "created_at", "updated_at"])
      || typeof value.id !== "string" || !UUID_PATTERN.test(value.id)
      || !["session_workspace", "profile", "host"].includes(value.subject_kind ?? "")
      || !stableId(value.profile_id) || !profilesById.has(value.profile_id)
      || !(value.source_session_id === null || stableId(value.source_session_id))
      || !(value.workspace_generation === null || stableId(value.workspace_generation))
      || value.storage_identity_digest !== profilesById.get(value.profile_id)?.storage_identity_digest
      || !Array.isArray(value.immutable_download_owner_ids)
      || value.immutable_download_owner_ids.length > MAX_BROWSER_CLEANUP_DOWNLOAD_OWNERS
      || value.immutable_download_owner_ids.some((id) => !stableId(id))
      || new Set(value.immutable_download_owner_ids).size !== value.immutable_download_owner_ids.length
      || !(value.recovery_entry_id === null || stableId(value.recovery_entry_id))
      || !["pending", "verified", "cleanup_failed"].includes(value.state ?? "")
      || !Number.isSafeInteger(value.attempts) || value.attempts! < 0 || value.attempts! > 10
      || !timestamp(value.last_attempt_at, true) || !timestamp(value.created_at) || !timestamp(value.updated_at)
      || value.updated_at! < value.created_at!
      || (value.subject_kind === "session_workspace"
        ? value.source_session_id === null || value.workspace_generation === null
        : value.source_session_id !== null || value.workspace_generation !== null)) {
      throw new Error(`Wayang store contains a malformed browser cleanup at index ${index}`);
    }
    if (cleanupIds.has(value.id)) throw new Error("Wayang store contains duplicate browser cleanup ids");
    cleanupIds.add(value.id);
    if (value.subject_kind === "session_workspace" && value.source_session_id) cleanupSessionIds.add(value.source_session_id);
  }

  const sessionStates = new Set<string>();
  for (const [index, candidate] of input.sessionBrowserStates.entries()) {
    const value = candidate as Partial<SessionBrowserStateRow> | null;
    if (!value || typeof value !== "object"
      || !exactKeys(value, ["session_id", "active_profile_id", "revision", "updated_at"])
      || !stableId(value.session_id)
      || (!input.sessionIds.has(value.session_id) && !cleanupSessionIds.has(value.session_id))
      || !(value.active_profile_id === null || (stableId(value.active_profile_id) && profileIds.has(value.active_profile_id)))
      || !positiveRevision(value.revision) || !timestamp(value.updated_at)) {
      throw new Error(`Wayang store contains a malformed session browser state at index ${index}`);
    }
    if (sessionStates.has(value.session_id)) throw new Error("Wayang store contains duplicate session browser states");
    sessionStates.add(value.session_id);
  }
}

function metadataDirectoryExists(candidate: string): boolean {
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isDirectory() && !stat.isSymbolicLink()
      && (typeof process.getuid !== "function" || stat.uid === process.getuid());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function uuidFromDigest(digest: string): string {
  const chars = digest.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = (["8", "9", "a", "b"] as const)[Number.parseInt(chars[16] ?? "0", 16) % 4];
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function migratedProfileName(base: string, suffix: string): string {
  const clean = base.normalize("NFC").replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim();
  const candidate = `${clean || "Legacy Standard pair"} · ${suffix}`;
  let output = "";
  for (const scalar of candidate) {
    if (Buffer.byteLength(output + scalar, "utf8") > 120) break;
    output += scalar;
  }
  return output.trim() || `Legacy pair ${suffix}`;
}

export interface BrowserProfileMigrationInput {
  dataDir: string;
  associations: readonly WorkspaceCapabilityAssociationRow[];
  projects: readonly { id: string; name: string }[];
  agentProfiles: readonly { id: string; name: string }[];
  now: number;
}

/** Metadata-only inventory. It lstat()s expected roots but never opens profile files. */
export function inventoryBrowserProfilesForSchemaFour(input: BrowserProfileMigrationInput): BrowserProfileRow[] {
  const rows: BrowserProfileRow[] = [];
  const add = (name: string, source: BrowserProfileStorageSource) => {
    const root = browserProfileStorageRoot(input.dataDir, source);
    if (!metadataDirectoryExists(root)) return;
    const digest = browserProfileStorageIdentityDigest(input.dataDir, source);
    rows.push({
      id: uuidFromDigest(createHash("sha256").update(`wayang-browser-profile-v1\0${digest}`, "utf8").digest("hex")),
      name,
      storage_source: source,
      storage_identity_digest: digest,
      state: "active",
      revision: 1,
      created_at: input.now,
      updated_at: input.now,
    });
  };
  add("Legacy shared", { kind: "legacy_shared" });
  const projects = new Map(input.projects.map((row) => [row.id, row]));
  const profiles = new Map(input.agentProfiles.map((row) => [row.id, row]));
  const seen = new Set<string>();
  for (const association of input.associations) {
    if (association.capability_id !== "wayang.standard-browser.v1") continue;
    const key = `${association.project_id}\u0000${association.agent_profile_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const suffix = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8);
    const project = projects.get(association.project_id)?.name ?? "Deleted project";
    const profile = profiles.get(association.agent_profile_id)?.name ?? "Deleted agent";
    add(migratedProfileName(`${project} / ${profile}`, suffix), {
      kind: "standard_pair_v1",
      project_id: association.project_id,
      agent_profile_id: association.agent_profile_id,
    });
  }
  return rows;
}
