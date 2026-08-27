import { randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { commandGuardIdentityPinPath } from "./command-guard-pin.js";
import { getConfig } from "./config.js";
import { getStore } from "./db.js";
import {
  MAX_WORKSPACE_CAPABILITY_APPROVAL_EVENTS,
  WORKSPACE_CAPABILITY_REGISTRY,
  commitWorkspaceCapabilityActivation,
  findWorkspaceCapabilityAssociation,
  revokeWorkspaceCapabilityAssociation,
} from "./workspace-capabilities.js";
import {
  capabilityPairRuntimeSessionIds,
  previewRuntimeMutationImpact,
} from "./runtime-impact.js";
import { WorkspaceStoreError, type WorkspaceCapabilityApprovalEventRow, type WorkspaceCapabilityAssociationRow } from "./workspace-types.js";
import {
  MAX_AFFECTED_RUNTIMES,
  capabilityOperationDigest,
  capabilityPreviewStateDigest,
} from "./workspace-capability-approval/renderer.js";
import { WorkspaceCapabilityApprovalService } from "./workspace-capability-approval/service.js";
import type {
  AffectedRuntimePreview,
  CapabilityActivationIntent,
  CapabilityActivationPreview,
  CapabilityApprovalEventRecord,
  CapabilityAssociationRecord,
  CapabilityRevokeIntent,
  CapabilityRuntimeCleanupPort,
  CapabilityStatusProjection,
  CommitActivationResult,
  DenyAssociationResult,
  PreviewActivationResult,
  ReservePinAttemptResult,
  SettingsPinAttemptPort,
  VerifyPinAttemptResult,
  WorkspaceCapabilityMutationPort,
} from "./workspace-capability-approval/types.js";

const PIN_ATTEMPT_STATE_VERSION = 1;
const COOLDOWN_MS = 30_000;
const MAX_PIN_BYTES = 1_024;

interface DurablePinAttemptState {
  version: typeof PIN_ATTEMPT_STATE_VERSION;
  attemptCount: number;
  lastAttemptAtMs: number;
  reservation: null | {
    realm: string;
    reservationId: string;
    requestId: string;
    operationDigest: string;
    expiresAt: number;
  };
}

export interface WorkspaceCapabilityRuntimeDenialPort {
  /** Must synchronously invalidate generations, tools, queues, sockets, and control handles. */
  latchDenied(input: {
    association: CapabilityAssociationRecord;
    runtimeIds: readonly string[];
  }): void;
  /** Best-effort process/browser/download teardown after durable denial. */
  cleanupDeniedRuntimeIds(runtimeIds: readonly string[]): Promise<void>;
}

/**
 * Temporary lifecycle seam for the runtime-owner branch. Activation is a
 * widening-only generation latch and must not reuse denial behavior.
 */
export interface WorkspaceCapabilityRuntimeLifecyclePort extends WorkspaceCapabilityRuntimeDenialPort {
  /** Synchronously refresh-fences every exact affected runtime before persistence. */
  latchActivation(input: {
    intent: CapabilityActivationIntent;
    runtimeIds: readonly string[];
  }): void;
}

function associationRecord(row: WorkspaceCapabilityAssociationRow): CapabilityAssociationRecord {
  return {
    capabilityId: row.capability_id,
    projectId: row.project_id,
    agentProfileId: row.agent_profile_id,
    revision: row.revision,
    active: row.active,
    approvedAt: row.approved_at,
    revokedAt: row.revoked_at,
    updatedAt: row.updated_at,
  };
}

function approvalEventRecord(row: WorkspaceCapabilityApprovalEventRow): CapabilityApprovalEventRecord {
  return {
    id: row.id,
    capabilityId: row.capability_id,
    projectId: row.project_id,
    agentProfileId: row.agent_profile_id,
    associationRevision: row.association_revision,
    operationDigest: row.operation_digest,
    approvedAt: row.approved_at,
    revokedAt: row.revoked_at,
  };
}

function nextAssociationRevision(current: WorkspaceCapabilityAssociationRow | undefined): number {
  if (!current) return 1;
  if (!Number.isSafeInteger(current.revision) || current.revision < 1 || current.revision >= Number.MAX_SAFE_INTEGER - 1) {
    throw new WorkspaceStoreError("Capability association revision is exhausted", 409);
  }
  return current.revision + 1;
}

function runtimePreview(runtimeIds: readonly string[]): AffectedRuntimePreview[] {
  return previewRuntimeMutationImpact(runtimeIds).map((state) => ({
    runtimeId: state.session_id,
    status: state.streaming ? "streaming"
      : state.queued ? "queued"
        : state.runtime_status === "starting" ? "starting"
          : state.mutation_locked ? "mutation_locked"
            : "idle",
  }));
}

function sameIntent(left: CapabilityActivationIntent, right: CapabilityActivationIntent): boolean {
  return left.capabilityId === right.capabilityId
    && left.projectId === right.projectId
    && left.agentProfileId === right.agentProfileId;
}

function sameAuthorityPreview(left: CapabilityActivationPreview, right: CapabilityActivationPreview): boolean {
  return sameIntent(left.intent, right.intent)
    && left.previewStateDigest === right.previewStateDigest
    && left.associationBefore?.active === right.associationBefore?.active
    && left.associationBefore?.revision === right.associationBefore?.revision
    && left.associationAfter.active === right.associationAfter.active
    && left.associationAfter.revision === right.associationAfter.revision;
}

/** @internal Synthetic seam for bounded runtime-status preview regressions. */
export function buildWorkspaceCapabilityActivationPreview(
  intent: CapabilityActivationIntent,
  affectedRuntimes?: readonly AffectedRuntimePreview[],
): PreviewActivationResult {
  const store = getStore();
  const capability = WORKSPACE_CAPABILITY_REGISTRY[intent.capabilityId];
  const project = store.projects.find((candidate) => candidate.id === intent.projectId);
  const profile = store.agentProfiles.find((candidate) => candidate.id === intent.agentProfileId);
  if (!capability || !project || !profile) return { status: "denied", reason: "subject_not_found" };
  if (project.access_policy.privacy_mode !== capability.privacy_mode) return { status: "denied", reason: "incompatible_privacy_mode" };
  if (!profile.enabled) return { status: "denied", reason: "profile_disabled" };
  const allowed = project.access_policy.allowed_agent_profile_ids;
  const profileAllowed = allowed === null || allowed.includes(profile.id);
  if (!profileAllowed) return { status: "denied", reason: "profile_not_allowed" };
  const association = findWorkspaceCapabilityAssociation(store, {
    capability_id: intent.capabilityId,
    project_id: project.id,
    agent_profile_id: profile.id,
  });
  if (association?.active) return { status: "denied", reason: "already_activated" };
  // Saturation is checked only for a new activation, before request/reservation
  // allocation and PIN cooldown consumption. It never participates in denial.
  if (store.workspaceCapabilityApprovalEvents.length >= MAX_WORKSPACE_CAPABILITY_APPROVAL_EVENTS) {
    return { status: "denied", reason: "activation_history_full" };
  }

  const runtimes = affectedRuntimes ?? runtimePreview(capabilityPairRuntimeSessionIds(project.id, profile.id));
  if (runtimes.length > MAX_AFFECTED_RUNTIMES) {
    return { status: "runtime_limit", limit: MAX_AFFECTED_RUNTIMES };
  }
  const preview: CapabilityActivationPreview = {
    intent: { ...intent },
    projectLabel: project.name,
    projectCwd: project.cwd,
    privacyMode: project.access_policy.privacy_mode,
    profileAllowed,
    agentProfileLabel: profile.name,
    profileEnabled: profile.enabled,
    associationBefore: association ? { active: association.active, revision: association.revision } : null,
    associationAfter: { active: true, revision: nextAssociationRevision(association) },
    previewStateDigest: "",
    affectedRuntimes: runtimes.map((runtime) => ({ ...runtime })),
  };
  preview.previewStateDigest = capabilityPreviewStateDigest(preview);
  return { status: "ok", preview };
}

/** Exact approval-subsystem adapter; ordinary workspace services never receive activation authority. */
export class WorkspaceCapabilityIntegration implements WorkspaceCapabilityMutationPort, CapabilityRuntimeCleanupPort {
  constructor(private readonly lifecycle: WorkspaceCapabilityRuntimeLifecyclePort) {}

  async previewActivation(intent: CapabilityActivationIntent): Promise<PreviewActivationResult> {
    return buildWorkspaceCapabilityActivationPreview(intent);
  }

  async commitActivation(input: Parameters<WorkspaceCapabilityMutationPort["commitActivation"]>[0]): Promise<CommitActivationResult> {
    let expectedDigest: string;
    try { expectedDigest = capabilityOperationDigest(input.preview, input.approvalBinding); }
    catch { return { status: "denied", reason: "invalid_approval_preview" }; }
    if (input.approvalDigest !== expectedDigest) return { status: "denied", reason: "invalid_approval_digest" };
    if (input.approvedAt > input.approvalBinding.expiresAt) return { status: "conflict" };

    try {
      // Runtime list and status are owner information, not association
      // authority. Revalidate only the exact digest-bound project/profile/
      // privacy/allowlist/association state reviewed by the owner.
      const current = buildWorkspaceCapabilityActivationPreview(input.preview.intent, []);
      if (current.status === "denied" && current.reason === "activation_history_full") {
        return { status: "history_full" };
      }
      if (current.status !== "ok" || !sameAuthorityPreview(input.preview, current.preview)) {
        return { status: "conflict" };
      }

      const runtimeIds = capabilityPairRuntimeSessionIds(
        input.preview.intent.projectId,
        input.preview.intent.agentProfileId,
      );
      // This latch and the durable mutation are deliberately adjacent. No await
      // may appear between them: construction that began before activation must
      // be refresh-fenced before the store can expose the widening association.
      this.lifecycle.latchActivation({ intent: { ...input.preview.intent }, runtimeIds });
      const association = commitWorkspaceCapabilityActivation({
        capability_id: input.preview.intent.capabilityId,
        project_id: input.preview.intent.projectId,
        agent_profile_id: input.preview.intent.agentProfileId,
        operation_digest: input.approvalDigest,
        approved_at: input.approvedAt,
      });
      const approvalEvent = [...getStore().workspaceCapabilityApprovalEvents].reverse().find((row) =>
        row.operation_digest === input.approvalDigest
        && row.capability_id === association.capability_id
        && row.project_id === association.project_id
        && row.agent_profile_id === association.agent_profile_id
        && row.association_revision === association.revision);
      if (!approvalEvent) throw new Error("Committed capability approval event is unavailable");
      return {
        status: "committed",
        result: { association: associationRecord(association), approvalEvent: approvalEventRecord(approvalEvent) },
        idleRuntimeIds: [],
      };
    } catch (error) {
      if (error instanceof WorkspaceStoreError && error.statusCode === 409 && /history is full/u.test(error.message)) {
        return { status: "history_full" };
      }
      if (error instanceof WorkspaceStoreError && (error.statusCode === 403 || error.statusCode === 404)) {
        return { status: "denied", reason: "workspace_denied" };
      }
      if (error instanceof WorkspaceStoreError && error.statusCode === 409) return { status: "conflict" };
      throw error;
    }
  }

  async denyAssociationFirst(intent: CapabilityRevokeIntent, revokedAt: number): Promise<DenyAssociationResult> {
    const store = getStore();
    const existing = findWorkspaceCapabilityAssociation(store, {
      capability_id: intent.capabilityId,
      project_id: intent.projectId,
      agent_profile_id: intent.agentProfileId,
    });
    if (!existing) return { status: "not_found" };
    const runtimeIds = capabilityPairRuntimeSessionIds(intent.projectId, intent.agentProfileId);
    try {
      const result = revokeWorkspaceCapabilityAssociation({
        capability_id: intent.capabilityId,
        project_id: intent.projectId,
        agent_profile_id: intent.agentProfileId,
        expected_revision: intent.expectedRevision,
        revoked_at: revokedAt,
      });
      const association = associationRecord(result.association);
      // Durable denial is already published. No await may precede this latch;
      // an idempotent retry also relatches in case the first process failed
      // after publishing the tombstone but before completing live denial.
      this.lifecycle.latchDenied({ association, runtimeIds });
      if (result.status === "already_revoked") return { status: "already_revoked", association, cleanupRuntimeIds: runtimeIds };
      return { status: "revoked", association, cleanupRuntimeIds: runtimeIds };
    } catch (error) {
      if (error instanceof WorkspaceStoreError && error.statusCode === 404) return { status: "not_found" };
      if (error instanceof WorkspaceStoreError && error.statusCode === 409) return { status: "conflict" };
      throw error;
    }
  }

  async getCatalogStatus(historyLimit: number): Promise<CapabilityStatusProjection> {
    const store = getStore();
    const events = [...store.workspaceCapabilityApprovalEvents]
      .sort((left, right) => right.approved_at - left.approved_at || left.id.localeCompare(right.id));
    return {
      associations: [...store.workspaceCapabilityAssociations]
        .sort((left, right) => left.project_id.localeCompare(right.project_id)
          || left.agent_profile_id.localeCompare(right.agent_profile_id)
          || left.capability_id.localeCompare(right.capability_id))
        .map(associationRecord),
      approvalEvents: events.slice(0, historyLimit).map(approvalEventRecord),
      history: { returned: Math.min(events.length, historyLimit), limit: historyLimit, hasMore: events.length > historyLimit },
    };
  }

  async stopAfterActivation(_runtimeIds: readonly string[]): Promise<void> {
    // Deferred activation refreshes stale handles through the lifecycle latch;
    // it must not stop already-accepted work after commit.
  }

  async cleanupAfterRevocation(runtimeIds: readonly string[]): Promise<void> {
    await this.lifecycle.cleanupDeniedRuntimeIds(runtimeIds);
  }

  latchDenied(input: {
    associations: readonly CapabilityAssociationRecord[];
    runtimeIds: readonly string[];
    reason: "ordinary_workspace_mutation";
  }): void {
    if (input.associations.some((association) => association.active)) {
      throw new Error("Capability invalidation was not durably denied before runtime latching");
    }
    for (const association of input.associations) {
      this.lifecycle.latchDenied({ association, runtimeIds: input.runtimeIds });
    }
  }

  async cleanupAfterDenial(input: { runtimeIds: readonly string[] }): Promise<void> {
    await this.lifecycle.cleanupDeniedRuntimeIds(input.runtimeIds);
  }
}

function ownerOnlyPrivateDirectory(directoryPath: string): fs.Stats | null {
  try {
    const resolved = path.resolve(directoryPath);
    const stat = fs.lstatSync(resolved);
    const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700
      || fs.realpathSync.native(resolved) !== resolved) return null;
    return stat;
  } catch { return null; }
}

function ownerOnlyRegularFile(filePath: string): fs.Stats | null {
  try {
    if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath || !ownerOnlyPrivateDirectory(path.dirname(filePath))) return null;
    const stat = fs.lstatSync(filePath);
    const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600) return null;
    return stat;
  } catch { return null; }
}

function readPinAttemptState(filePath: string): DurablePinAttemptState | null {
  const stat = ownerOnlyRegularFile(filePath);
  if (!stat || stat.size < 2 || stat.size > 16 * 1024) return null;
  let fd: number | null = null;
  try {
    const noFollow = fs.constants.O_NOFOLLOW;
    if (typeof noFollow !== "number") return null;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) return null;
    const value = JSON.parse(fs.readFileSync(fd, "utf8")) as Partial<DurablePinAttemptState>;
    const reservationKeys = value.reservation && typeof value.reservation === "object"
      ? Object.keys(value.reservation).sort().join(",") : "";
    if (Object.keys(value).sort().join(",") !== "attemptCount,lastAttemptAtMs,reservation,version"
      || value.version !== PIN_ATTEMPT_STATE_VERSION || !Number.isSafeInteger(value.attemptCount) || (value.attemptCount ?? -1) < 0
      || !Number.isSafeInteger(value.lastAttemptAtMs) || (value.lastAttemptAtMs ?? -1) < 0
      || !(value.reservation === null || (value.reservation && reservationKeys === "expiresAt,operationDigest,realm,requestId,reservationId"
        && typeof value.reservation.realm === "string" && value.reservation.realm.length > 0 && value.reservation.realm.length <= 256
        && typeof value.reservation.reservationId === "string" && value.reservation.reservationId.length > 0 && value.reservation.reservationId.length <= 256
        && typeof value.reservation.requestId === "string" && value.reservation.requestId.length > 0 && value.reservation.requestId.length <= 256
        && typeof value.reservation.operationDigest === "string" && /^[a-f0-9]{64}$/u.test(value.reservation.operationDigest)
        && Number.isSafeInteger(value.reservation.expiresAt) && value.reservation.expiresAt > 0))) return null;
    return value as DurablePinAttemptState;
  } catch { return null; }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* best effort */ } }
}

export function syncDirectoryBestEffort(directoryPath: string, syncDescriptor = fs.fsyncSync): void {
  let descriptor: number | null = null;
  try {
    const noFollow = fs.constants.O_NOFOLLOW;
    if (typeof noFollow !== "number") return;
    descriptor = fs.openSync(directoryPath,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | noFollow);
    try { syncDescriptor(descriptor); } catch { /* unsupported directory sync is best effort */ }
  } catch { /* opening a directory for sync is not portable */ }
  finally { if (descriptor !== null) try { fs.closeSync(descriptor); } catch { /* best effort */ } }
}

function writePinAttemptState(filePath: string, state: DurablePinAttemptState): boolean {
  const parent = path.dirname(filePath);
  if (!ownerOnlyPrivateDirectory(parent) || !ownerOnlyRegularFile(filePath)) return false;
  const temp = path.join(parent, `.pin-attempt-${process.pid}-${randomUUID()}.tmp`);
  try {
    const noFollow = fs.constants.O_NOFOLLOW;
    if (typeof noFollow !== "number") return false;
    const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(state)}\n`, "utf8");
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, filePath);
    syncDirectoryBestEffort(parent);
    return readPinAttemptState(filePath) !== null;
  } catch {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    return false;
  }
}

export type PinAttemptStateProvisionResult =
  | { status: "ready"; created: boolean }
  | { status: "unavailable"; reason: "pin_metadata" | "state_parent" | "state_existing" | "state_create" };

/**
 * Initialize only the non-secret durable attempt/cooldown state used by the
 * deployed service. The existing command-guard PIN is checked by metadata
 * only and is never opened here. Valid state is preserved byte-for-byte;
 * unsafe or malformed existing authority is never repaired or replaced.
 */
export function provisionPinAttemptStateForService(filePath: string): PinAttemptStateProvisionResult {
  const resolved = path.resolve(filePath);
  if (!path.isAbsolute(filePath) || resolved !== filePath || !ownerOnlyRegularFile(commandGuardIdentityPinPath())) {
    return { status: "unavailable", reason: "pin_metadata" };
  }
  try {
    const existing = fs.lstatSync(resolved);
    if (existing) return readPinAttemptState(resolved)
      ? { status: "ready", created: false }
      : { status: "unavailable", reason: "state_existing" };
  } catch (error: any) {
    if (error?.code !== "ENOENT") return { status: "unavailable", reason: "state_existing" };
  }

  const parent = path.dirname(resolved);
  const dataRoot = path.dirname(parent);
  if (!ownerOnlyPrivateDirectory(dataRoot)) return { status: "unavailable", reason: "state_parent" };
  let parentCreated = false;
  try {
    fs.mkdirSync(parent, { mode: 0o700 });
    parentCreated = true;
  } catch (error: any) {
    if (error?.code !== "EEXIST") return { status: "unavailable", reason: "state_parent" };
  }
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") return { status: "unavailable", reason: "state_create" };
  if (parentCreated) syncDirectoryBestEffort(dataRoot);
  const parentBefore = ownerOnlyPrivateDirectory(parent);
  if (!parentBefore) return { status: "unavailable", reason: "state_parent" };

  const initial: DurablePinAttemptState = {
    version: PIN_ATTEMPT_STATE_VERSION,
    attemptCount: 0,
    lastAttemptAtMs: 0,
    reservation: null,
  };
  const temp = path.join(parent, `.pin-attempt-bootstrap-${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(initial)}\n`, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    // Revalidate the canonical parent immediately before pathname-based
    // publication. Node has no openat/linkat surface, so this is the strongest
    // portable fail-closed check within Wayang's cooperative same-UID model.
    const parentAtPublish = ownerOnlyPrivateDirectory(parent);
    if (!parentAtPublish || parentAtPublish.dev !== parentBefore.dev || parentAtPublish.ino !== parentBefore.ino) {
      return { status: "unavailable", reason: "state_parent" };
    }
    // Same-directory hard-link publication is no-overwrite: a concurrent
    // service can win, but neither process may replace live cooldown state.
    fs.linkSync(temp, resolved);
    // Drop the temporary hard link before validating the canonical file's
    // required single-link invariant.
    fs.unlinkSync(temp);
    syncDirectoryBestEffort(parent);
    const parentAfter = ownerOnlyPrivateDirectory(parent);
    if (!parentAfter || parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino) {
      return { status: "unavailable", reason: "state_parent" };
    }
    return readPinAttemptState(resolved)
      ? { status: "ready", created: true }
      : { status: "unavailable", reason: "state_create" };
  } catch (error: any) {
    if (error?.code === "EEXIST" && readPinAttemptState(resolved)) {
      return { status: "ready", created: false };
    }
    return { status: "unavailable", reason: "state_create" };
  } finally {
    if (descriptor !== null) try { fs.closeSync(descriptor); } catch { /* best effort */ }
    try { fs.unlinkSync(temp); } catch { /* absent or already cleaned */ }
  }
}

function verifyIdentityPinOpaque(candidate: string): "verified" | "wrong_pin" | "unavailable" {
  const filePath = commandGuardIdentityPinPath();
  const stat = ownerOnlyRegularFile(filePath);
  if (!stat || stat.size < 1 || stat.size > MAX_PIN_BYTES) return "unavailable";
  let fd: number | null = null;
  try {
    const noFollow = fs.constants.O_NOFOLLOW;
    if (typeof noFollow !== "number") return "unavailable";
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) return "unavailable";
    const configuredText = fs.readFileSync(fd, "utf8").trim();
    if (!/^\d{8}$/u.test(configuredText)) return "unavailable";
    const validCandidate = typeof candidate === "string" && /^\d{8}$/u.test(candidate);
    const configured = Buffer.from(configuredText, "utf8");
    const submitted = Buffer.from(validCandidate ? candidate : "00000000", "utf8");
    const matches = timingSafeEqual(configured, submitted);
    configured.fill(0);
    submitted.fill(0);
    return validCandidate && matches ? "verified" : "wrong_pin";
  } catch { return "unavailable"; }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* best effort */ } }
}

export class HardenedSettingsPinAttemptAdapter implements SettingsPinAttemptPort {
  private readonly statePath: string;

  constructor(
    statePath = path.join(getConfig().dataDir, "workspace-capability-approval", "pin-attempt-state.json"),
    private readonly initializationReady = true,
  ) {
    this.statePath = path.resolve(statePath);
  }

  async reserve(input: {
    realm: string;
    reservationId: string;
    requestId: string;
    operationDigest: string;
    expiresAt: number;
  }): Promise<ReservePinAttemptResult> {
    if (!this.initializationReady) return { status: "unavailable" };
    if (typeof input.realm !== "string" || input.realm.length < 1 || input.realm.length > 256
      || typeof input.reservationId !== "string" || input.reservationId.length < 1 || input.reservationId.length > 256
      || typeof input.requestId !== "string" || input.requestId.length < 1 || input.requestId.length > 256
      || !/^[a-f0-9]{64}$/u.test(input.operationDigest)
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1) return { status: "unavailable" };
    if (!ownerOnlyRegularFile(commandGuardIdentityPinPath())) return { status: "unavailable" };
    const state = readPinAttemptState(this.statePath);
    if (!state) return { status: "unavailable" };
    const now = Date.now();
    const retryAt = state.lastAttemptAtMs + COOLDOWN_MS;
    if (state.lastAttemptAtMs > now || retryAt > now) return { status: "cooldown", retryAt };
    if (state.reservation && state.reservation.expiresAt > now) return { status: "busy" };
    if (state.attemptCount >= Number.MAX_SAFE_INTEGER) return { status: "unavailable" };
    state.reservation = { ...input };
    state.attemptCount += 1;
    state.lastAttemptAtMs = now;
    if (!writePinAttemptState(this.statePath, state)) return { status: "unavailable" };
    return { status: "reserved" };
  }

  async verifyAndConsume(input: { realm: string; reservationId: string; requestId: string; pin: string; now: number }): Promise<VerifyPinAttemptResult> {
    if (!this.initializationReady) return { status: "unavailable" };
    const state = readPinAttemptState(this.statePath);
    const reservation = state?.reservation;
    if (!state || !reservation || reservation.realm !== input.realm || reservation.reservationId !== input.reservationId || reservation.requestId !== input.requestId) {
      return { status: "unavailable" };
    }
    const expired = reservation.expiresAt <= input.now;
    const result = expired ? "expired" : verifyIdentityPinOpaque(input.pin);
    state.reservation = null;
    if (!writePinAttemptState(this.statePath, state)) return { status: "unavailable" };
    return result === "verified" ? { status: "verified" }
      : result === "wrong_pin" ? { status: "wrong_pin" }
        : result === "expired" ? { status: "expired" }
          : { status: "unavailable" };
  }

  async cancelAndConsume(input: {
    realm: string;
    reservationId: string;
    requestId: string;
    reason: "cancelled" | "authentication_lost" | "expired" | "conflict" | "backend_failure";
    now: number;
  }): Promise<void> {
    if (!this.initializationReady) throw new Error("Settings PIN attempt state is unavailable");
    const state = readPinAttemptState(this.statePath);
    const reservation = state?.reservation;
    if (!state || !reservation || reservation.realm !== input.realm || reservation.reservationId !== input.reservationId || reservation.requestId !== input.requestId) {
      throw new Error("Settings PIN attempt state is unavailable");
    }
    state.reservation = null;
    if (!writePinAttemptState(this.statePath, state)) throw new Error("Settings PIN attempt state is unavailable");
  }
}

export function createWorkspaceCapabilityApprovalIntegration(options: {
  lifecycle: WorkspaceCapabilityRuntimeLifecyclePort;
  pinAttemptStatePath?: string;
  pinAttemptReady?: boolean;
}): {
  integration: WorkspaceCapabilityIntegration;
  service: WorkspaceCapabilityApprovalService;
  pinAttempts: HardenedSettingsPinAttemptAdapter;
} {
  const integration = new WorkspaceCapabilityIntegration(options.lifecycle);
  const pinAttempts = new HardenedSettingsPinAttemptAdapter(options.pinAttemptStatePath, options.pinAttemptReady ?? true);
  const service = new WorkspaceCapabilityApprovalService({ workspace: integration, pinAttempts, cleanup: integration });
  return { integration, service, pinAttempts };
}
