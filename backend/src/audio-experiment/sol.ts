export const SOL_SYNTHESIS_MODEL = "gpt-5.6-sol" as const;
export const SOL_CHAT_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions" as const;
const REQUIRED_MODEL = SOL_SYNTHESIS_MODEL;
const OFFICIAL_ENDPOINT = SOL_CHAT_COMPLETIONS_ENDPOINT;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
const MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1_024;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const DEFAULT_MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_INSTRUCTIONS_CHARS = 32_000;
const MAX_SCHEMA_CHARS = 64_000;
const MAX_CANDIDATE_BYTES = 256 * 1024;
const MAX_DSP_BYTES = 16 * 1024;
const MAX_DSP_FIELDS = 128;
const MAX_PNG_BYTES = 1024 * 1024;
const MAX_TOTAL_PNG_BYTES = 3 * MAX_PNG_BYTES;
const MAX_TEXT_CHARS = 256_000;
const MAX_IDENTIFIER_CHARS = 512;
const OPAQUE_LABEL = /^[a-f0-9]{32}$/;
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type SolArtifactTransport = (endpoint: string, init: RequestInit) => Promise<Response>;
export type SolResponseValidator<T> = (text: string) => T;

export interface SolCandidateArtifact {
  /** Caller-generated random 128-bit lowercase hexadecimal label. */
  label: string;
  /** An already-validated, JSON-compatible candidate response. */
  response: Record<string, unknown>;
}

export interface SolPngArtifact {
  /** Raw PNG bytes. Base64 and data URLs are deliberately not accepted here. */
  bytes: Uint8Array;
  detail?: "auto" | "low" | "high";
}

export interface SolArtifactSynthesisRequest {
  synthesisInstructions: string;
  responseSchemaText: string;
  candidates: readonly [SolCandidateArtifact, SolCandidateArtifact];
  /** Bounded numeric text from DSP, or a flat map of finite numeric measurements. */
  dspNumericMetadata: string | Readonly<Record<string, number>>;
  images?: readonly SolPngArtifact[];
  signal?: AbortSignal;
}

export interface SolUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface SolResultBase {
  responseId: string;
  model: string;
  usage: SolUsage | null;
}

export interface SolRawTextResult extends SolResultBase {
  kind: "raw_text";
  text: string;
}

export interface SolValidatedResult<T> extends SolResultBase {
  kind: "validated";
  value: T;
}

export type SolArtifactSynthesisResult<T> = SolRawTextResult | SolValidatedResult<T>;

export interface SolArtifactSynthesisAdapterConfig<T = never> {
  /** Must be the exact official HTTPS Chat Completions endpoint. */
  endpoint: typeof OFFICIAL_ENDPOINT;
  /** The adapter accepts only the exact synthesis model. */
  model: typeof REQUIRED_MODEL;
  apiKey: string;
  /** No global network fallback exists; production and tests must inject transport. */
  transport: SolArtifactTransport;
  /**
   * Integration should inject the response-schema validator when available (for example,
   * a closure around response.ts's parseAudioExperimentResponseText with expected options).
   */
  responseValidator?: SolResponseValidator<T>;
  timeoutMs?: number;
  maxOutputTokens?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
}

export interface SolArtifactSynthesisAdapter<T = never> {
  synthesize(request: SolArtifactSynthesisRequest): Promise<SolArtifactSynthesisResult<T>>;
}

export type SolArtifactSynthesisErrorCode =
  | "invalid_configuration"
  | "invalid_request"
  | "aborted"
  | "timeout"
  | "transport_error"
  | "http_error"
  | "request_too_large"
  | "response_too_large"
  | "invalid_response";

/** Messages are fixed and never include artifacts, credentials, paths, or provider bodies. */
export class SolArtifactSynthesisError extends Error {
  readonly code: SolArtifactSynthesisErrorCode;

  constructor(code: SolArtifactSynthesisErrorCode, message: string) {
    super(message);
    this.name = "SolArtifactSynthesisError";
    this.code = code;
  }
}

interface ValidatedConfig<T> {
  endpoint: typeof OFFICIAL_ENDPOINT;
  model: typeof REQUIRED_MODEL;
  apiKey: string;
  transport: SolArtifactTransport;
  responseValidator?: SolResponseValidator<T>;
  timeoutMs: number;
  maxOutputTokens: number;
  maxResponseBytes: number;
  maxRequestBytes: number;
}

interface ParsedCompletion {
  responseId: string;
  model: string;
  text: string;
  usage: SolUsage | null;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Isolated artifact-only Chat Completions adapter. It has no source-audio or file-path input,
 * never logs, and converts PNG bytes to data URLs only while constructing the transport body.
 */
export function createSolArtifactSynthesisAdapter<T = never>(
  config: SolArtifactSynthesisAdapterConfig<T>,
): SolArtifactSynthesisAdapter<T> {
  const fixed = validateConfig(config);

  return {
    async synthesize(request: SolArtifactSynthesisRequest): Promise<SolArtifactSynthesisResult<T>> {
      const body = buildRequestBody(request, fixed);
      if (request.signal?.aborted) throw redactedError("aborted");

      const controller = new AbortController();
      let abortReason: "caller" | "timeout" | undefined;
      const onCallerAbort = (): void => {
        if (abortReason === undefined) {
          abortReason = "caller";
          controller.abort();
        }
      };
      request.signal?.addEventListener("abort", onCallerAbort, { once: true });
      const timer = setTimeout(() => {
        if (abortReason === undefined) {
          abortReason = "timeout";
          controller.abort();
        }
      }, fixed.timeoutMs);

      try {
        const operation = requestAndParse(fixed, body, controller.signal);
        const aborted = new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(redactedError(abortReason === "timeout" ? "timeout" : "aborted")),
            { once: true },
          );
        });
        const parsed = await Promise.race([operation, aborted]);
        if (fixed.responseValidator === undefined) {
          return {
            kind: "raw_text",
            responseId: parsed.responseId,
            model: parsed.model,
            text: parsed.text,
            usage: parsed.usage,
          };
        }
        let value: T;
        try {
          value = fixed.responseValidator(parsed.text);
        } catch {
          throw redactedError("invalid_response");
        }
        return {
          kind: "validated",
          responseId: parsed.responseId,
          model: parsed.model,
          value,
          usage: parsed.usage,
        };
      } catch (error: unknown) {
        if (abortReason === "timeout") throw redactedError("timeout");
        if (abortReason === "caller" || request.signal?.aborted) throw redactedError("aborted");
        if (error instanceof SolArtifactSynthesisError) throw error;
        throw redactedError("transport_error");
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}

function buildRequestBody<T>(request: SolArtifactSynthesisRequest, config: ValidatedConfig<T>): string {
  validateRequestShape(request);
  const instructions = boundedArtifactText(
    request.synthesisInstructions,
    MAX_INSTRUCTIONS_CHARS,
    true,
  );
  const schema = boundedArtifactText(request.responseSchemaText, MAX_SCHEMA_CHARS);
  const candidates = request.candidates.map((candidate) => ({
    label: validateOpaqueLabel(candidate.label),
    response: sanitizeCandidate(candidate.response),
  }));
  if (candidates[0].label === candidates[1].label) throw redactedError("invalid_request");
  candidates.sort((left, right) => left.label.localeCompare(right.label));

  const dsp = sanitizeDspMetadata(request.dspNumericMetadata);
  const images = sanitizeImages(request.images ?? []);
  const artifactText = JSON.stringify({
    response_schema: schema,
    candidate_responses: Object.fromEntries(
      candidates.map((candidate) => [candidate.label, candidate.response]),
    ),
    dsp_numeric_metadata: dsp,
  });

  const userContent: Array<Record<string, unknown>> = [{ type: "text", text: artifactText }];
  for (const image of images) {
    userContent.push({
      type: "image_url",
      image_url: {
        url: `data:image/png;base64,${Buffer.from(image.bytes).toString("base64")}`,
        detail: image.detail,
      },
    });
  }

  const body = JSON.stringify({
    model: config.model,
    store: false,
    modalities: ["text"],
    max_completion_tokens: config.maxOutputTokens,
    messages: [
      { role: "developer", content: instructions },
      { role: "user", content: userContent },
    ],
  });
  if (Buffer.byteLength(body) > config.maxRequestBytes) throw redactedError("request_too_large");
  return body;
}

async function requestAndParse<T>(
  config: ValidatedConfig<T>,
  body: string,
  signal: AbortSignal,
): Promise<ParsedCompletion> {
  let response: Response;
  try {
    response = await config.transport(config.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body,
      signal,
    });
  } catch {
    throw redactedError("transport_error");
  }

  const responseText = await readBoundedResponse(response, config.maxResponseBytes);
  if (!response.ok) throw redactedError("http_error");

  let value: unknown;
  try {
    value = JSON.parse(responseText);
  } catch {
    throw redactedError("invalid_response");
  }
  return parseCompletion(value);
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    response.body?.cancel().catch(() => undefined);
    throw redactedError("response_too_large");
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw redactedError("response_too_large");
      }
      chunks.push(value);
    }
  } catch (error: unknown) {
    if (error instanceof SolArtifactSynthesisError) throw error;
    throw redactedError("transport_error");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseCompletion(value: unknown): ParsedCompletion {
  if (!isRecord(value)) throw redactedError("invalid_response");
  const responseId = boundedResponseString(value.id, 1, MAX_IDENTIFIER_CHARS);
  const model = boundedResponseString(value.model, 1, MAX_IDENTIFIER_CHARS);
  if (!Array.isArray(value.choices) || value.choices.length < 1 || value.choices.length > 16) {
    throw redactedError("invalid_response");
  }
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) throw redactedError("invalid_response");
  const text = boundedResponseString(first.message.content, 0, MAX_TEXT_CHARS);

  let usage: SolUsage | null = null;
  if (value.usage !== undefined && value.usage !== null) {
    if (!isRecord(value.usage)) throw redactedError("invalid_response");
    usage = {
      promptTokens: safeTokenCount(value.usage.prompt_tokens),
      completionTokens: safeTokenCount(value.usage.completion_tokens),
      totalTokens: safeTokenCount(value.usage.total_tokens),
    };
  }
  return { responseId, model, text, usage };
}

function validateConfig<T>(config: SolArtifactSynthesisAdapterConfig<T>): ValidatedConfig<T> {
  if (!isRecord(config) || config.endpoint !== OFFICIAL_ENDPOINT || config.model !== REQUIRED_MODEL) {
    throw redactedError("invalid_configuration");
  }
  if (typeof config.transport !== "function") throw redactedError("invalid_configuration");
  if (
    typeof config.apiKey !== "string" ||
    config.apiKey.length === 0 ||
    config.apiKey.length > 16_384 ||
    /[\r\n]/.test(config.apiKey)
  ) {
    throw redactedError("invalid_configuration");
  }
  if (config.responseValidator !== undefined && typeof config.responseValidator !== "function") {
    throw redactedError("invalid_configuration");
  }

  return {
    endpoint: OFFICIAL_ENDPOINT,
    model: REQUIRED_MODEL,
    apiKey: config.apiKey,
    transport: config.transport,
    ...(config.responseValidator ? { responseValidator: config.responseValidator } : {}),
    timeoutMs: boundedInteger(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS),
    maxOutputTokens: boundedInteger(
      config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      1,
      MAX_OUTPUT_TOKENS,
    ),
    maxResponseBytes: boundedInteger(
      config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      1,
      MAX_RESPONSE_BYTES,
    ),
    maxRequestBytes: boundedInteger(
      config.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      1,
      MAX_REQUEST_BYTES,
    ),
  };
}

function validateRequestShape(request: SolArtifactSynthesisRequest): void {
  if (!isRecord(request) || !hasOnlyKeys(request, [
    "synthesisInstructions",
    "responseSchemaText",
    "candidates",
    "dspNumericMetadata",
    "images",
    "signal",
  ])) {
    throw redactedError("invalid_request");
  }
  if (!Array.isArray(request.candidates) || request.candidates.length !== 2) {
    throw redactedError("invalid_request");
  }
  for (const candidate of request.candidates) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ["label", "response"])) {
      throw redactedError("invalid_request");
    }
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
    throw redactedError("invalid_request");
  }
}

function boundedArtifactText(value: unknown, maxChars: number, rejectIdentity = false): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxChars) {
    throw redactedError("invalid_request");
  }
  if (rejectIdentity) assertCandidateTextSafe(value);
  else assertNoPrivatePath(value);
  return value;
}

function validateOpaqueLabel(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE_LABEL.test(value)) throw redactedError("invalid_request");
  return value;
}

function sanitizeCandidate(value: unknown): { [key: string]: JsonValue } {
  if (!isRecord(value)) throw redactedError("invalid_request");
  const state = { nodes: 0 };
  const sanitized = sanitizeJson(value, 0, state);
  if (!isJsonObject(sanitized) || Buffer.byteLength(JSON.stringify(sanitized)) > MAX_CANDIDATE_BYTES) {
    throw redactedError("invalid_request");
  }
  return sanitized;
}

function sanitizeJson(value: unknown, depth: number, state: { nodes: number }): JsonValue {
  state.nodes += 1;
  if (depth > 16 || state.nodes > 4_096) throw redactedError("invalid_request");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw redactedError("invalid_request");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 64_000) throw redactedError("invalid_request");
    assertCandidateTextSafe(value);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw redactedError("invalid_request");
    return value.map((entry) => sanitizeJson(entry, depth + 1, state));
  }
  if (!isRecord(value)) throw redactedError("invalid_request");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw redactedError("invalid_request");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length > 128) throw redactedError("invalid_request");
  const result: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor) || key.length === 0 || key.length > 128 || forbiddenArtifactKey(key)) {
      throw redactedError("invalid_request");
    }
    result[key] = sanitizeJson(descriptor.value, depth + 1, state);
  }
  return result;
}

function sanitizeDspMetadata(value: unknown): string | Record<string, number> {
  if (typeof value === "string") {
    if (
      value.trim().length === 0 ||
      Buffer.byteLength(value) > MAX_DSP_BYTES ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
      /[A-Za-z0-9+/_-]{512,}={0,2}/u.test(value)
    ) {
      throw redactedError("invalid_request");
    }
    assertNoPrivatePath(value);
    return value;
  }
  if (!isRecord(value)) throw redactedError("invalid_request");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw redactedError("invalid_request");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length > MAX_DSP_FIELDS) throw redactedError("invalid_request");
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const key of keys.sort()) {
    const descriptor = descriptors[key];
    if (
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      key.length === 0 ||
      key.length > 64 ||
      !/^[a-z][a-z0-9_.-]*$/.test(key) ||
      forbiddenArtifactKey(key) ||
      typeof descriptor.value !== "number" ||
      !Number.isFinite(descriptor.value)
    ) {
      throw redactedError("invalid_request");
    }
    result[key] = descriptor.value;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_DSP_BYTES) throw redactedError("invalid_request");
  return result;
}

function sanitizeImages(value: readonly SolPngArtifact[]): SolPngArtifact[] {
  if (!Array.isArray(value) || value.length > 3) throw redactedError("invalid_request");
  let totalBytes = 0;
  return value.map((image) => {
    if (!isRecord(image) || !hasOnlyKeys(image, ["bytes", "detail"])) {
      throw redactedError("invalid_request");
    }
    if (!(image.bytes instanceof Uint8Array) || image.bytes.byteLength > MAX_PNG_BYTES) {
      throw redactedError("invalid_request");
    }
    if (image.bytes.byteLength < PNG_SIGNATURE.length) throw redactedError("invalid_request");
    for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
      if (image.bytes[index] !== PNG_SIGNATURE[index]) throw redactedError("invalid_request");
    }
    const detail = image.detail;
    if (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high") {
      throw redactedError("invalid_request");
    }
    totalBytes += image.bytes.byteLength;
    if (totalBytes > MAX_TOTAL_PNG_BYTES) throw redactedError("invalid_request");
    return { bytes: new Uint8Array(image.bytes), detail: detail ?? "auto" };
  });
}

function forbiddenArtifactKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return /^(?:(?:arm|candidate|variant)(?:_|$)|(?:raw_|source_)?audio(?:_|$)|source_(?:arm|identity|file)$|api_key$|authorization$|bearer$|cookie$|credential(?:s)?$|password$|private_path$|secret$|session_key$|(?:access_|refresh_)?token$)/.test(normalized);
}

function assertNoPrivatePath(value: string): void {
  if (/(?:^|[\s"'`(])(?:\/(?:etc|home|media|mnt|opt|root|run|srv|tmp|users|var)(?:\/|\b)|[a-z]:\\|\\\\[^\\]+\\)/i.test(value)) {
    throw redactedError("invalid_request");
  }
}

function assertCandidateTextSafe(value: string): void {
  assertNoPrivatePath(value);
  if (
    /\barm[\s:_-]*[abc123]\b/i.test(value) ||
    /\bcandidate[\s:_-]*[ab12]\b/i.test(value) ||
    /\bA\s*\/\s*B\b/.test(value) ||
    value.trim() === "A" ||
    value.trim() === "B"
  ) {
    throw redactedError("invalid_request");
  }
}

function boundedInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw redactedError("invalid_configuration");
  }
  return value as number;
}

function safeTokenCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw redactedError("invalid_response");
  return value as number;
}

function boundedResponseString(value: unknown, minLength: number, maxLength: number): string {
  if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
    throw redactedError("invalid_response");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function redactedError(code: SolArtifactSynthesisErrorCode): SolArtifactSynthesisError {
  const messages: Record<SolArtifactSynthesisErrorCode, string> = {
    invalid_configuration: "Invalid Sol synthesis adapter configuration.",
    invalid_request: "Invalid Sol synthesis request.",
    aborted: "Sol synthesis request was aborted.",
    timeout: "Sol synthesis request timed out.",
    transport_error: "Sol synthesis transport failed.",
    http_error: "Sol synthesis request failed.",
    request_too_large: "Sol synthesis request exceeded its size limit.",
    response_too_large: "Sol synthesis response exceeded its size limit.",
    invalid_response: "Sol synthesis response was invalid.",
  };
  return new SolArtifactSynthesisError(code, messages[code]);
}
