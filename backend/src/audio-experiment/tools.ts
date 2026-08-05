import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getRegisteredAttachment } from "../attachments.js";
import type { BrowserTurnProvenance } from "../interactive-turn-provenance.js";
import { FileAudioExperimentConsent } from "./consent.js";
import {
  assertPreviewableAudioAttachment,
  executeFileAudioExperimentPath,
} from "./path.js";
import {
  FILE_AUDIO_EXPERIMENT_TOOL_NAME,
  type FileAudioAttachmentSnapshot,
  type FileAudioExperimentBinding,
  type FileAudioExecutedAnalysis,
  type FileAudioExperimentDependencies,
  type FileAudioExperimentPreview,
  type FileAudioExperimentRuntime,
} from "./types.js";
const Parameters = Type.Union([
  Type.Object({
    operation: Type.Literal("preview"),
    attachment_id: Type.String({ minLength: 1, maxLength: 128 }),
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("execute"),
    permit_id: Type.String({ minLength: 1, maxLength: 128 }),
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("revoke"),
    permit_id: Type.String({ minLength: 1, maxLength: 128 }),
  }, { additionalProperties: false }),
]);

const EXACT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  preview: Object.freeze(["operation", "attachment_id"]),
  execute: Object.freeze(["operation", "permit_id"]),
  revoke: Object.freeze(["operation", "permit_id"]),
});

function exactInput(raw: unknown): Record<string, unknown> & { operation: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("File-audio input must be an exact operation object");
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Reflect.ownKeys(raw);
  if (keys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    return typeof key !== "string" || !descriptor?.enumerable || descriptor.get || descriptor.set;
  })) throw new Error("File-audio input contains unsafe fields");
  const operation = descriptors.operation?.value;
  if (typeof operation !== "string" || !Object.hasOwn(EXACT_KEYS, operation)) throw new Error("File-audio operation is unavailable");
  const allowed = new Set(EXACT_KEYS[operation]);
  if (keys.some((key) => !allowed.has(key as string))) throw new Error("File-audio input contains unsupported fields");
  const required = operation === "preview" ? "attachment_id" : "permit_id";
  if (typeof descriptors[required]?.value !== "string" || descriptors[required]!.value.length === 0
    || descriptors[required]!.value.length > 128) {
    throw new Error("File-audio operation is missing its bounded backend-issued identifier");
  }
  return raw as Record<string, unknown> & { operation: string };
}

function snapshot(record: ReturnType<typeof getRegisteredAttachment>): FileAudioAttachmentSnapshot {
  if (!record) throw new Error("Attachment is not registered for this source session");
  return Object.freeze({
    attachmentId: record.attachmentId,
    displayName: record.displayName,
    declaredMimeType: record.declaredMimeType,
    sourceBytes: record.sourceBytes,
    sourceSha256: record.sourceSha256,
  });
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

function executedResult(options: {
  attachmentId: string;
  sourceSha256: string;
  analysis: FileAudioExecutedAnalysis;
}) {
  return textResult({
    attachment_id: options.attachmentId,
    source_sha256: options.sourceSha256,
    topology: "blinded-direct-A-B-plus-local-DSP-to-isolated-gpt-5.6-sol",
    candidates: options.analysis.candidates.map((candidate) => ({
      label: candidate.label,
      response: candidate.response,
    })),
    synthesis: {
      response: options.analysis.synthesis.response,
      provider: {
        response_id: options.analysis.synthesis.provider.responseId,
        model: options.analysis.synthesis.provider.model,
        usage: options.analysis.synthesis.provider.usage,
      },
    },
    dsp: {
      numeric_text: options.analysis.dsp.numericText,
      metadata: options.analysis.dsp.metadata,
      artifacts: options.analysis.dsp.artifacts.map((artifact) => ({
        label: artifact.label,
        mime_type: artifact.mimeType,
        width: artifact.width,
        height: artifact.height,
        byte_length: artifact.byteLength,
        sha256: artifact.sha256,
      })),
    },
  });
}

function sameBoundTurn(left: BrowserTurnProvenance | null, right: BrowserTurnProvenance): boolean {
  return Boolean(left && left.piUserEntryId && right.piUserEntryId)
    && left!.token === right.token
    && left!.piUserEntryId === right.piUserEntryId
    && left!.acceptedAt === right.acceptedAt
    && left!.contentSha256 === right.contentSha256
    && left!.sourceKind === right.sourceKind
    && left!.sourceSessionId === right.sourceSessionId
    && left!.runtimeGeneration === right.runtimeGeneration
    && left!.agentProfileId === right.agentProfileId
    && left!.projectId === right.projectId
    && left!.projectCwd === right.projectCwd
    && left!.provider === right.provider
    && left!.model === right.model;
}

export interface CreateFileAudioExperimentRuntimeOptions {
  readonly binding: FileAudioExperimentBinding;
  readonly dependencies: FileAudioExperimentDependencies;
  readonly getCurrentTurn: () => BrowserTurnProvenance | null;
  readonly isRuntimeCurrent: () => boolean;
  readonly permitTtlMs?: number;
  readonly now?: () => number;
}

/** Build an inert, source-bound tool. No dependency is invoked until execute
 * has atomically claimed a valid same-current-turn permit. */
export function createFileAudioExperimentRuntime(
  options: CreateFileAudioExperimentRuntimeOptions,
): FileAudioExperimentRuntime & { readonly tool: ToolDefinition } {
  const binding = Object.freeze({ ...options.binding });
  const consent = new FileAudioExperimentConsent(binding, { ttlMs: options.permitTtlMs, now: options.now });
  let revoked = false;
  const preflight = () => {
    if (revoked) return { allowed: false as const, reason: "File-audio experiment runtime is revoked" };
    try {
      return options.isRuntimeCurrent()
        ? { allowed: true as const }
        : { allowed: false as const, reason: "File-audio experiment runtime generation is stale" };
    } catch {
      return { allowed: false as const, reason: "File-audio experiment runtime identity is unavailable" };
    }
  };
  const currentTurn = (): BrowserTurnProvenance => {
    const decision = preflight();
    if (!decision.allowed) throw new Error(decision.reason);
    const turn = options.getCurrentTurn();
    if (!turn) throw new Error("File-audio operation requires the current persisted browser user turn");
    return turn;
  };

  const tool = defineTool({
    name: FILE_AUDIO_EXPERIMENT_TOOL_NAME,
    label: "File Audio Experiment",
    description: "Preview, execute, or revoke the disabled-by-default complete A/B/C file-audio experiment for an exact backend-issued attachment ID. Preview, execute, and revoke are bound to the same current browser user turn.",
    promptSnippet: "Use preview then execute in this same turn only when the user requested file-audio analysis",
    promptGuidelines: [
      "Use only backend-issued attachment_id values from the current source session.",
      "Call preview before execute; permits are short-lived, same-current-turn, and single-use.",
      "The experiment always runs complete A/B/C; never request or imply an arm subset.",
      "Do not open a questionnaire. Use revoke in the same originating turn to cancel a permit.",
    ],
    parameters: Parameters,
    async execute(_toolCallId, raw) {
      const value = exactInput(raw);
      if (value.operation === "preview") {
        const turn = currentTurn();
        const attachment = snapshot(getRegisteredAttachment(binding.sourceSessionId, value.attachment_id as string));
        assertPreviewableAudioAttachment(attachment);
        const permit = consent.preview({ turn, attachment });
        const preview: FileAudioExperimentPreview = {
          permit_id: permit.permitId,
          attachment,
          arms: permit.arms,
          expires_at: new Date(permit.expiresAt).toISOString(),
          warning: "Execute in this same current user turn. The complete topology sends identical sanitized audio to both direct-audio adapters, then sends only blinded validated responses and local DSP artifacts to isolated synthesis.",
        };
        return textResult(preview);
      }
      if (value.operation === "revoke") {
        const turn = currentTurn();
        return textResult({ revoked: consent.revoke(value.permit_id as string, turn) });
      }

      const turn = currentTurn();
      const permitId = value.permit_id as string;
      const claimed = consent.claim(permitId, turn);
      try {
        const analysis = await executeFileAudioExperimentPath({
          binding,
          attachment: claimed.permit.attachment,
          dependencies: options.dependencies,
          signal: claimed.signal,
          assertCurrent: () => {
            const decision = preflight();
            const activeTurn = options.getCurrentTurn();
            if (!decision.allowed || !sameBoundTurn(activeTurn, claimed.permit.turn)) {
              throw new Error("File-audio execution authority is no longer current");
            }
          },
        });
        const release = preflight();
        if (!release.allowed || !sameBoundTurn(options.getCurrentTurn(), claimed.permit.turn)) {
          throw new Error("File-audio result was suppressed because runtime or turn authority changed");
        }
        return executedResult({
          attachmentId: claimed.permit.attachment.attachmentId,
          sourceSha256: claimed.permit.attachment.sourceSha256,
          analysis,
        });
      } finally {
        consent.finish(permitId);
      }
    },
  });

  return {
    tool,
    binding,
    preflight,
    async close() {
      revoked = true;
      consent.close();
    },
  };
}
