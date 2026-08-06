import { createHash, randomBytes } from "node:crypto";
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
  type FileAudioCandidateScore,
  type FileAudioConditionGuess,
  type FileAudioExecutedAnalysis,
  type FileAudioExperimentBinding,
  type FileAudioExperimentDependencies,
  type FileAudioExperimentPreview,
  type FileAudioExperimentRuntime,
  type FileAudioInternalLabelArm,
  type FileAudioScoreSubmission,
} from "./types.js";

const CandidateScoreParameters = Type.Object({
  label: Type.String({ minLength: 32, maxLength: 32, pattern: "^[a-f0-9]{32}$" }),
  temporal_grounding: Type.Integer({ minimum: 0, maximum: 4 }),
  perceptual_specificity: Type.Integer({ minimum: 0, maximum: 4 }),
  structural_coherence: Type.Integer({ minimum: 0, maximum: 4 }),
  affective_usefulness: Type.Integer({ minimum: 0, maximum: 4 }),
  evidence_uncertainty_calibration: Type.Integer({ minimum: 0, maximum: 4 }),
  source_honesty: Type.Integer({ minimum: 0, maximum: 4 }),
  rationale: Type.String({ minLength: 1, maxLength: 2000 }),
}, { additionalProperties: false });

const ConditionGuessParameters = Type.Object({
  label: Type.String({ minLength: 32, maxLength: 32, pattern: "^[a-f0-9]{32}$" }),
  condition: Type.Union([Type.Literal("wren"), Type.Literal("neutral"), Type.Literal("unsure")]),
}, { additionalProperties: false });

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
  Type.Object({
    operation: Type.Literal("score"),
    run_id: Type.String({ minLength: 32, maxLength: 32, pattern: "^[a-f0-9]{32}$" }),
    candidates: Type.Tuple([CandidateScoreParameters, CandidateScoreParameters]),
    preferred_label: Type.String({ minLength: 3, maxLength: 32 }),
    condition_guesses: Type.Tuple([ConditionGuessParameters, ConditionGuessParameters]),
    blind_breaks: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 })),
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("reveal"),
    run_id: Type.String({ minLength: 32, maxLength: 32, pattern: "^[a-f0-9]{32}$" }),
  }, { additionalProperties: false }),
]);

const EXACT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  preview: Object.freeze(["operation", "attachment_id"]),
  execute: Object.freeze(["operation", "permit_id"]),
  revoke: Object.freeze(["operation", "permit_id"]),
  score: Object.freeze(["operation", "run_id", "candidates", "preferred_label", "condition_guesses", "blind_breaks"]),
  reveal: Object.freeze(["operation", "run_id"]),
});

const SCORE_KEYS = Object.freeze([
  "label",
  "temporal_grounding",
  "perceptual_specificity",
  "structural_coherence",
  "affective_usefulness",
  "evidence_uncertainty_calibration",
  "source_honesty",
  "rationale",
]);
const GUESS_KEYS = Object.freeze(["label", "condition"]);
const SCORE_METRICS = Object.freeze([
  "temporal_grounding",
  "perceptual_specificity",
  "structural_coherence",
  "affective_usefulness",
  "evidence_uncertainty_calibration",
  "source_honesty",
] as const);
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;
const LABEL_PATTERN = /^[a-f0-9]{32}$/u;
const SCORE_CONDITIONS = new Set<FileAudioConditionGuess>(["wren", "neutral", "unsure"]);
export const FILE_AUDIO_SCORE_LEDGER_MAX_RECORDS = 8;
export const FILE_AUDIO_SCORE_LEDGER_TTL_MS = 60 * 60 * 1000;

type ExactObject = Record<string, unknown>;

function exactDataObject(raw: unknown, allowedKeys: readonly string[], requiredKeys = allowedKeys): ExactObject {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("File-audio input must contain exact data objects");
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("File-audio input contains unsafe objects");
  }
  const allowed = new Set(allowedKeys);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Reflect.ownKeys(raw);
  if (keys.some((key) => {
    if (typeof key !== "string" || !allowed.has(key)) return true;
    const descriptor = descriptors[key];
    return !descriptor?.enumerable || descriptor.get !== undefined || descriptor.set !== undefined;
  })) throw new Error("File-audio input contains unsupported or unsafe fields");
  if (requiredKeys.some((key) => !Object.hasOwn(descriptors, key))) {
    throw new Error("File-audio input is missing required fields");
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function exactDataArray(raw: unknown, length?: number): readonly unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype
    || (length !== undefined && raw.length !== length)) {
    throw new Error("File-audio input contains an invalid exact array");
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Reflect.ownKeys(raw);
  if (keys.some((key) => {
    if (key === "length") return false;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) return true;
    const index = Number(key);
    const descriptor = descriptors[key];
    return index >= raw.length || !descriptor?.enumerable || descriptor.get !== undefined || descriptor.set !== undefined;
  })) throw new Error("File-audio input contains unsupported or unsafe array fields");
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.hasOwn(descriptors, String(index))) throw new Error("File-audio input contains a sparse array");
  }
  return Array.from({ length: raw.length }, (_, index) => descriptors[String(index)]!.value);
}

function exactInput(raw: unknown): ExactObject & { operation: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("File-audio input must be an exact operation object");
  const operationDescriptor = Object.getOwnPropertyDescriptor(raw, "operation");
  const operation = operationDescriptor?.get === undefined && operationDescriptor?.set === undefined
    ? operationDescriptor?.value
    : undefined;
  if (typeof operation !== "string" || !Object.hasOwn(EXACT_KEYS, operation)) throw new Error("File-audio operation is unavailable");
  const required = operation === "score"
    ? EXACT_KEYS.score.filter((key) => key !== "blind_breaks")
    : EXACT_KEYS[operation];
  const value = exactDataObject(raw, EXACT_KEYS[operation], required);
  if (operation === "preview") {
    if (typeof value.attachment_id !== "string" || value.attachment_id.length < 1 || value.attachment_id.length > 128) {
      throw new Error("File-audio operation is missing its bounded backend-issued identifier");
    }
  } else if (operation === "execute" || operation === "revoke") {
    if (typeof value.permit_id !== "string" || value.permit_id.length < 1 || value.permit_id.length > 128) {
      throw new Error("File-audio operation is missing its bounded backend-issued identifier");
    }
  } else if (typeof value.run_id !== "string" || !RUN_ID_PATTERN.test(value.run_id)) {
    throw new Error("File-audio operation requires an exact run_id");
  }
  return value as ExactObject & { operation: string };
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
  runId: string;
  attachmentId: string;
  sourceSha256: string;
  analysis: FileAudioExecutedAnalysis;
}) {
  return textResult({
    run_id: options.runId,
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
    scoring_required_before_reveal: true,
    next_step: "Finish the blind comparison, then submit one score operation for these exact labels before requesting reveal.",
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

function turnMatchesBinding(turn: BrowserTurnProvenance, binding: Readonly<FileAudioExperimentBinding>): boolean {
  return Boolean(turn.piUserEntryId)
    && turn.sourceKind === "browser_send_message"
    && turn.sourceSessionId === binding.sourceSessionId
    && turn.runtimeGeneration === binding.runtimeGeneration
    && turn.agentProfileId === binding.agentProfileId
    && turn.projectId === binding.projectId
    && turn.projectCwd === binding.projectCwd
    && turn.provider === binding.provider
    && turn.model === binding.model;
}

function validatedInternalMapping(analysis: FileAudioExecutedAnalysis): readonly [FileAudioInternalLabelArm, FileAudioInternalLabelArm] {
  const labels = analysis.candidates.map((candidate) => candidate.label);
  if (labels.length !== 2 || labels.some((label) => !LABEL_PATTERN.test(label)) || labels[0] === labels[1]) {
    throw new Error("File-audio execution returned invalid opaque candidate labels");
  }
  const mapping = analysis.internalLabelToArm;
  if (!Array.isArray(mapping) || mapping.length !== 2 || !Object.isFrozen(mapping)
    || mapping.some((entry) => !entry || !Object.isFrozen(entry) || !LABEL_PATTERN.test(entry.label)
      || (entry.arm !== "A" && entry.arm !== "B"))) {
    throw new Error("File-audio execution returned an invalid internal label mapping");
  }
  const mappedLabels = new Set(mapping.map((entry) => entry.label));
  const mappedArms = new Set(mapping.map((entry) => entry.arm));
  if (mappedLabels.size !== 2 || mappedArms.size !== 2
    || labels.some((label) => !mappedLabels.has(label)) || !mappedArms.has("A") || !mappedArms.has("B")) {
    throw new Error("File-audio execution mapping does not cover the exact blind candidates");
  }
  return Object.freeze(mapping.map((entry) => Object.freeze({ label: entry.label, arm: entry.arm }))) as unknown as readonly [FileAudioInternalLabelArm, FileAudioInternalLabelArm];
}

interface ScoreLedgerRecord {
  readonly runId: string;
  readonly attachment: FileAudioAttachmentSnapshot;
  readonly sourceSha256: string;
  readonly labels: readonly [string, string];
  readonly createdAt: number;
  readonly expiresAt: number;
  mapping: readonly [FileAudioInternalLabelArm, FileAudioInternalLabelArm] | undefined;
  expiryTimer?: ReturnType<typeof setTimeout>;
  score?: FileAudioScoreSubmission;
  commitment?: string;
  revealed: boolean;
}

function canonicalScore(value: ExactObject, labels: readonly [string, string]): FileAudioScoreSubmission {
  const candidateValues = exactDataArray(value.candidates, 2).map((raw) => {
    const candidate = exactDataObject(raw, SCORE_KEYS);
    if (typeof candidate.label !== "string" || !LABEL_PATTERN.test(candidate.label)) {
      throw new Error("File-audio score contains an invalid candidate label");
    }
    for (const metric of SCORE_METRICS) {
      if (!Number.isInteger(candidate[metric]) || (candidate[metric] as number) < 0 || (candidate[metric] as number) > 4) {
        throw new Error(`File-audio score metric ${metric} must be an integer from 0 through 4`);
      }
    }
    if (typeof candidate.rationale !== "string" || candidate.rationale.length < 1 || candidate.rationale.length > 2000) {
      throw new Error("File-audio score rationale must contain 1 through 2000 characters");
    }
    return candidate;
  });
  if (new Set(candidateValues.map((candidate) => candidate.label)).size !== 2
    || labels.some((label) => !candidateValues.some((candidate) => candidate.label === label))) {
    throw new Error("File-audio score must cover each exact run label once");
  }

  const preferredLabel = value.preferred_label;
  if (typeof preferredLabel !== "string"
    || (preferredLabel !== "tie" && !labels.includes(preferredLabel))) {
    throw new Error("File-audio score preferred_label must be one run label or tie");
  }

  const guessValues = exactDataArray(value.condition_guesses, 2).map((raw) => {
    const guess = exactDataObject(raw, GUESS_KEYS);
    if (typeof guess.label !== "string" || !LABEL_PATTERN.test(guess.label)
      || typeof guess.condition !== "string" || !SCORE_CONDITIONS.has(guess.condition as FileAudioConditionGuess)) {
      throw new Error("File-audio score contains an invalid condition guess");
    }
    return guess as { label: string; condition: FileAudioConditionGuess };
  });
  if (new Set(guessValues.map((guess) => guess.label)).size !== 2
    || labels.some((label) => !guessValues.some((guess) => guess.label === label))) {
    throw new Error("File-audio condition guesses must cover each exact run label once");
  }

  const blindBreaks = value.blind_breaks === undefined ? [] : exactDataArray(value.blind_breaks);
  if (blindBreaks.length > 8 || blindBreaks.some((entry) => typeof entry !== "string" || entry.length < 1 || entry.length > 500)) {
    throw new Error("File-audio blind_breaks must contain at most eight bounded strings");
  }

  const orderedCandidates = labels.map((label) => {
    const candidate = candidateValues.find((entry) => entry.label === label)!;
    return Object.freeze({
      label,
      temporal_grounding: candidate.temporal_grounding as number,
      perceptual_specificity: candidate.perceptual_specificity as number,
      structural_coherence: candidate.structural_coherence as number,
      affective_usefulness: candidate.affective_usefulness as number,
      evidence_uncertainty_calibration: candidate.evidence_uncertainty_calibration as number,
      source_honesty: candidate.source_honesty as number,
      rationale: candidate.rationale as string,
    }) satisfies FileAudioCandidateScore;
  }) as unknown as [FileAudioCandidateScore, FileAudioCandidateScore];
  const orderedGuesses = labels.map((label) => {
    const guess = guessValues.find((entry) => entry.label === label)!;
    return Object.freeze({ label, condition: guess.condition });
  }) as unknown as [{ label: string; condition: FileAudioConditionGuess }, { label: string; condition: FileAudioConditionGuess }];

  return Object.freeze({
    run_id: value.run_id as string,
    candidates: Object.freeze(orderedCandidates),
    preferred_label: preferredLabel,
    condition_guesses: Object.freeze(orderedGuesses),
    blind_breaks: Object.freeze([...blindBreaks] as string[]),
  });
}

export interface CreateFileAudioExperimentRuntimeOptions {
  readonly binding: FileAudioExperimentBinding;
  readonly dependencies: FileAudioExperimentDependencies;
  readonly getCurrentTurn: () => BrowserTurnProvenance | null;
  readonly isRuntimeCurrent: () => boolean;
  readonly permitTtlMs?: number;
  readonly now?: () => number;
}

/** Build an inert, source-bound tool. Provider/media dependencies are invoked
 * only after execute atomically claims a valid same-current-turn permit. */
export function createFileAudioExperimentRuntime(
  options: CreateFileAudioExperimentRuntimeOptions,
): FileAudioExperimentRuntime & { readonly tool: ToolDefinition } {
  const binding = Object.freeze({ ...options.binding });
  const now = options.now ?? Date.now;
  const consent = new FileAudioExperimentConsent(binding, { ttlMs: options.permitTtlMs, now });
  const ledger = new Map<string, ScoreLedgerRecord>();
  let revoked = false;
  const destroyRecord = (record: ScoreLedgerRecord) => {
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    record.expiryTimer = undefined;
    record.mapping = undefined;
    ledger.delete(record.runId);
  };
  const clearLedger = () => {
    for (const record of [...ledger.values()]) destroyRecord(record);
    ledger.clear();
  };
  const preflight = () => {
    if (revoked) return { allowed: false as const, reason: "File-audio experiment runtime is revoked" };
    try {
      if (options.isRuntimeCurrent()) return { allowed: true as const };
      clearLedger();
      return { allowed: false as const, reason: "File-audio experiment runtime generation is stale" };
    } catch {
      clearLedger();
      return { allowed: false as const, reason: "File-audio experiment runtime identity is unavailable" };
    }
  };
  const currentTurn = (): BrowserTurnProvenance => {
    const decision = preflight();
    if (!decision.allowed) throw new Error(decision.reason);
    const turn = options.getCurrentTurn();
    if (!turn || !turnMatchesBinding(turn, binding)) {
      throw new Error("File-audio operation requires the current persisted browser user turn in this runtime");
    }
    return turn;
  };
  const purgeExpired = () => {
    const timestamp = now();
    for (const record of ledger.values()) {
      if (record.expiresAt <= timestamp) destroyRecord(record);
    }
  };
  const liveRecord = (runId: string): ScoreLedgerRecord => {
    purgeExpired();
    const record = ledger.get(runId);
    if (!record || !record.mapping) throw new Error("File-audio run is unavailable in this live runtime");
    return record;
  };
  const retainRun = (attachment: FileAudioAttachmentSnapshot, analysis: FileAudioExecutedAnalysis): ScoreLedgerRecord => {
    purgeExpired();
    const mapping = validatedInternalMapping(analysis);
    while (ledger.size >= FILE_AUDIO_SCORE_LEDGER_MAX_RECORDS) {
      const oldestId = ledger.keys().next().value as string | undefined;
      if (!oldestId) break;
      destroyRecord(ledger.get(oldestId)!);
    }
    let runId = randomBytes(16).toString("hex");
    while (ledger.has(runId) || analysis.candidates.some((candidate) => candidate.label === runId)) {
      runId = randomBytes(16).toString("hex");
    }
    const createdAt = now();
    const labels = Object.freeze([
      analysis.candidates[0].label,
      analysis.candidates[1].label,
    ]) as readonly [string, string];
    const record: ScoreLedgerRecord = {
      runId,
      attachment: Object.freeze({ ...attachment }),
      sourceSha256: attachment.sourceSha256,
      labels,
      mapping,
      createdAt,
      expiresAt: createdAt + FILE_AUDIO_SCORE_LEDGER_TTL_MS,
      revealed: false,
    };
    ledger.set(runId, record);
    record.expiryTimer = setTimeout(() => {
      if (ledger.get(record.runId) === record) destroyRecord(record);
    }, FILE_AUDIO_SCORE_LEDGER_TTL_MS);
    record.expiryTimer.unref?.();
    return record;
  };

  const tool = defineTool({
    name: FILE_AUDIO_EXPERIMENT_TOOL_NAME,
    label: "File Audio Experiment",
    description: "Preview, execute, revoke, score, or reveal the disabled-by-default complete A/B/C file-audio experiment. Execute/revoke use the originating current browser turn; one blind score may be submitted in a later turn of the same live runtime before reveal.",
    promptSnippet: "Use preview then execute for requested file-audio analysis; finish the blind comparison, submit score, and only then reveal",
    promptGuidelines: [
      "Use only backend-issued attachment_id, permit_id, run_id, and exact opaque candidate labels.",
      "Call preview before execute; permits are short-lived, same-current-turn, and single-use.",
      "The experiment always runs complete A/B/C; never request or imply an arm subset.",
      "Wren must finish the blind comparison and commit one complete score before calling reveal; score may occur in a later browser turn only while this exact runtime remains live.",
      "Never infer or claim the hidden mapping from labels, ordering, response/provider metadata, implementation details, or other side channels.",
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
      if (value.operation === "score") {
        currentTurn();
        const record = liveRecord(value.run_id as string);
        if (record.score) throw new Error("File-audio score is immutable and may be submitted only once");
        const score = canonicalScore(value, record.labels);
        const commitment = createHash("sha256").update(JSON.stringify(score), "utf8").digest("hex");
        record.score = score;
        record.commitment = commitment;
        return textResult({ run_id: record.runId, commitment, reveal_ready: true });
      }
      if (value.operation === "reveal") {
        currentTurn();
        const record = liveRecord(value.run_id as string);
        if (!record.score || !record.commitment) throw new Error("File-audio reveal requires an immutable score first");
        const mapping = Object.freeze(Object.fromEntries(record.mapping!.map((entry) => [
          entry.label,
          entry.arm === "A" ? "bounded_wren" : "neutral_specialist",
        ])));
        record.revealed = true;
        return textResult({
          run_id: record.runId,
          commitment: record.commitment,
          mapping,
          preferred_label: record.score.preferred_label,
          condition_guesses: record.score.condition_guesses,
          revealed: true,
        });
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
        const record = retainRun(claimed.permit.attachment, analysis);
        return executedResult({
          runId: record.runId,
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
      clearLedger();
    },
  };
}
