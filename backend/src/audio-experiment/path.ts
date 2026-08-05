import { createHash, randomBytes } from "node:crypto";
import { readRegisteredAttachment } from "../attachments.js";
import {
  parseDirectAudioExperimentResponse,
  parseSynthesisAudioExperimentResponse,
} from "./response.js";
import {
  FILE_AUDIO_EXPERIMENT_ARMS,
  type FileAudioAttachmentSnapshot,
  type FileAudioDirectResult,
  type FileAudioDspArtifact,
  type FileAudioExecutedAnalysis,
  type FileAudioExperimentBinding,
  type FileAudioExperimentDependencies,
  type FileAudioProviderMetadata,
  type FileAudioResultImage,
} from "./types.js";

export const MAX_FILE_AUDIO_EXPERIMENT_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_AUDIO_RESULT_BYTES = 256 * 1024;
export const MAX_FILE_AUDIO_IMAGE_BYTES = 1024 * 1024;
export const MAX_FILE_AUDIO_TOTAL_IMAGE_BYTES = 3 * MAX_FILE_AUDIO_IMAGE_BYTES;
export const MAX_FILE_AUDIO_DSP_TEXT_BYTES = 16 * 1024;

const MP3_MIME_TYPES = new Set(["audio/mpeg", "audio/mp3"]);
const WAV_MIME_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function declaredFileAudioFormat(mimeType: string): "mp3" | "wav" | null {
  const normalized = mimeType.toLowerCase();
  if (MP3_MIME_TYPES.has(normalized)) return "mp3";
  if (WAV_MIME_TYPES.has(normalized)) return "wav";
  return null;
}

/** The retained helper accepts only the complete canonical topology. */
export function normalizeFileAudioArms(raw: unknown): readonly ["A", "B", "C"] {
  if (raw === undefined) return FILE_AUDIO_EXPERIMENT_ARMS;
  if (!Array.isArray(raw) || raw.length !== FILE_AUDIO_EXPERIMENT_ARMS.length
    || raw.some((arm, index) => arm !== FILE_AUDIO_EXPERIMENT_ARMS[index])) {
    throw new Error("File-audio experiment always requires the complete A/B/C topology");
  }
  return FILE_AUDIO_EXPERIMENT_ARMS;
}

export function assertPreviewableAudioAttachment(attachment: FileAudioAttachmentSnapshot): void {
  if (!declaredFileAudioFormat(attachment.declaredMimeType)) {
    throw new Error("Attachment must be declared as MP3 or RIFF/WAVE audio");
  }
  if (!Number.isSafeInteger(attachment.sourceBytes) || attachment.sourceBytes <= 0
    || attachment.sourceBytes > MAX_FILE_AUDIO_EXPERIMENT_BYTES) {
    throw new Error("Attachment exceeds the file-audio experiment byte bound");
  }
  if (!/^[a-f0-9]{64}$/u.test(attachment.sourceSha256)) {
    throw new Error("Attachment provenance digest is invalid");
  }
}

function containsBinary(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return true;
  if (!value || typeof value !== "object") return false;
  if (depth > 16) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsBinary(entry, seen, depth + 1));
  return Object.values(value as Record<string, unknown>).some((entry) => containsBinary(entry, seen, depth + 1));
}

function boundedProvider(provider: FileAudioProviderMetadata): FileAudioProviderMetadata {
  if (!provider || typeof provider.responseId !== "string" || provider.responseId.length < 1 || provider.responseId.length > 512
    || typeof provider.model !== "string" || provider.model.length < 1 || provider.model.length > 512
    || !publicJsonSafe(provider.responseId) || !publicJsonSafe(provider.model)) {
    throw new Error("File-audio provider metadata is invalid");
  }
  let usage: FileAudioProviderMetadata["usage"] = null;
  if (provider.usage !== null) {
    const values = [provider.usage?.promptTokens, provider.usage?.completionTokens, provider.usage?.totalTokens];
    if (values.some((value) => !Number.isSafeInteger(value) || (value as number) < 0)) {
      throw new Error("File-audio provider metadata is invalid");
    }
    usage = Object.freeze({ ...provider.usage });
  }
  return Object.freeze({ responseId: provider.responseId, model: provider.model, usage });
}

function boundedDirect(result: FileAudioDirectResult, arm: "A" | "B"): FileAudioDirectResult {
  if (!result || result.arm !== arm || typeof result.implementation !== "string"
    || result.implementation.length < 1 || result.implementation.length > 256) {
    throw new Error(`File-audio arm ${arm} returned an invalid result`);
  }
  const response = parseDirectAudioExperimentResponse(result.response);
  if (!publicJsonSafe(response) || Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_FILE_AUDIO_RESULT_BYTES) {
    throw new Error(`File-audio arm ${arm} exceeded the result bound`);
  }
  return Object.freeze({
    arm,
    implementation: result.implementation,
    response,
    provider: boundedProvider(result.provider),
    ...(result.internalContext && typeof result.internalContext === "object"
      ? { internalContext: result.internalContext }
      : {}),
  });
}

function boundedImage(image: FileAudioResultImage, labels: Set<string>): FileAudioResultImage {
  if (!image || image.mimeType !== "image/png" || typeof image.label !== "string"
    || image.label.length < 1 || image.label.length > 128 || labels.has(image.label)
    || !Number.isSafeInteger(image.width) || image.width < 1 || image.width > 4096
    || !Number.isSafeInteger(image.height) || image.height < 1 || image.height > 4096
    || !(image.bytes instanceof Uint8Array) || image.bytes.byteLength < PNG_SIGNATURE.length
    || image.bytes.byteLength > MAX_FILE_AUDIO_IMAGE_BYTES) {
    throw new Error("File-audio DSP returned an invalid PNG artifact");
  }
  labels.add(image.label);
  const bytes = Buffer.from(image.bytes);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("File-audio DSP returned a non-PNG artifact");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (image.sha256 !== sha256) throw new Error("File-audio DSP PNG digest mismatch");
  return Object.freeze({ ...image, bytes, sha256 });
}

function publicJsonSafe(value: unknown): boolean {
  if (containsBinary(value)) return false;
  const visit = (entry: unknown, depth = 0): boolean => {
    if (depth > 12) return false;
    if (typeof entry === "string") {
      return entry.length <= 16_384
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(entry)
        && !/(?:^|[\s"'`(])(?:\/(?:etc|home|media|mnt|opt|root|run|srv|tmp|users|var)(?:\/|\b)|[a-z]:\\|\\\\[^\\]+\\)/iu.test(entry)
        && !/[A-Za-z0-9+/_-]{512,}={0,2}/u.test(entry);
    }
    if (entry === null || typeof entry === "boolean") return true;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (Array.isArray(entry)) return entry.length <= 256 && entry.every((item) => visit(item, depth + 1));
    if (!entry || typeof entry !== "object") return false;
    const object = entry as Record<string, unknown>;
    return Object.keys(object).length <= 128 && Object.entries(object).every(([key, item]) =>
      !/^(?:arm|implementation|api_?key|authorization|raw_?audio|audio_?base64|host_?path|private_?prompt)$/iu.test(key)
      && visit(item, depth + 1));
  };
  return visit(value);
}

function boundedDsp(artifact: FileAudioDspArtifact): FileAudioDspArtifact {
  if (!artifact || typeof artifact.implementation !== "string" || artifact.implementation.length < 1
    || typeof artifact.numericText !== "string" || !artifact.numericText.trim()
    || Buffer.byteLength(artifact.numericText, "utf8") > MAX_FILE_AUDIO_DSP_TEXT_BYTES
    || !publicJsonSafe(artifact.numericText) || !publicJsonSafe(artifact.metadata)
    || Buffer.byteLength(JSON.stringify(artifact.metadata), "utf8") > MAX_FILE_AUDIO_DSP_TEXT_BYTES
    || !Array.isArray(artifact.images) || artifact.images.length !== 3) {
    throw new Error("File-audio DSP returned invalid bounded synthesis artifacts");
  }
  const labels = new Set<string>();
  let total = 0;
  const images = artifact.images.map((image) => {
    const bounded = boundedImage(image, labels);
    total += bounded.bytes.byteLength;
    if (total > MAX_FILE_AUDIO_TOTAL_IMAGE_BYTES) throw new Error("File-audio DSP exceeded the PNG artifact bound");
    return bounded;
  });
  return Object.freeze({
    implementation: artifact.implementation,
    numericText: artifact.numericText,
    metadata: JSON.parse(JSON.stringify(artifact.metadata)),
    images: Object.freeze(images),
  });
}

function opaqueLabel(): string {
  return randomBytes(16).toString("hex");
}

function assertUnmutated(mediaBytes: Uint8Array, digest: string, stage: string): void {
  if (createHash("sha256").update(mediaBytes).digest("hex") !== digest) {
    throw new Error(`File-audio ${stage} mutated the shared sanitized audio`);
  }
}

/** Reopen/revalidate the upload, then run the complete A→B→DSP→isolated-Sol topology. */
export async function executeFileAudioExperimentPath(options: {
  binding: Readonly<FileAudioExperimentBinding>;
  attachment: FileAudioAttachmentSnapshot;
  dependencies: FileAudioExperimentDependencies;
  signal: AbortSignal;
  assertCurrent(): void;
}): Promise<FileAudioExecutedAnalysis> {
  assertPreviewableAudioAttachment(options.attachment);
  if (options.dependencies.wrenAdapter.arm !== "A" || options.dependencies.neutralAdapter.arm !== "B") {
    throw new Error("File-audio experiment adapters are not assigned to their exact arms");
  }
  if (options.signal.aborted) throw new Error("File-audio experiment execution was revoked");
  options.assertCurrent();

  const reopened = readRegisteredAttachment(
    options.binding.sourceSessionId,
    options.attachment.attachmentId,
    MAX_FILE_AUDIO_EXPERIMENT_BYTES,
  );
  if (reopened.record.sourceSha256 !== options.attachment.sourceSha256
    || reopened.record.sourceBytes !== options.attachment.sourceBytes
    || reopened.record.declaredMimeType !== options.attachment.declaredMimeType) {
    throw new Error("Attachment provenance changed after preview");
  }

  options.assertCurrent();
  const media = await options.dependencies.media.inspect({
    attachment: options.attachment,
    bytes: reopened.bytes,
    signal: options.signal,
  });
  if (options.signal.aborted) throw new Error("File-audio experiment execution was revoked");
  const declaredFormat = declaredFileAudioFormat(options.attachment.declaredMimeType);
  if (!media || !(media.bytes instanceof Uint8Array) || media.bytes.byteLength === 0
    || media.bytes.byteLength > MAX_FILE_AUDIO_EXPERIMENT_BYTES
    || (media.format !== "mp3" && media.format !== "wav") || media.format !== declaredFormat
    || media.mimeType !== (media.format === "mp3" ? "audio/mpeg" : "audio/wav")
    || (media.sanitizedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(media.sanitizedSha256))
    || (media.durationMs !== undefined && (!Number.isFinite(media.durationMs) || media.durationMs <= 0 || media.durationMs > 86_400_000))
    || (media.sampleRateHz !== undefined && (!Number.isSafeInteger(media.sampleRateHz) || media.sampleRateHz < 1 || media.sampleRateHz > 384_000))
    || (media.channels !== undefined && (!Number.isSafeInteger(media.channels) || media.channels < 1 || media.channels > 8))) {
    throw new Error("Media module returned an invalid bounded audio representation");
  }
  const mediaDigest = createHash("sha256").update(media.bytes).digest("hex");
  if (media.sanitizedSha256 !== undefined && media.sanitizedSha256 !== mediaDigest) {
    throw new Error("Media module returned a mismatched sanitized-audio digest");
  }

  options.assertCurrent();
  await options.dependencies.providerPrompts.prepare({ media, signal: options.signal });
  if (options.signal.aborted) throw new Error("File-audio experiment execution was revoked");

  options.assertCurrent();
  const armA = boundedDirect(await options.dependencies.wrenAdapter.analyze({
    arm: "A", binding: options.binding, attachment: options.attachment, media, signal: options.signal,
  }), "A");
  if (options.signal.aborted) throw new Error("File-audio experiment execution was revoked");
  assertUnmutated(media.bytes, mediaDigest, "arm A");

  options.assertCurrent();
  const armB = boundedDirect(await options.dependencies.neutralAdapter.analyze({
    arm: "B", binding: options.binding, attachment: options.attachment, media, signal: options.signal,
  }), "B");
  if (options.signal.aborted) throw new Error("File-audio experiment execution was revoked");
  assertUnmutated(media.bytes, mediaDigest, "arm B");

  options.assertCurrent();
  const dsp = boundedDsp(await options.dependencies.dsp.analyze({
    binding: options.binding, attachment: options.attachment, media, signal: options.signal,
  }));
  if (options.signal.aborted) throw new Error("File-audio experiment execution was revoked");
  assertUnmutated(media.bytes, mediaDigest, "DSP");

  let firstLabel = opaqueLabel();
  let secondLabel = opaqueLabel();
  while (secondLabel === firstLabel) secondLabel = opaqueLabel();
  const paired = [
    Object.freeze({ label: firstLabel, result: armA }),
    Object.freeze({ label: secondLabel, result: armB }),
  ] as const;
  const candidates = (randomBytes(1)[0]! & 1 ? [paired[1], paired[0]] : [paired[0], paired[1]]) as unknown as readonly [typeof paired[0], typeof paired[1]];

  options.assertCurrent();
  const synthesis = await options.dependencies.synthesis.synthesize({
    candidates,
    dsp,
    signal: options.signal,
  });
  if (options.signal.aborted) throw new Error("File-audio experiment execution was revoked");
  options.assertCurrent();
  const synthesisResponse = parseSynthesisAudioExperimentResponse(synthesis.response);
  if (!publicJsonSafe(synthesisResponse)
    || Buffer.byteLength(JSON.stringify(synthesisResponse), "utf8") > MAX_FILE_AUDIO_RESULT_BYTES) {
    throw new Error("File-audio synthesis returned an unsafe public result");
  }
  const publicCandidates = candidates.map((candidate) => Object.freeze({
    label: candidate.label,
    response: candidate.result.response,
    provider: candidate.result.provider,
  })) as unknown as FileAudioExecutedAnalysis["candidates"];
  const publicDsp = Object.freeze({
    numericText: dsp.numericText,
    metadata: dsp.metadata,
    artifacts: Object.freeze(dsp.images.map((image) => Object.freeze({
      label: image.label,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      byteLength: image.bytes.byteLength,
      sha256: image.sha256,
    }))),
  });
  return Object.freeze({
    candidates: Object.freeze(publicCandidates) as FileAudioExecutedAnalysis["candidates"],
    synthesis: Object.freeze({ response: synthesisResponse, provider: boundedProvider(synthesis.provider) }),
    dsp: publicDsp,
  });
}
