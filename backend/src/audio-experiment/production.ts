import { createHash, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FileAudioExperimentConfig } from "../config.js";
import { installProductionFileAudioExperimentDependencies } from "../pi-bridge.js";
import { generateArmCRepresentations } from "./dsp.js";
import { sanitizeAudio, validateAudioBytes } from "./media.js";
import { declaredFileAudioFormat } from "./path.js";
import {
  createOpenAiFileAudioAdapter,
  type OpenAiAudioTransport,
} from "./openai.js";
import {
  assertNoAudioExperimentPromptEcho,
  parseSynthesisAudioExperimentResponseText,
  type AudioExperimentSynthesisResponse,
} from "./response.js";
import {
  createSolArtifactSynthesisAdapter,
  SOL_CHAT_COMPLETIONS_ENDPOINT,
  SOL_SYNTHESIS_MODEL,
  type SolArtifactTransport,
} from "./sol.js";
import type {
  FileAudioAdapter,
  FileAudioDspModule,
  FileAudioExperimentDependencies,
  FileAudioMediaModule,
  FileAudioProviderMetadata,
} from "./types.js";

export const FILE_AUDIO_OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions" as const;
export const FILE_AUDIO_OPENAI_MODEL = "gpt-audio-1.5" as const;
const MAX_PRIVATE_PROMPT_BYTES = 16 * 1024;
const MAX_COMBINED_PROMPT_CHARS = 32_000;
const MAX_DSP_PNG_BYTES = 1024 * 1024;

export interface FileAudioProductionPorts {
  /** A/B transport. `transport` remains as a compatibility alias for synthetic tests. */
  readonly audioTransport?: OpenAiAudioTransport;
  readonly solTransport?: SolArtifactTransport;
  readonly transport?: OpenAiAudioTransport;
  readonly resolveOpenAiApiKey?: () => string | undefined;
  readonly readPrivatePrompt?: (absolutePath: string, maxBytes: number) => Buffer;
  readonly sanitize?: typeof sanitizeAudio;
  readonly generateArmC?: typeof generateArmCRepresentations;
}

export interface FileAudioExperimentProductionBootstrap {
  close(): Promise<void>;
}

interface ProductionPorts {
  readonly audioTransport: OpenAiAudioTransport;
  readonly solTransport: SolArtifactTransport;
  readonly resolveOpenAiApiKey: () => string | undefined;
  readonly readPrivatePrompt: (absolutePath: string, maxBytes: number) => Buffer;
  readonly sanitize: typeof sanitizeAudio;
  readonly generateArmC: typeof generateArmCRepresentations;
}

function fixedProductionError(message: string): Error {
  return new Error(`File-audio production ${message}`);
}

/** No-follow owner-private prompt read. Error text never includes the path. */
export function readPrivateFileAudioPrompt(absolutePath: string, maxBytes = MAX_PRIVATE_PROMPT_BYTES): Buffer {
  if (!path.isAbsolute(absolutePath) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PRIVATE_PROMPT_BYTES) {
    throw fixedProductionError("prompt configuration is invalid");
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    const parent = fs.lstatSync(path.dirname(absolutePath));
    if (!parent.isDirectory() || parent.isSymbolicLink()
      || (typeof process.getuid === "function" && parent.uid !== process.getuid())
      || (process.platform !== "win32" && (parent.mode & 0o077) !== 0)) {
      throw fixedProductionError("private prompt validation failed");
    }
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes
      || (typeof process.getuid === "function" && before.uid !== process.getuid())
      || (process.platform !== "win32" && (before.mode & 0o077) !== 0)) {
      throw fixedProductionError("private prompt validation failed");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw fixedProductionError("private prompt validation failed");
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("File-audio production ")) throw error;
    throw fixedProductionError("private prompt validation failed");
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); }
      catch { throw fixedProductionError("private prompt validation failed"); }
    }
  }
}

function decodePrompt(bytes: Buffer): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw fixedProductionError("private prompt validation failed"); }
  if (!text.trim() || text.length > MAX_PRIVATE_PROMPT_BYTES || /\u0000/u.test(text)) {
    throw fixedProductionError("private prompt validation failed");
  }
  return text;
}

function digestMatches(bytes: Buffer, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(expected)) return false;
  const actual = createHash("sha256").update(bytes).digest();
  const frozen = Buffer.from(expected, "hex");
  return frozen.length === actual.length && timingSafeEqual(actual, frozen);
}

type PrivateArtifactName = "Wren capsule" | "shared task" | "neutral adapter" | "response schema" | "Sol synthesis prompt";

interface LoadedDirectPrompt {
  readonly instructions: string;
  readonly task: string;
  readonly schemaText: string;
  readonly privateFragments: readonly string[];
}

interface ProviderPromptCache {
  readonly context: object;
  readonly prompts: Partial<Record<"A" | "B", LoadedDirectPrompt>>;
  readonly apiKeys: string[];
  readonly privateTokens: string[];
}

function configuredArtifacts(config: Readonly<FileAudioExperimentConfig>) {
  return [
    { name: "Wren capsule" as const, configuredPath: config.wrenCapsulePath, sha256: config.wrenCapsuleSha256 },
    { name: "shared task" as const, configuredPath: config.sharedTaskPath, sha256: config.sharedTaskSha256 },
    { name: "neutral adapter" as const, configuredPath: config.neutralAdapterPath, sha256: config.neutralAdapterSha256 },
    { name: "response schema" as const, configuredPath: config.responseSchemaPath, sha256: config.responseSchemaSha256 },
    { name: "Sol synthesis prompt" as const, configuredPath: config.solSynthesisPromptPath, sha256: config.solSynthesisPromptSha256 },
  ];
}

function configuredPrivatePaths(config: Readonly<FileAudioExperimentConfig>): readonly string[] {
  return [
    ...configuredArtifacts(config).map((artifact) => artifact.configuredPath),
    config.mediaTempRoot,
    ...(path.isAbsolute(config.ffmpegPath) ? [config.ffmpegPath] : []),
    ...(path.isAbsolute(config.ffprobePath) ? [config.ffprobePath] : []),
  ].filter((value) => value.length > 0);
}

function validateArtifactConfiguration(config: Readonly<FileAudioExperimentConfig>): void {
  const artifacts = configuredArtifacts(config);
  if (artifacts.some((artifact) => !path.isAbsolute(artifact.configuredPath) || !/^[a-f0-9]{64}$/u.test(artifact.sha256))) {
    throw fixedProductionError("prompt configuration is invalid");
  }
  const resolved = artifacts.map((artifact) => path.resolve(artifact.configuredPath));
  if (new Set(resolved).size !== resolved.length) throw fixedProductionError("prompt configuration is invalid");
}

function loadArtifact(
  config: Readonly<FileAudioExperimentConfig>,
  ports: Pick<ProductionPorts, "readPrivatePrompt">,
  name: PrivateArtifactName,
): string {
  validateArtifactConfiguration(config);
  const artifact = configuredArtifacts(config).find((entry) => entry.name === name)!;
  const bytes = ports.readPrivatePrompt(artifact.configuredPath, MAX_PRIVATE_PROMPT_BYTES);
  if (!digestMatches(bytes, artifact.sha256)) throw fixedProductionError(`${name} digest mismatch`);
  return decodePrompt(bytes);
}

function loadDirectPrompts(
  config: Readonly<FileAudioExperimentConfig>,
  ports: Pick<ProductionPorts, "readPrivatePrompt">,
): ProviderPromptCache {
  try {
    const capsule = loadArtifact(config, ports, "Wren capsule");
    const task = loadArtifact(config, ports, "shared task");
    const neutral = loadArtifact(config, ports, "neutral adapter");
    const schemaText = loadArtifact(config, ports, "response schema");
    if (capsule.length + task.length + schemaText.length > MAX_COMBINED_PROMPT_CHARS
      || neutral.length + task.length + schemaText.length > MAX_COMBINED_PROMPT_CHARS) {
      throw fixedProductionError("combined prompt exceeds its bound");
    }
    return {
      context: Object.freeze({}),
      prompts: {
        A: Object.freeze({ instructions: capsule, task, schemaText, privateFragments: [capsule, task, schemaText] }),
        B: Object.freeze({ instructions: neutral, task, schemaText, privateFragments: [neutral, task, schemaText] }),
      },
      apiKeys: [],
      privateTokens: [],
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("File-audio production ")) throw error;
    throw fixedProductionError("private prompt validation failed");
  }
}

function loadSolArtifacts(
  config: Readonly<FileAudioExperimentConfig>,
  ports: Pick<ProductionPorts, "readPrivatePrompt">,
  forbiddenTokens: readonly string[],
): { instructions: string; schemaText: string } {
  try {
    const instructions = loadArtifact(config, ports, "Sol synthesis prompt");
    // Re-open and re-hash the schema after A, B, and DSP; do not trust the A/B cache.
    const schemaText = loadArtifact(config, ports, "response schema");
    const forbidden = [...configuredPrivatePaths(config), ...forbiddenTokens];
    if (forbidden.some((value) => value.length > 0 && (instructions.includes(value) || schemaText.includes(value)))) {
      throw fixedProductionError("synthesis artifacts failed disclosure checks");
    }
    return Object.freeze({ instructions, schemaText });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("File-audio production ")) throw error;
    throw fixedProductionError("private prompt validation failed");
  }
}

function safeProviderValue(value: unknown, forbidden: readonly string[]): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string" || forbidden.some((token) => token.length > 0 && text.includes(token))) {
    throw fixedProductionError("provider response failed disclosure checks");
  }
}

function resolveKey(ports: ProductionPorts): string {
  let apiKey: string | undefined;
  try { apiKey = ports.resolveOpenAiApiKey(); }
  catch { throw fixedProductionError("OpenAI credential is unavailable"); }
  if (typeof apiKey !== "string" || apiKey.length === 0) throw fixedProductionError("OpenAI credential is unavailable");
  return apiKey;
}

function providerMetadata(value: {
  responseId: string;
  model: string;
  usage: FileAudioProviderMetadata["usage"];
}): FileAudioProviderMetadata {
  return Object.freeze({ responseId: value.responseId, model: value.model, usage: value.usage });
}

function createProductionAdapter(options: {
  arm: "A" | "B";
  config: Readonly<FileAudioExperimentConfig>;
  ports: ProductionPorts;
  cache: WeakMap<object, ProviderPromptCache>;
}): FileAudioAdapter {
  return Object.freeze({
    arm: options.arm,
    async analyze(request: Parameters<FileAudioAdapter["analyze"]>[0]) {
      if (request.arm !== options.arm || request.signal.aborted) throw fixedProductionError("adapter request was revoked");
      const cache = options.cache.get(request.media);
      const loaded = cache?.prompts[options.arm];
      if (!cache || !loaded) throw fixedProductionError("provider prompts were not prepared");

      const exactBytes = Buffer.isBuffer(request.media.bytes)
        ? request.media.bytes
        : Buffer.from(request.media.bytes.buffer, request.media.bytes.byteOffset, request.media.bytes.byteLength);
      const audioBase64 = exactBytes.toString("base64");
      if (!cache.privateTokens.includes(audioBase64)) cache.privateTokens.push(audioBase64);
      // Resolve the credential only after all request artifacts are ready and immediately before use.
      const apiKey = resolveKey(options.ports);
      if (!cache.apiKeys.includes(apiKey)) cache.apiKeys.push(apiKey);
      const adapter = createOpenAiFileAudioAdapter({
        endpoint: FILE_AUDIO_OPENAI_ENDPOINT,
        model: FILE_AUDIO_OPENAI_MODEL,
        apiKey,
        transport: options.ports.audioTransport,
      });
      const provider = await adapter.analyze({
        mode: options.arm,
        instructions: loaded.instructions,
        task: loaded.task,
        schemaText: loaded.schemaText,
        audio: { format: request.media.format, base64: audioBase64 },
        signal: request.signal,
      });
      const forbidden = [apiKey, audioBase64, ...configuredPrivatePaths(options.config), ...loaded.privateFragments];
      safeProviderValue(provider.response, forbidden);
      safeProviderValue(provider.responseId, forbidden);
      safeProviderValue(provider.model, forbidden);
      const result = Object.freeze({
        arm: options.arm,
        implementation: options.arm === "A" ? "wren-gpt-audio-1.5" : "neutral-gpt-audio-1.5",
        response: provider.response,
        provider: providerMetadata(provider),
        internalContext: cache.context,
      });
      return result;
    },
  });
}

/** Construct closures only. No prompt/key/file/process/network operation occurs here. */
export function createFileAudioExperimentProductionDependencies(
  sourceConfig: Readonly<FileAudioExperimentConfig>,
  injected: FileAudioProductionPorts = {},
): FileAudioExperimentDependencies {
  const config = Object.freeze({ ...sourceConfig });
  const fallbackTransport = injected.transport ?? ((endpoint: string, init: RequestInit) => globalThis.fetch(endpoint, init));
  const ports: ProductionPorts = Object.freeze({
    audioTransport: injected.audioTransport ?? fallbackTransport,
    solTransport: injected.solTransport ?? fallbackTransport,
    resolveOpenAiApiKey: injected.resolveOpenAiApiKey ?? (() => process.env.OPENAI_API_KEY),
    readPrivatePrompt: injected.readPrivatePrompt ?? readPrivateFileAudioPrompt,
    sanitize: injected.sanitize ?? sanitizeAudio,
    generateArmC: injected.generateArmC ?? generateArmCRepresentations,
  });

  const media: FileAudioMediaModule = Object.freeze({
    async inspect({ attachment, bytes, signal }: Parameters<FileAudioMediaModule["inspect"]>[0]) {
      try {
        const structural = validateAudioBytes(bytes, 20 * 1024 * 1024);
        if (structural.format !== declaredFileAudioFormat(attachment.declaredMimeType)) throw new Error("format mismatch");
      } catch {
        throw fixedProductionError("source must be actual MP3 or RIFF/WAVE matching its declared MIME type");
      }
      let sanitized: Awaited<ReturnType<typeof sanitizeAudio>>;
      try {
        sanitized = await ports.sanitize(bytes, {
          maxBytes: 20 * 1024 * 1024,
          tempRoot: config.mediaTempRoot,
          ffmpegPath: config.ffmpegPath,
          ffprobePath: config.ffprobePath,
          signal,
        });
      } catch {
        throw fixedProductionError(signal.aborted ? "audio sanitation was revoked" : "audio sanitation failed safely");
      }
      const sanitizedSha256 = createHash("sha256").update(sanitized.bytes).digest("hex");
      if (sanitized.sourceSha256 !== attachment.sourceSha256
        || sanitized.sha256 !== sanitizedSha256 || sanitized.byteLength !== sanitized.bytes.byteLength) {
        throw fixedProductionError("sanitized audio provenance mismatch");
      }
      return Object.freeze({
        bytes: sanitized.bytes,
        format: sanitized.format,
        mimeType: sanitized.format === "mp3" ? "audio/mpeg" as const : "audio/wav" as const,
        sanitizedSha256,
        durationMs: sanitized.validation.durationSeconds * 1_000,
        sampleRateHz: sanitized.validation.sampleRateHz,
        channels: sanitized.validation.channels,
      });
    },
  });

  const promptCache = new WeakMap<object, ProviderPromptCache>();
  const contextCache = new WeakMap<object, ProviderPromptCache>();
  const providerPrompts = Object.freeze({
    async prepare(request: Parameters<FileAudioExperimentDependencies["providerPrompts"]["prepare"]>[0]) {
      if (request.signal.aborted) throw fixedProductionError("provider prompt preparation was revoked");
      const loaded = loadDirectPrompts(config, ports);
      promptCache.set(request.media, loaded);
      contextCache.set(loaded.context, loaded);
    },
  });

  const dsp: FileAudioDspModule = Object.freeze({
    async analyze(request: Parameters<FileAudioDspModule["analyze"]>[0]) {
      if (request.signal.aborted) throw fixedProductionError("DSP request was revoked");
      let representation: Awaited<ReturnType<typeof generateArmCRepresentations>>;
      try {
        representation = await ports.generateArmC(request.media.bytes, {
          maxBytes: 20 * 1024 * 1024,
          maxDerivativeBytes: MAX_DSP_PNG_BYTES,
          tempRoot: config.mediaTempRoot,
          ffmpegPath: config.ffmpegPath,
          ffprobePath: config.ffprobePath,
          signal: request.signal,
        });
      } catch {
        throw fixedProductionError(request.signal.aborted ? "DSP request was revoked" : "DSP generation failed safely");
      }
      if (representation.sourceFormat !== request.media.format
        || representation.sanitizedSha256 !== request.media.sanitizedSha256) {
        throw fixedProductionError("DSP source provenance mismatch");
      }
      return Object.freeze({
        implementation: "deterministic-local-dsp",
        numericText: representation.numericText,
        metadata: {
          source_format: representation.sourceFormat,
          sanitized_sha256: representation.sanitizedSha256,
          validation: representation.validation,
          ffprobe: {
            format_name: representation.ffprobe.formatName,
            duration_seconds: representation.ffprobe.durationSeconds,
            size_bytes: representation.ffprobe.sizeBytes,
            bit_rate: representation.ffprobe.bitRate ?? null,
            codec_name: representation.ffprobe.codecName,
            sample_rate_hz: representation.ffprobe.sampleRateHz,
            channels: representation.ffprobe.channels,
          },
        },
        images: Object.freeze([
          { label: "waveform", ...representation.waveform },
          { label: "spectrogram", ...representation.spectrogram },
          { label: `frequency-${representation.frequencyVisual.kind}`, ...representation.frequencyVisual },
        ]),
      });
    },
  });

  const synthesis = Object.freeze({
    async synthesize(request: Parameters<FileAudioExperimentDependencies["synthesis"]["synthesize"]>[0]) {
      if (request.signal.aborted) throw fixedProductionError("synthesis was revoked");
      const context = request.candidates[0].result.internalContext;
      const executionCache = context ? contextCache.get(context) : undefined;
      if (!executionCache || request.candidates[1].result.internalContext !== context) {
        throw fixedProductionError("provider prompts were not prepared");
      }
      const privateSecretTokens = [
        ...executionCache.apiKeys,
        ...executionCache.privateTokens,
      ];
      const directPromptFragments = Object.values(executionCache.prompts)
        .flatMap((loaded) => loaded?.privateFragments ?? []);
      const artifacts = loadSolArtifacts(config, ports, privateSecretTokens);
      const apiKey = resolveKey(ports);
      const promptSources = {
        instructions: artifacts.instructions,
        task: "Synthesize only the supplied opaque candidate reports and local DSP artifacts.",
        schemaText: artifacts.schemaText,
      };
      const adapter = createSolArtifactSynthesisAdapter<AudioExperimentSynthesisResponse>({
        endpoint: SOL_CHAT_COMPLETIONS_ENDPOINT,
        model: SOL_SYNTHESIS_MODEL,
        apiKey,
        transport: ports.solTransport,
        responseValidator(text) {
          assertNoAudioExperimentPromptEcho(text, promptSources);
          const parsed = parseSynthesisAudioExperimentResponseText(text);
          assertNoAudioExperimentPromptEcho(JSON.stringify(parsed), promptSources);
          return parsed;
        },
      });
      const result = await adapter.synthesize({
        synthesisInstructions: artifacts.instructions,
        responseSchemaText: artifacts.schemaText,
        candidates: request.candidates.map((candidate) => ({
          label: candidate.label,
          response: candidate.result.response as unknown as Record<string, unknown>,
        })) as unknown as [
          { label: string; response: Record<string, unknown> },
          { label: string; response: Record<string, unknown> },
        ],
        dspNumericMetadata: request.dsp.numericText,
        images: request.dsp.images.map((image) => ({ bytes: image.bytes, detail: "auto" as const })),
        signal: request.signal,
      });
      if (result.kind !== "validated") throw fixedProductionError("synthesis response was not validated");
      const forbidden = [
        apiKey,
        ...privateSecretTokens,
        ...directPromptFragments,
        artifacts.instructions,
        artifacts.schemaText,
      ];
      safeProviderValue(result.value, forbidden);
      safeProviderValue(result.responseId, forbidden);
      safeProviderValue(result.model, forbidden);
      return Object.freeze({
        response: result.value,
        provider: providerMetadata(result),
      });
    },
  });

  return Object.freeze({
    media,
    providerPrompts,
    wrenAdapter: createProductionAdapter({ arm: "A", config, ports, cache: promptCache }),
    neutralAdapter: createProductionAdapter({ arm: "B", config, ports, cache: promptCache }),
    dsp,
    synthesis,
  });
}

/** Startup composition is deliberately lazy even when installed while disabled. */
export function bootstrapFileAudioExperimentProduction(
  config: Readonly<FileAudioExperimentConfig>,
  ports: FileAudioProductionPorts = {},
): FileAudioExperimentProductionBootstrap {
  const dependencies = createFileAudioExperimentProductionDependencies(config, ports);
  const uninstall = installProductionFileAudioExperimentDependencies(dependencies);
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      uninstall();
    },
  };
}
