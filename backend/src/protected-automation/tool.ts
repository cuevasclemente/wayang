import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { WorkspaceStoreError } from "../workspace-types.js";
import { getProtectedAutomationManager } from "./manager.js";
import { getProtectedAutomationScheduler } from "./scheduler.js";
import type { ProtectedAutomationBinding } from "./authority.js";
import { getProtectedAutomationPreparationPort } from "./browser-preparation.js";
import { protectedAutomationAttentionMetadata } from "./attention.js";
import { ProtectedAutomationAuthority } from "./interactive-authority.js";
import {
  captureProtectedAutomationSnapshot,
  discardProtectedAutomationSnapshot,
  finalizeProtectedAutomationSnapshotCapture,
  type ProtectedAutomationSnapshotCaptureResult,
  type ProtectedAutomationSnapshotMetadata,
} from "./snapshots.js";
import {
  createProtectedAutomationJob,
  getProtectedAutomationJob,
  listProtectedAutomationJobs,
  listProtectedAutomationRuns,
  rebindProtectedAutomationJob,
  tombstoneProtectedAutomationJob,
  transitionProtectedAutomationJobLifecycle,
  updateProtectedAutomationJob,
} from "./store.js";
import {
  DEFAULT_PROTECTED_AUTOMATION_JOB_LIST_LIMIT,
  MAX_PROTECTED_AUTOMATION_ARGV_ITEMS,
  MAX_PROTECTED_AUTOMATION_HTTPS_ORIGINS,
  MAX_PROTECTED_AUTOMATION_JOB_LIST_LIMIT,
  MAX_PROTECTED_AUTOMATION_RUNS_PER_JOB,
  MAX_PROTECTED_AUTOMATION_TIMEOUT_MS,
  MIN_PROTECTED_AUTOMATION_TIMEOUT_MS,
  type ProtectedAutomationJobRow,
  type ProtectedAutomationJobUpdateFields,
  type ProtectedAutomationRunRow,
} from "./types.js";

export const PROTECTED_AUTOMATION_TOOL_NAME = "protected_automation";

export interface ProtectedAutomationToolRuntime {
  readonly tool: ToolDefinition;
  readonly authority: ProtectedAutomationAuthority;
  readonly binding: Readonly<ProtectedAutomationBinding>;
  preflight(): { allowed: true } | { allowed: false; reason: string };
  close(): Promise<void>;
}

const JobId = Type.String({ minLength: 1, maxLength: 256 });
const ExpectedRevision = Type.Integer({ minimum: 1 });
const SourceDirectory = Type.String({ minLength: 1, maxLength: 1_024 });
const Entrypoint = Type.String({ minLength: 1, maxLength: 512 });
const JobConfiguration = {
  name: Type.String({ minLength: 1, maxLength: 256 }),
  source_directory: SourceDirectory,
  entrypoint: Entrypoint,
  argv: Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: MAX_PROTECTED_AUTOMATION_ARGV_ITEMS }),
  uses_browser_profile: Type.Boolean(),
  allowed_https_origins: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), { maxItems: MAX_PROTECTED_AUTOMATION_HTTPS_ORIGINS }),
  cron_expr: Type.String({ minLength: 1, maxLength: 256 }),
  timeout_ms: Type.Integer({ minimum: MIN_PROTECTED_AUTOMATION_TIMEOUT_MS, maximum: MAX_PROTECTED_AUTOMATION_TIMEOUT_MS }),
  missed_run_policy: Type.Union([Type.Literal("skip"), Type.Literal("run_once")]),
};

const Parameters = Type.Union([
  Type.Object({ operation: Type.Literal("status") }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("list_jobs"),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PROTECTED_AUTOMATION_JOB_LIST_LIMIT })),
    after_job_id: Type.Optional(JobId),
  }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("get_job"), job_id: JobId }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("capture_job"), ...JobConfiguration }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("update_job"),
    job_id: JobId,
    expected_revision: ExpectedRevision,
    ...JobConfiguration,
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("tombstone_job"),
    job_id: JobId,
    expected_revision: ExpectedRevision,
  }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("rebind_job"), job_id: JobId, expected_revision: ExpectedRevision }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("enable"), job_id: JobId, expected_revision: ExpectedRevision }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("pause"), job_id: JobId, expected_revision: ExpectedRevision }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("run_now"), job_id: JobId, expected_revision: ExpectedRevision }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("prepare_browser_profile"), job_id: JobId, expected_revision: ExpectedRevision }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("cancel"),
    job_id: JobId,
    run_id: JobId,
    expected_revision: ExpectedRevision,
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("list_runs"),
    job_id: JobId,
    limit: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_PROTECTED_AUTOMATION_RUNS_PER_JOB })),
  }, { additionalProperties: false }),
]);

type JobConfigurationValue = {
  name: string;
  source_directory: string;
  entrypoint: string;
  argv: string[];
  uses_browser_profile: boolean;
  allowed_https_origins: string[];
  cron_expr: string;
  timeout_ms: number;
  missed_run_policy: "skip" | "run_once";
};

const CONFIGURATION_KEYS = [
  "name", "source_directory", "entrypoint", "argv", "uses_browser_profile",
  "allowed_https_origins", "cron_expr", "timeout_ms", "missed_run_policy",
] as const;

const OPERATION_KEYS: Readonly<Record<string, { required: readonly string[]; optional?: readonly string[] }>> = Object.freeze({
  status: Object.freeze({ required: Object.freeze(["operation"]) }),
  list_jobs: Object.freeze({ required: Object.freeze(["operation"]), optional: Object.freeze(["limit", "after_job_id"]) }),
  get_job: Object.freeze({ required: Object.freeze(["operation", "job_id"]) }),
  capture_job: Object.freeze({ required: Object.freeze(["operation", ...CONFIGURATION_KEYS]) }),
  update_job: Object.freeze({ required: Object.freeze(["operation", "job_id", "expected_revision", ...CONFIGURATION_KEYS]) }),
  tombstone_job: Object.freeze({ required: Object.freeze(["operation", "job_id", "expected_revision"]) }),
  rebind_job: Object.freeze({ required: Object.freeze(["operation", "job_id", "expected_revision"]) }),
  enable: Object.freeze({ required: Object.freeze(["operation", "job_id", "expected_revision"]) }),
  pause: Object.freeze({ required: Object.freeze(["operation", "job_id", "expected_revision"]) }),
  run_now: Object.freeze({ required: Object.freeze(["operation", "job_id", "expected_revision"]) }),
  prepare_browser_profile: Object.freeze({ required: Object.freeze(["operation", "job_id", "expected_revision"]) }),
  cancel: Object.freeze({ required: Object.freeze(["operation", "job_id", "run_id", "expected_revision"]) }),
  list_runs: Object.freeze({ required: Object.freeze(["operation", "job_id"]), optional: Object.freeze(["limit"]) }),
});

/** TypeBox validation is not a security boundary because internal callers can
 * invoke ToolDefinition.execute directly. Keep an independent exact structural
 * gate before authority resolution or any store/snapshot access. */
function validateExactOperationInput(raw: unknown): Record<string, unknown> & { operation: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Protected automation input must be an exact operation object");
  }
  const value = raw as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key !== "string" || !descriptor?.enumerable || descriptor.get || descriptor.set;
  })) {
    throw new Error("Protected automation operation contains unsafe fields");
  }
  const operation = descriptors.operation?.value;
  if (typeof operation !== "string" || !Object.hasOwn(OPERATION_KEYS, operation)) {
    throw new Error("Protected automation operation is unavailable");
  }
  const shape = OPERATION_KEYS[operation]!;
  const allowed = new Set([...(shape.required ?? []), ...(shape.optional ?? [])]);
  if (ownKeys.some((key) => !allowed.has(key as string))) {
    throw new Error("Protected automation operation contains unsupported fields");
  }
  if (shape.required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("Protected automation operation is missing required fields");
  }
  return value as Record<string, unknown> & { operation: string };
}

function publicJob(row: ProtectedAutomationJobRow) {
  return {
    id: row.id,
    project_id: row.project_id,
    agent_profile_id: row.agent_profile_id,
    capability_revision: row.capability_revision,
    revision: row.revision,
    source_revision: row.source_revision,
    name: row.name,
    source_manifest_sha256: row.source_manifest_sha256,
    entrypoint: row.entrypoint,
    argv: [...row.argv],
    uses_browser_profile: row.uses_browser_profile,
    allowed_https_origins: [...row.allowed_https_origins],
    cron_expr: row.cron_expr,
    timezone: row.timezone,
    timeout_ms: row.timeout_ms,
    overlap_policy: row.overlap_policy,
    missed_run_policy: row.missed_run_policy,
    enabled: row.enabled,
    blocked_reason: row.blocked_reason,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    schedule_cursor_at: row.schedule_cursor_at,
    last_occurrence_key: row.last_occurrence_key,
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
  };
}

function publicRun(row: ProtectedAutomationRunRow) {
  return {
    id: row.id,
    job_id: row.job_id,
    project_id: row.project_id,
    agent_profile_id: row.agent_profile_id,
    job_revision: row.job_revision,
    capability_revision: row.capability_revision,
    trigger: row.trigger,
    scheduled_for: row.scheduled_for,
    occurrence_key: row.occurrence_key,
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: row.status,
    outcome_code: row.outcome_code,
    exit_code: row.exit_code,
    attention: protectedAutomationAttentionMetadata(row),
  };
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

function ownedJob(binding: Readonly<ProtectedAutomationBinding>, jobId: string): ProtectedAutomationJobRow {
  const row = getProtectedAutomationJob(jobId);
  if (!row || row.project_id !== binding.projectId || row.agent_profile_id !== binding.agentProfileId) {
    throw new WorkspaceStoreError("Protected automation job not found", 404);
  }
  return row;
}

function publicSnapshot(snapshot: ProtectedAutomationSnapshotMetadata): ProtectedAutomationSnapshotMetadata {
  return {
    revision: snapshot.revision,
    entrypoint: snapshot.entrypoint,
    manifestSha256: snapshot.manifestSha256,
    entrypointSha256: snapshot.entrypointSha256,
    fileCount: snapshot.fileCount,
    directoryCount: snapshot.directoryCount,
    totalBytes: snapshot.totalBytes,
  };
}

function discardUnreferencedSnapshot(
  binding: Readonly<ProtectedAutomationBinding>,
  jobId: string,
  capture: ProtectedAutomationSnapshotCaptureResult,
): void {
  if (!capture.created) return;
  const discarded = discardProtectedAutomationSnapshot({
    projectId: binding.projectId,
    agentProfileId: binding.agentProfileId,
    jobId,
    revision: capture.revision,
    expectedManifestSha256: capture.manifestSha256,
    capture,
  });
  if (!discarded) throw new Error("New protected automation snapshot could not be discarded safely");
}

function updateFields(value: JobConfigurationValue, snapshot: ProtectedAutomationSnapshotMetadata): ProtectedAutomationJobUpdateFields {
  return {
    name: value.name,
    source_manifest_sha256: snapshot.manifestSha256,
    entrypoint: value.entrypoint,
    argv: [...value.argv],
    uses_browser_profile: value.uses_browser_profile,
    allowed_https_origins: [...value.allowed_https_origins],
    cron_expr: value.cron_expr,
    timezone: "local",
    timeout_ms: value.timeout_ms,
    overlap_policy: "skip",
    missed_run_policy: value.missed_run_policy,
  };
}

function reloadScheduledJob(jobId: string): void {
  try { getProtectedAutomationScheduler()?.reload(jobId); } catch { /* durable state remains fail-closed */ }
}

function sanitizedError(error: unknown): Error {
  if (error instanceof WorkspaceStoreError && error.statusCode === 409) {
    return new Error("Protected automation conflict; refresh exact job metadata and retry");
  }
  if (error instanceof WorkspaceStoreError && error.statusCode === 404) {
    return new Error("Protected automation job not found for this exact owner");
  }
  if (error instanceof Error && /^Protected automation (?:operation was denied|result was suppressed):/u.test(error.message)) {
    return error;
  }
  return new Error("Protected automation operation failed safely");
}

/** Production management composition. Capability activation remains unavailable in the public catalog. */
export function createProtectedAutomationToolRuntime(options: {
  binding: ProtectedAutomationBinding;
  isRuntimeCurrent(): boolean;
}): ProtectedAutomationToolRuntime {
  const authority = new ProtectedAutomationAuthority(options.binding, { isRuntimeCurrent: options.isRuntimeCurrent });
  const binding = authority.binding;

  const executeOperation = async (value: Record<string, unknown> & { operation: string }): Promise<unknown> => {
    switch (value.operation) {
      case "status": {
        const jobs = listProtectedAutomationJobs().filter((row) => row.project_id === binding.projectId
          && row.agent_profile_id === binding.agentProfileId);
        return {
          capability_id: binding.capabilityId,
          project_id: binding.projectId,
          agent_profile_id: binding.agentProfileId,
          association_revision: binding.associationRevision,
          milestone: 5,
          inert: false,
          activationAvailable: true,
          actions: ["status", "list_jobs", "get_job", "capture_job", "update_job", "tombstone_job", "rebind_job", "enable", "pause", "run_now", "prepare_browser_profile", "cancel", "list_runs"],
          job_count: jobs.length,
        };
      }
      case "list_jobs": {
        const limit = value.limit === undefined ? DEFAULT_PROTECTED_AUTOMATION_JOB_LIST_LIMIT : value.limit;
        if (!Number.isSafeInteger(limit) || (limit as number) < 1 ||
            (limit as number) > MAX_PROTECTED_AUTOMATION_JOB_LIST_LIMIT) {
          throw new WorkspaceStoreError("Invalid protected automation job list limit");
        }
        if (value.after_job_id !== undefined && (typeof value.after_job_id !== "string" ||
            value.after_job_id.length === 0 || value.after_job_id.length > 256 ||
            value.after_job_id !== value.after_job_id.normalize("NFC") || /[\u0000-\u001f\u007f]/u.test(value.after_job_id))) {
          throw new WorkspaceStoreError("Invalid protected automation job cursor");
        }
        const owned = listProtectedAutomationJobs().filter((row) => row.project_id === binding.projectId
          && row.agent_profile_id === binding.agentProfileId)
          .sort((left, right) => left.created_at - right.created_at ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
        let start = 0;
        if (value.after_job_id !== undefined) {
          const cursorIndex = owned.findIndex((row) => row.id === value.after_job_id);
          if (cursorIndex < 0) throw new WorkspaceStoreError("Protected automation job cursor not found for this exact owner", 404);
          start = cursorIndex + 1;
        }
        const page = owned.slice(start, start + (limit as number) + 1);
        const hasMore = page.length > (limit as number);
        const jobs = page.slice(0, limit as number);
        return {
          jobs: jobs.map(publicJob),
          next_after_job_id: hasMore ? jobs[jobs.length - 1]!.id : null,
        };
      }
      case "get_job":
        return { job: publicJob(ownedJob(binding, value.job_id as string)) };
      case "capture_job": {
        const input = value as unknown as JobConfigurationValue;
        const jobId = randomUUID();
        const snapshot = captureProtectedAutomationSnapshot({
          projectRoot: binding.projectCwd,
          projectId: binding.projectId,
          agentProfileId: binding.agentProfileId,
          jobId,
          revision: 1,
          sourceDirectory: input.source_directory,
          entrypoint: input.entrypoint,
        });
        let committed = false;
        try {
          authority.assertAuthorized("prerelease");
          const job = createProtectedAutomationJob({
            id: jobId,
            project_id: binding.projectId,
            agent_profile_id: binding.agentProfileId,
            capability_revision: binding.associationRevision,
            ...updateFields(input, snapshot),
          });
          committed = true;
          finalizeProtectedAutomationSnapshotCapture(snapshot);
          return { job: publicJob(job), snapshot: publicSnapshot(snapshot) };
        } catch (error) {
          if (!committed) discardUnreferencedSnapshot(binding, jobId, snapshot);
          throw error;
        }
      }
      case "update_job": {
        const input = value as unknown as JobConfigurationValue & { job_id: string; expected_revision: number };
        const current = ownedJob(binding, input.job_id);
        if (current.revision !== input.expected_revision || current.deleted_at !== null) {
          throw new WorkspaceStoreError("Protected automation job revision conflict", 409);
        }
        if (current.revision >= Number.MAX_SAFE_INTEGER - 1) {
          throw new WorkspaceStoreError("Protected automation job revision conflict", 409);
        }
        const snapshot = captureProtectedAutomationSnapshot({
          projectRoot: binding.projectCwd,
          projectId: binding.projectId,
          agentProfileId: binding.agentProfileId,
          jobId: current.id,
          revision: current.source_revision + 1,
          sourceDirectory: input.source_directory,
          entrypoint: input.entrypoint,
        });
        let committed = false;
        try {
          authority.assertAuthorized("prerelease");
          const job = updateProtectedAutomationJob(current.id, current.revision, updateFields(input, snapshot));
          committed = true;
          finalizeProtectedAutomationSnapshotCapture(snapshot);
          getProtectedAutomationManager()?.terminateJobs((candidate) => candidate.id === job.id);
          getProtectedAutomationPreparationPort()?.jobChanged(job.id);
          reloadScheduledJob(job.id);
          return { job: publicJob(job), snapshot: publicSnapshot(snapshot) };
        } catch (error) {
          if (!committed) discardUnreferencedSnapshot(binding, current.id, snapshot);
          throw error;
        }
      }
      case "tombstone_job": {
        const jobId = value.job_id as string;
        const canonical = ownedJob(binding, jobId);
        if (canonical.revision !== value.expected_revision) throw new WorkspaceStoreError("Protected automation job revision conflict", 409);
        const deleted = tombstoneProtectedAutomationJob(jobId, canonical.revision);
        getProtectedAutomationManager()?.terminateJobs((job) => job.id === jobId);
        getProtectedAutomationPreparationPort()?.jobChanged(jobId);
        reloadScheduledJob(deleted.id);
        return { job: publicJob(deleted) };
      }
      case "rebind_job": {
        const job = ownedJob(binding, value.job_id as string);
        if (job.revision !== value.expected_revision) throw new WorkspaceStoreError("Protected automation job revision conflict", 409);
        const rebound = rebindProtectedAutomationJob(
          job.id,
          value.expected_revision as number,
          binding.associationRevision,
        );
        getProtectedAutomationPreparationPort()?.jobChanged(job.id);
        reloadScheduledJob(job.id);
        return { job: publicJob(rebound) };
      }
      case "enable":
      case "pause": {
        const job = ownedJob(binding, value.job_id as string);
        if (job.revision !== value.expected_revision) throw new WorkspaceStoreError("Protected automation job revision conflict", 409);
        const changed = transitionProtectedAutomationJobLifecycle(
          job.id,
          value.expected_revision as number,
          value.operation === "enable",
        );
        if (value.operation === "pause") getProtectedAutomationManager()?.terminateJobs((candidate) => candidate.id === job.id);
        getProtectedAutomationPreparationPort()?.jobChanged(job.id);
        reloadScheduledJob(job.id);
        return { job: publicJob(changed) };
      }
      case "run_now": {
        const job = ownedJob(binding, value.job_id as string);
        if (job.revision !== value.expected_revision) throw new WorkspaceStoreError("Protected automation job revision conflict", 409);
        const manager = getProtectedAutomationManager();
        if (!manager) throw new WorkspaceStoreError("Protected automation runner is unavailable", 503);
        return { run: publicRun(manager.runNow(job.id, job.revision)) };
      }
      case "prepare_browser_profile": {
        const job = ownedJob(binding, value.job_id as string);
        if (job.revision !== value.expected_revision || job.deleted_at !== null) {
          throw new WorkspaceStoreError("Protected automation job revision conflict", 409);
        }
        if (!job.uses_browser_profile) throw new WorkspaceStoreError("Protected automation job does not use a browser profile", 409);
        const preparation = getProtectedAutomationPreparationPort();
        if (!preparation) throw new WorkspaceStoreError("Protected automation browser preparation is unavailable", 503);
        return { preparation: await preparation.prepare({
          binding,
          job,
          assertAuthorized: () => authority.assertAuthorized("preoperation"),
        }) };
      }
      case "cancel": {
        const job = ownedJob(binding, value.job_id as string);
        if (job.revision !== value.expected_revision) throw new WorkspaceStoreError("Protected automation job revision conflict", 409);
        const runId = value.run_id as string;
        const ownedRun = listProtectedAutomationRuns(job.id, MAX_PROTECTED_AUTOMATION_RUNS_PER_JOB)
          .find((run) => run.id === runId);
        if (!ownedRun) throw new WorkspaceStoreError("Protected automation run not found", 404);
        const manager = getProtectedAutomationManager();
        if (!manager) throw new WorkspaceStoreError("Protected automation runner is unavailable", 503);
        return { run: publicRun(manager.cancel(runId)) };
      }
      case "list_runs": {
        const job = ownedJob(binding, value.job_id as string);
        const limit = value.limit === undefined ? 100 : value.limit as number;
        return { runs: listProtectedAutomationRuns(job.id, limit)
          .filter((row) => row.project_id === binding.projectId
            && row.agent_profile_id === binding.agentProfileId).map(publicRun) };
      }
      default:
        throw new Error("Protected automation operation is unavailable");
    }
  };

  const tool = defineTool({
    name: PROTECTED_AUTOMATION_TOOL_NAME,
    label: "Protected Automation",
    description: "Manage deterministic snapshot-bound automation for this exact Protected Project-Agent pair after explicit PIN-approved capability activation.",
    promptSnippet: "Manage exact-pair deterministic Protected automation jobs",
    promptGuidelines: [
      "The target Project and Agent Profile are implicit and cannot be selected in tool input.",
      "Every mutation requires the exact revision returned by the latest read or mutation.",
      "A capability-revoked retained job must be explicitly rebound, remains paused, and then requires a separate enable call.",
      "Do not place secrets in argv or source files; credential and MFA steps remain human-only.",
      "Browser jobs fail closed unless the backend has injected the bounded FD3 browser interface.",
      "prepare_browser_profile creates a dedicated human-only preparation transport for this exact job revision; credentials never belong in tool arguments.",
    ],
    parameters: Parameters,
    async execute(_toolCallId, raw) {
      try {
        const value = validateExactOperationInput(raw);
        authority.assertAuthorized("preoperation");
        const result = await executeOperation(value);
        authority.assertAuthorized("prerelease");
        return textResult(result);
      } catch (error) {
        throw sanitizedError(error);
      }
    },
  });

  return {
    tool,
    authority,
    binding,
    preflight: () => authority.preflight(),
    async close() { authority.close(); },
  };
}
