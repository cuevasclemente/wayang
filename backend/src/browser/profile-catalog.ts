import { randomUUID } from "node:crypto";
import { getConfig } from "../config.js";
import { commitStoreMutation, getStore, type StoreData } from "../db.js";
import { WorkspaceStoreError } from "../workspace-types.js";
import {
  MAX_BROWSER_PROFILE_ROWS,
  MAX_BROWSER_PROFILE_TRASH_ROWS,
  browserProfileStorageIdentityDigest,
  validBrowserProfileName,
  type BrowserCleanupRow,
  type BrowserProfileRow,
  type BrowserProfileState,
  type ProjectBrowserDefaultRow,
  type SessionBrowserStateRow,
} from "./profile-catalog-store.js";

export interface PublicBrowserProfile {
  id: string;
  name: string;
  state: BrowserProfileState;
  storage_source: BrowserProfileRow["storage_source"]["kind"];
  revision: number;
  created_at: number;
  updated_at: number;
}

function publicProfile(row: BrowserProfileRow): PublicBrowserProfile {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    storage_source: row.storage_source.kind,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function exactProfile(draft: StoreData, profileId: string): BrowserProfileRow {
  const profile = draft.browserProfiles.find((row) => row.id === profileId);
  if (!profile) throw new WorkspaceStoreError("Browser Profile not found", 404);
  return profile;
}

function assertExpectedRevision(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected <= 0 || actual !== expected) {
    throw new WorkspaceStoreError("Browser Profile state changed; refresh and retry", 409);
  }
}

function assertUniqueName(draft: StoreData, name: string, exceptId?: string): void {
  const folded = name.toLocaleLowerCase("en-US");
  if (draft.browserProfiles.some((row) => row.id !== exceptId && row.name.toLocaleLowerCase("en-US") === folded)) {
    throw new WorkspaceStoreError("Browser Profile name already exists", 409);
  }
}

function assertAssignable(profile: BrowserProfileRow): void {
  if (profile.state !== "active") throw new WorkspaceStoreError("Browser Profile is not active", 409);
}

export function listBrowserProfiles(): PublicBrowserProfile[] {
  return getStore().browserProfiles
    .map(publicProfile)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function getBrowserProfile(profileId: string): PublicBrowserProfile | null {
  const row = getStore().browserProfiles.find((candidate) => candidate.id === profileId);
  return row ? publicProfile(row) : null;
}

export function createManagedBrowserProfile(name: string, now = Date.now()): PublicBrowserProfile {
  if (!validBrowserProfileName(name)) throw new WorkspaceStoreError("Browser Profile name is invalid", 400);
  return commitStoreMutation((draft) => {
    if (draft.browserProfiles.length >= MAX_BROWSER_PROFILE_ROWS) throw new WorkspaceStoreError("Browser Profile limit reached", 409);
    assertUniqueName(draft, name);
    const source = { kind: "managed" as const, storage_key: randomUUID().replaceAll("-", "") };
    const row: BrowserProfileRow = {
      id: randomUUID(),
      name,
      storage_source: source,
      storage_identity_digest: browserProfileStorageIdentityDigest(getConfig().dataDir, source),
      state: "active",
      revision: 1,
      created_at: now,
      updated_at: now,
    };
    draft.browserProfiles.push(row);
    return publicProfile(row);
  });
}

export function renameBrowserProfile(profileId: string, expectedRevision: number, name: string, now = Date.now()): PublicBrowserProfile {
  if (!validBrowserProfileName(name)) throw new WorkspaceStoreError("Browser Profile name is invalid", 400);
  return commitStoreMutation((draft) => {
    const row = exactProfile(draft, profileId);
    assertExpectedRevision(row.revision, expectedRevision);
    if (["trash_pending", "trashed", "purge_pending"].includes(row.state)) {
      throw new WorkspaceStoreError("Browser Profile cannot be renamed in trash", 409);
    }
    assertUniqueName(draft, name, row.id);
    row.name = name;
    row.revision += 1;
    row.updated_at = now;
    return publicProfile(row);
  });
}

export function setBrowserProfileEnabled(
  profileId: string,
  expectedRevision: number,
  enabled: boolean,
  now = Date.now(),
): PublicBrowserProfile {
  return commitStoreMutation((draft) => {
    const row = exactProfile(draft, profileId);
    assertExpectedRevision(row.revision, expectedRevision);
    if (!["active", "disabled"].includes(row.state)) throw new WorkspaceStoreError("Browser Profile is in cleanup", 409);
    row.state = enabled ? "active" : "disabled";
    row.revision += 1;
    row.updated_at = now;
    return publicProfile(row);
  });
}

export function getProjectBrowserDefault(projectId: string): ProjectBrowserDefaultRow | null {
  const row = getStore().projectBrowserDefaults.find((candidate) => candidate.project_id === projectId);
  return row ? structuredClone(row) : null;
}

export function setProjectBrowserDefault(input: {
  projectId: string;
  profileId: string | null;
  expectedRevision: number | null;
  updatedBy: "owner" | "agent";
  now?: number;
}): ProjectBrowserDefaultRow {
  return commitStoreMutation((draft) => {
    if (!draft.projects.some((row) => row.id === input.projectId)) throw new WorkspaceStoreError("Project not found", 404);
    if (input.profileId !== null) assertAssignable(exactProfile(draft, input.profileId));
    const existing = draft.projectBrowserDefaults.find((row) => row.project_id === input.projectId);
    if (existing) {
      if (input.expectedRevision === null || input.expectedRevision !== existing.revision) {
        throw new WorkspaceStoreError("Project Browser default changed; refresh and retry", 409);
      }
      existing.profile_id = input.profileId;
      existing.revision += 1;
      existing.updated_at = input.now ?? Date.now();
      existing.updated_by = input.updatedBy;
      return structuredClone(existing);
    }
    if (input.expectedRevision !== null) throw new WorkspaceStoreError("Project Browser default changed; refresh and retry", 409);
    const row: ProjectBrowserDefaultRow = {
      project_id: input.projectId,
      profile_id: input.profileId,
      revision: 1,
      updated_at: input.now ?? Date.now(),
      updated_by: input.updatedBy,
    };
    draft.projectBrowserDefaults.push(row);
    return structuredClone(row);
  });
}

export function getSessionBrowserState(sessionId: string): SessionBrowserStateRow | null {
  const row = getStore().sessionBrowserStates.find((candidate) => candidate.session_id === sessionId);
  return row ? structuredClone(row) : null;
}

export function materializeSessionBrowserState(sessionId: string, now = Date.now()): SessionBrowserStateRow {
  return commitStoreMutation((draft) => {
    const existing = draft.sessionBrowserStates.find((row) => row.session_id === sessionId);
    if (existing) return structuredClone(existing);
    const session = draft.sessions.find((row) => row.id === sessionId);
    if (!session) throw new WorkspaceStoreError("Session not found", 404);
    const project = draft.projects.find((row) => row.cwd === session.cwd);
    const projectDefault = project
      ? draft.projectBrowserDefaults.find((row) => row.project_id === project.id)?.profile_id ?? null
      : null;
    if (projectDefault !== null) assertAssignable(exactProfile(draft, projectDefault));
    const row: SessionBrowserStateRow = {
      session_id: sessionId,
      active_profile_id: projectDefault,
      revision: 1,
      updated_at: now,
    };
    draft.sessionBrowserStates.push(row);
    return structuredClone(row);
  });
}

export function setSessionBrowserProfile(input: {
  sessionId: string;
  profileId: string | null;
  expectedRevision: number;
  now?: number;
}): SessionBrowserStateRow {
  return commitStoreMutation((draft) => {
    if (input.profileId !== null) assertAssignable(exactProfile(draft, input.profileId));
    const row = draft.sessionBrowserStates.find((candidate) => candidate.session_id === input.sessionId);
    if (!row) throw new WorkspaceStoreError("Session Browser state is not initialized", 409);
    assertExpectedRevision(row.revision, input.expectedRevision);
    row.active_profile_id = input.profileId;
    row.revision += 1;
    row.updated_at = input.now ?? Date.now();
    return structuredClone(row);
  });
}

function hasProfileReferences(draft: StoreData, profileId: string): boolean {
  return draft.projectBrowserDefaults.some((row) => row.profile_id === profileId)
    || draft.sessionBrowserStates.some((row) => row.active_profile_id === profileId);
}

export function requestBrowserProfileTrash(profileId: string, expectedRevision: number, now = Date.now()): {
  profile: PublicBrowserProfile;
  cleanup: BrowserCleanupRow;
} {
  return commitStoreMutation((draft) => {
    const row = exactProfile(draft, profileId);
    assertExpectedRevision(row.revision, expectedRevision);
    if (hasProfileReferences(draft, profileId)) throw new WorkspaceStoreError("Browser Profile is still referenced", 409);
    if (!["active", "disabled"].includes(row.state)) throw new WorkspaceStoreError("Browser Profile is already in cleanup", 409);
    const trashCount = draft.browserProfiles.filter((candidate) => ["trash_pending", "trashed", "purge_pending"].includes(candidate.state)).length;
    if (trashCount >= MAX_BROWSER_PROFILE_TRASH_ROWS) throw new WorkspaceStoreError("Browser Profile trash limit reached", 409);
    row.state = "trash_pending";
    row.revision += 1;
    row.updated_at = now;
    const cleanup: BrowserCleanupRow = {
      id: randomUUID(),
      subject_kind: "profile",
      profile_id: row.id,
      source_session_id: null,
      workspace_generation: null,
      storage_identity_digest: row.storage_identity_digest,
      immutable_download_owner_ids: [],
      recovery_entry_id: randomUUID(),
      state: "pending",
      attempts: 0,
      last_attempt_at: null,
      created_at: now,
      updated_at: now,
    };
    draft.browserCleanups.push(cleanup);
    return { profile: publicProfile(row), cleanup: structuredClone(cleanup) };
  });
}

export function claimBrowserProfileCleanupAttempt(profileId: string, cleanupId: string, now = Date.now()): BrowserCleanupRow {
  return commitStoreMutation((draft) => {
    const profile = exactProfile(draft, profileId);
    const cleanup = draft.browserCleanups.find((candidate) => candidate.id === cleanupId && candidate.profile_id === profileId);
    if (profile.state !== "trash_pending" || !cleanup || !["pending", "cleanup_failed"].includes(cleanup.state)
      || cleanup.attempts >= 10 || cleanup.recovery_entry_id === null) {
      throw new WorkspaceStoreError("Browser Profile cleanup attempt is stale", 409);
    }
    cleanup.state = "pending";
    cleanup.attempts += 1;
    cleanup.last_attempt_at = now;
    cleanup.updated_at = now;
    return structuredClone(cleanup);
  });
}

export function markBrowserProfileCleanupFailed(profileId: string, cleanupId: string, now = Date.now()): BrowserCleanupRow {
  return commitStoreMutation((draft) => {
    const profile = exactProfile(draft, profileId);
    const cleanup = draft.browserCleanups.find((candidate) => candidate.id === cleanupId && candidate.profile_id === profileId);
    if (profile.state !== "trash_pending" || !cleanup || cleanup.state !== "pending") {
      throw new WorkspaceStoreError("Browser Profile cleanup failure is stale", 409);
    }
    cleanup.state = "cleanup_failed";
    cleanup.updated_at = now;
    return structuredClone(cleanup);
  });
}

export function markBrowserProfileTrashed(profileId: string, cleanupId: string, now = Date.now()): PublicBrowserProfile {
  return commitStoreMutation((draft) => {
    const row = exactProfile(draft, profileId);
    const cleanup = draft.browserCleanups.find((candidate) => candidate.id === cleanupId && candidate.profile_id === profileId);
    if (row.state !== "trash_pending" || !cleanup || cleanup.state !== "pending" || cleanup.recovery_entry_id === null) {
      throw new WorkspaceStoreError("Browser Profile trash transition is stale", 409);
    }
    cleanup.state = "verified";
    cleanup.last_attempt_at ??= now;
    cleanup.updated_at = now;
    row.state = "trashed";
    row.revision += 1;
    row.updated_at = now;
    return publicProfile(row);
  });
}

export function markBrowserProfileRestored(profileId: string, cleanupId: string, expectedRevision: number, now = Date.now()): PublicBrowserProfile {
  return commitStoreMutation((draft) => {
    const row = exactProfile(draft, profileId);
    assertExpectedRevision(row.revision, expectedRevision);
    const cleanup = draft.browserCleanups.find((candidate) => candidate.id === cleanupId && candidate.profile_id === profileId);
    if (row.state !== "trashed" || !cleanup || cleanup.state !== "verified" || cleanup.recovery_entry_id === null) {
      throw new WorkspaceStoreError("Browser Profile restore transition is stale", 409);
    }
    cleanup.recovery_entry_id = null;
    cleanup.updated_at = now;
    row.state = "disabled";
    row.revision += 1;
    row.updated_at = now;
    return publicProfile(row);
  });
}

export function restoreTrashedBrowserProfile(profileId: string, expectedRevision: number, now = Date.now()): PublicBrowserProfile {
  return commitStoreMutation((draft) => {
    const row = exactProfile(draft, profileId);
    assertExpectedRevision(row.revision, expectedRevision);
    const cleanup = [...draft.browserCleanups].reverse().find((candidate) => candidate.profile_id === profileId
      && candidate.subject_kind === "profile" && candidate.recovery_entry_id !== null);
    if (row.state !== "trashed" || !cleanup || cleanup.state !== "verified") {
      throw new WorkspaceStoreError("Browser Profile is not restorable", 409);
    }
    row.state = "disabled";
    row.revision += 1;
    row.updated_at = now;
    return publicProfile(row);
  });
}
