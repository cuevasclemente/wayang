import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BrowserTurnProvenance } from "../interactive-turn-provenance.js";
import type {
  AudioExperimentDirectResponse,
  AudioExperimentSynthesisResponse,
} from "./response.js";

export const FILE_AUDIO_EXPERIMENT_TOOL_NAME = "file_audio_experiment" as const;
export const FILE_AUDIO_EXPERIMENT_ARMS = ["A", "B", "C"] as const;
export type FileAudioExperimentArm = typeof FILE_AUDIO_EXPERIMENT_ARMS[number];

/** Exact process-local runtime identity. No caller-supplied value may create one. */
export interface FileAudioExperimentBinding {
  readonly sourceSessionId: string;
  readonly runtimeGeneration: string;
  readonly processBootNonce: string;
  readonly projectId: string;
  readonly projectCwd: string;
  readonly agentProfileId: string;
  readonly provider: string;
  readonly model: string;
}

export interface FileAudioAttachmentSnapshot {
  readonly attachmentId: string;
  readonly displayName: string;
  readonly declaredMimeType: string;
  readonly sourceBytes: number;
  readonly sourceSha256: string;
}

/** Local media validation/normalization contract. It must not use a network. */
export interface FileAudioMedia {
  /** One exact sanitized buffer reused by A, B, and local DSP. */
  readonly bytes: Uint8Array;
  readonly format: "mp3" | "wav";
  readonly mimeType: "audio/mpeg" | "audio/wav";
  readonly sanitizedSha256?: string;
  readonly durationMs?: number;
  readonly sampleRateHz?: number;
  readonly channels?: number;
}

export interface FileAudioMediaModule {
  inspect(input: {
    readonly attachment: FileAudioAttachmentSnapshot;
    readonly bytes: Uint8Array;
    readonly signal: AbortSignal;
  }): Promise<FileAudioMedia>;
}

export interface FileAudioAdapterRequest {
  readonly arm: "A" | "B";
  readonly binding: Readonly<FileAudioExperimentBinding>;
  readonly attachment: FileAudioAttachmentSnapshot;
  readonly media: FileAudioMedia;
  readonly signal: AbortSignal;
}

export interface FileAudioProviderMetadata {
  readonly responseId: string;
  readonly model: string;
  readonly usage: Readonly<{
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  }> | null;
}

/** Internal direct-audio result. Arm and implementation never enter the public tool result. */
export interface FileAudioDirectResult {
  readonly arm: "A" | "B";
  readonly implementation: string;
  readonly response: AudioExperimentDirectResponse;
  readonly provider: FileAudioProviderMetadata;
  /** Opaque production-only execution context; stripped before every public release. */
  readonly internalContext?: object;
}

export interface FileAudioResultImage {
  readonly label: string;
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/** Internal deterministic DSP artifact source for isolated synthesis, not an outer Arm C response. */
export interface FileAudioDspArtifact {
  readonly implementation: string;
  readonly numericText: string;
  readonly metadata: unknown;
  readonly images: readonly FileAudioResultImage[];
}

export interface FileAudioBlindedCandidate {
  readonly label: string;
  readonly result: FileAudioDirectResult;
}

export interface FileAudioSynthesisResult {
  readonly response: AudioExperimentSynthesisResponse;
  readonly provider: FileAudioProviderMetadata;
}

export interface FileAudioSynthesisModule {
  synthesize(input: {
    readonly candidates: readonly [FileAudioBlindedCandidate, FileAudioBlindedCandidate];
    readonly dsp: FileAudioDspArtifact;
    readonly signal: AbortSignal;
  }): Promise<FileAudioSynthesisResult>;
}

/** Provider adapters implement A (Wren capsule) or B (neutral comparator). */
export interface FileAudioAdapter {
  readonly arm: "A" | "B";
  analyze(input: FileAudioAdapterRequest): Promise<FileAudioDirectResult>;
}

/** Hash-checks all A/B instructions, the shared task, and schema before either provider use. */
export interface FileAudioProviderPromptModule {
  prepare(input: {
    readonly media: FileAudioMedia;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

/** Deterministic, local-only DSP implementation used as synthesis artifacts. */
export interface FileAudioDspModule {
  analyze(input: {
    readonly binding: Readonly<FileAudioExperimentBinding>;
    readonly attachment: FileAudioAttachmentSnapshot;
    readonly media: FileAudioMedia;
    readonly signal: AbortSignal;
  }): Promise<FileAudioDspArtifact>;
}

export interface FileAudioExperimentDependencies {
  readonly media: FileAudioMediaModule;
  readonly providerPrompts: FileAudioProviderPromptModule;
  readonly wrenAdapter: FileAudioAdapter;
  readonly neutralAdapter: FileAudioAdapter;
  readonly dsp: FileAudioDspModule;
  readonly synthesis: FileAudioSynthesisModule;
}

export interface FileAudioExperimentPermit {
  readonly permitId: string;
  readonly binding: Readonly<FileAudioExperimentBinding>;
  readonly turn: BrowserTurnProvenance;
  readonly attachment: FileAudioAttachmentSnapshot;
  readonly arms: readonly ["A", "B", "C"];
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface FileAudioExperimentPreview {
  readonly permit_id: string;
  readonly attachment: FileAudioAttachmentSnapshot;
  readonly arms: readonly ["A", "B", "C"];
  readonly expires_at: string;
  readonly warning: string;
}

export interface FileAudioPublicCandidate {
  readonly label: string;
  readonly response: AudioExperimentDirectResponse;
  readonly provider: FileAudioProviderMetadata;
}

export interface FileAudioPublicDsp {
  readonly numericText: string;
  readonly metadata: unknown;
  readonly artifacts: readonly {
    readonly label: string;
    readonly mimeType: "image/png";
    readonly width: number;
    readonly height: number;
    readonly byteLength: number;
    readonly sha256: string;
  }[];
}

export interface FileAudioExecutedAnalysis {
  readonly candidates: readonly [FileAudioPublicCandidate, FileAudioPublicCandidate];
  readonly synthesis: FileAudioSynthesisResult;
  readonly dsp: FileAudioPublicDsp;
}

export interface FileAudioExperimentRuntime {
  readonly tool: ToolDefinition;
  readonly binding: Readonly<FileAudioExperimentBinding>;
  preflight(): { allowed: true } | { allowed: false; reason: string };
  close(): Promise<void>;
}
