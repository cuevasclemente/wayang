import { createHash } from "node:crypto";
import {
  DEFAULT_MEDIA_PROCESS_TIMEOUT_MS,
  DEFAULT_PROCESS_STDERR_BYTES,
  DEFAULT_PROCESS_STDOUT_BYTES,
  localProcessExecutor,
  probeAudioPath,
  runProcessChecked,
  validateAudioBytes,
  withMediaWorkspace,
  type AudioValidation,
  type FfprobeAudioMetadata,
  type MediaCleanupMetadata,
  type ProcessExecutor,
  type SupportedAudioFormat,
} from "./media.js";

export const ARM_C_WAVEFORM_SIZE = "1200x240";
export const ARM_C_VISUAL_SIZE = "1200x600";
export const DEFAULT_MAX_DERIVATIVE_BYTES = 8 * 1024 * 1024;
export const MAX_ARM_C_NUMERIC_TEXT_BYTES = 16 * 1024;

export interface ArmCRepresentationOptions {
  maxBytes: number;
  maxDerivativeBytes?: number;
  tempRoot?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  executor?: ProcessExecutor;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ArmCImageRepresentation {
  mimeType: "image/png";
  width: number;
  height: number;
  bytes: Buffer;
  byteLength: number;
  sha256: string;
}

export interface ArmCRepresentations {
  sourceFormat: SupportedAudioFormat;
  sanitizedSha256: string;
  validation: AudioValidation;
  ffprobe: FfprobeAudioMetadata;
  waveform: ArmCImageRepresentation;
  spectrogram: ArmCImageRepresentation;
  frequencyVisual: ArmCImageRepresentation & { kind: "cqt" | "showfreqs" };
  numericText: string;
  cleanup: MediaCleanupMetadata;
}

function requirePositiveBound(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
}

function processOptions(
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  stderrBytes = DEFAULT_PROCESS_STDERR_BYTES,
) {
  return {
    cwd,
    timeoutMs,
    maxStdoutBytes: DEFAULT_PROCESS_STDOUT_BYTES,
    maxStderrBytes: stderrBytes,
    ...(signal ? { signal } : {}),
  };
}

function visualArguments(inputPath: string, outputPath: string, filter: string): readonly string[] {
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-filter_complex", filter,
    "-map", "[v]",
    "-frames:v", "1", "-an", "-sn", "-dn",
    "-threads", "1", "-c:v", "png", "-compression_level", "9", "-pred", "mixed",
    "-f", "image2", outputPath,
  ];
}

function assertPng(bytes: Buffer): void {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error("ffmpeg did not produce a PNG derivative");
  }
}

function imageRepresentation(bytes: Buffer, width: number, height: number): ArmCImageRepresentation {
  assertPng(bytes);
  return {
    mimeType: "image/png",
    width,
    height,
    bytes,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function normalizeAnalysisLines(text: string, expressions: readonly RegExp[], maxLines: number, maxBytes: number): string {
  const selected: string[] = [];
  let usedBytes = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\[[^\]]+\]\s*/, "").trim().replace(/\s+/g, " ");
    if (!line || !expressions.some((expression) => expression.test(line))) continue;
    const bounded = line.slice(0, 512);
    const bytes = Buffer.byteLength(`${bounded}\n`);
    if (selected.length >= maxLines || usedBytes + bytes > maxBytes) break;
    selected.push(bounded);
    usedBytes += bytes;
  }
  return selected.join("\n");
}

const ASTATS_LINES = [
  /(?:^|\s)(?:DC offset|Min level|Max level|Min difference|Max difference|Mean difference|RMS difference|Peak level dB|RMS level dB|RMS peak dB|RMS trough dB|Crest factor|Flat factor|Peak count|Noise floor dB|Noise floor count|Entropy|Bit depth|Dynamic range|Zero crossings|Zero crossings rate|Number of samples):/i,
];
const LOUDNESS_LINES = [
  /^(?:Integrated loudness|Loudness range|True peak|Summary):/i,
  /^(?:I|Threshold|LRA|LRA low|LRA high|Peak):\s*[-+a-z0-9.]/i,
];

function buildNumericText(
  validation: AudioValidation,
  metadata: FfprobeAudioMetadata,
  astatsStderr: Buffer,
  loudnessStderr: Buffer,
): string {
  const header = [
    "Deterministic local audio measurements",
    `format=${validation.format}`,
    `codec=${metadata.codecName}`,
    `duration_seconds=${metadata.durationSeconds.toFixed(6)}`,
    `sample_rate_hz=${metadata.sampleRateHz}`,
    `channels=${metadata.channels}`,
    `audio_data_bytes=${validation.audioDataBytes}`,
    `container_bytes=${validation.byteLength}`,
    ...(metadata.bitRate === undefined ? [] : [`bit_rate=${metadata.bitRate}`]),
  ].join("\n");
  const astats = normalizeAnalysisLines(astatsStderr.toString("utf8"), ASTATS_LINES, 128, 8 * 1024);
  const loudness = normalizeAnalysisLines(loudnessStderr.toString("utf8"), LOUDNESS_LINES, 64, 4 * 1024);
  const text = `${header}\n\n[ffmpeg astats]\n${astats || "No aggregate astats values reported"}\n\n[ffmpeg ebur128]\n${loudness || "No loudness summary reported"}\n`;
  if (Buffer.byteLength(text) > MAX_ARM_C_NUMERIC_TEXT_BYTES) throw new Error("Arm-C numeric text exceeded its byte limit");
  return text;
}

/**
 * Generate bounded deterministic local arm-C inputs from already-sanitized MP3/WAVE bytes.
 * No source pathname is accepted, so this function cannot delete the caller's source.
 */
export async function generateArmCRepresentations(
  sanitizedAudio: Uint8Array,
  options: ArmCRepresentationOptions,
): Promise<ArmCRepresentations> {
  const validation = validateAudioBytes(sanitizedAudio, options.maxBytes);
  const sourceBytes = Buffer.from(sanitizedAudio);
  const maxDerivativeBytes = options.maxDerivativeBytes ?? DEFAULT_MAX_DERIVATIVE_BYTES;
  requirePositiveBound(maxDerivativeBytes, "maxDerivativeBytes");
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEDIA_PROCESS_TIMEOUT_MS;
  requirePositiveBound(timeoutMs, "timeoutMs");
  const executor = options.executor ?? localProcessExecutor;
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const ffprobePath = options.ffprobePath ?? "ffprobe";

  const result = await withMediaWorkspace(options.tempRoot, async (workspace) => {
    const inputName = `sanitized.${validation.format}`;
    const inputPath = workspace.writePrivateFile(inputName, sourceBytes);
    const waveformName = "waveform.png";
    const spectrogramName = "spectrogram.png";
    const frequencyName = "frequency.png";
    const waveformPath = workspace.preparePrivateOutput(waveformName);
    const spectrogramPath = workspace.preparePrivateOutput(spectrogramName);
    const frequencyPath = workspace.preparePrivateOutput(frequencyName);
    const ffprobe = await probeAudioPath(inputPath, validation, {
      executor,
      ffprobePath,
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (Object.keys(ffprobe.tags).length !== 0) throw new Error("Arm-C input must be sanitized before representation generation");

    await runProcessChecked(executor, ffmpegPath, visualArguments(
      inputPath,
      waveformPath,
      `[0:a:0]aformat=channel_layouts=mono,showwavespic=s=${ARM_C_WAVEFORM_SIZE}:colors=white:scale=lin[v]`,
    ), processOptions(workspace.directory, timeoutMs, options.signal));

    await runProcessChecked(executor, ffmpegPath, visualArguments(
      inputPath,
      spectrogramPath,
      `[0:a:0]showspectrumpic=s=${ARM_C_VISUAL_SIZE}:legend=0:color=intensity:scale=log:win_func=hann[v]`,
    ), processOptions(workspace.directory, timeoutMs, options.signal));

    let frequencyKind: "cqt" | "showfreqs" = "cqt";
    try {
      await runProcessChecked(executor, ffmpegPath, visualArguments(
        inputPath,
        frequencyPath,
        `[0:a:0]showcqt=s=${ARM_C_VISUAL_SIZE}:fps=1:count=1[v]`,
      ), processOptions(workspace.directory, timeoutMs, options.signal));
    } catch (error) {
      if (options.signal?.aborted || !(error instanceof Error) || !error.message.startsWith("Media process failed")) throw error;
      frequencyKind = "showfreqs";
      await runProcessChecked(executor, ffmpegPath, visualArguments(
        inputPath,
        frequencyPath,
        `[0:a:0]showfreqs=s=${ARM_C_VISUAL_SIZE}:mode=line:ascale=log:fscale=log:win_func=hann[v]`,
      ), processOptions(workspace.directory, timeoutMs, options.signal));
    }

    const astats = await runProcessChecked(executor, ffmpegPath, [
      "-hide_banner", "-nostdin", "-loglevel", "info", "-threads", "1",
      "-i", inputPath,
      "-map", "0:a:0", "-vn", "-sn", "-dn",
      "-af", "astats=metadata=0:reset=0",
      "-f", "null", "-",
    ], processOptions(workspace.directory, timeoutMs, options.signal, 192 * 1024));

    const loudness = await runProcessChecked(executor, ffmpegPath, [
      "-hide_banner", "-nostdin", "-loglevel", "info", "-threads", "1",
      "-i", inputPath,
      "-map", "0:a:0", "-vn", "-sn", "-dn",
      "-af", "ebur128=peak=true:framelog=quiet",
      "-f", "null", "-",
    ], processOptions(workspace.directory, timeoutMs, options.signal, 128 * 1024));

    const waveformBytes = workspace.readPrivateFile(waveformName, maxDerivativeBytes);
    const spectrogramBytes = workspace.readPrivateFile(spectrogramName, maxDerivativeBytes);
    const frequencyBytes = workspace.readPrivateFile(frequencyName, maxDerivativeBytes);
    return {
      sourceFormat: validation.format,
      sanitizedSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      validation,
      ffprobe,
      waveform: imageRepresentation(waveformBytes, 1200, 240),
      spectrogram: imageRepresentation(spectrogramBytes, 1200, 600),
      frequencyVisual: { ...imageRepresentation(frequencyBytes, 1200, 600), kind: frequencyKind },
      numericText: buildNumericText(validation, ffprobe, astats.stderr, loudness.stderr),
    };
  });
  return { ...result.value, cleanup: result.cleanup };
}
