import {
  assertNoAudioExperimentPromptEcho,
  parseDirectAudioExperimentResponseText,
  type AudioExperimentDirectResponse,
} from "./response.js";

const REQUIRED_MODEL = "gpt-audio-1.5" as const;
const REQUIRED_ENDPOINT = "https://api.openai.com/v1/chat/completions" as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;
const MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1_024;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_AUDIO_BYTES = 20 * 1_024 * 1_024;
const MAX_PROMPT_CHARS = 32_000;
const MAX_TEXT_CHARS = 256_000;
const MAX_IDENTIFIER_CHARS = 512;

export type OpenAiAudioPromptMode = "A" | "B";
export type OpenAiAudioFormat = "mp3" | "wav";

export interface OpenAiAudioTransport {
  (endpoint: string, init: RequestInit): Promise<Response>;
}

export interface OpenAiFileAudioAdapterConfig {
  /** Must be the fixed official HTTPS Chat Completions endpoint. */
  endpoint: typeof REQUIRED_ENDPOINT;
  /** The adapter deliberately accepts only gpt-audio-1.5. */
  model: typeof REQUIRED_MODEL;
  apiKey: string;
  /** Inject global fetch in production or a fake transport in tests. */
  transport: OpenAiAudioTransport;
  timeoutMs?: number;
  maxOutputTokens?: number;
  maxResponseBytes?: number;
}

export interface OpenAiFileAudioRequest {
  /** Local arm metadata. It is validated but is not sent to the provider. */
  mode: OpenAiAudioPromptMode;
  /** Adapter/capsule instructions sent only with the developer role. */
  instructions: string;
  /** Shared task sent as its own user text part. */
  task: string;
  /** Response schema sent as a separate user text part. */
  schemaText: string;
  audio: {
    format: OpenAiAudioFormat;
    /** Raw base64 only; data URLs are rejected. */
    base64: string;
  };
  signal?: AbortSignal;
}

export interface OpenAiFileAudioUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface OpenAiFileAudioResult {
  responseId: string;
  model: string;
  response: AudioExperimentDirectResponse;
  usage: OpenAiFileAudioUsage | null;
}

export type OpenAiFileAudioErrorCode =
  | "invalid_configuration"
  | "invalid_request"
  | "aborted"
  | "timeout"
  | "transport_error"
  | "http_error"
  | "response_too_large"
  | "invalid_response";

/** Error messages never contain request bodies, audio, keys, or provider response bodies. */
export class OpenAiFileAudioError extends Error {
  readonly code: OpenAiFileAudioErrorCode;

  constructor(code: OpenAiFileAudioErrorCode, message: string) {
    super(message);
    this.name = "OpenAiFileAudioError";
    this.code = code;
  }
}

export interface OpenAiFileAudioAdapter {
  analyze(request: OpenAiFileAudioRequest): Promise<OpenAiFileAudioResult>;
}

interface ValidatedConfig {
  endpoint: string;
  model: typeof REQUIRED_MODEL;
  apiKey: string;
  transport: OpenAiAudioTransport;
  timeoutMs: number;
  maxOutputTokens: number;
  maxResponseBytes: number;
}

/**
 * Creates the isolated Chat Completions adapter used by experiment arms A/B.
 * It never uses the Files API, requests generated audio, or logs provider data.
 */
export function createOpenAiFileAudioAdapter(
  config: OpenAiFileAudioAdapterConfig,
): OpenAiFileAudioAdapter {
  const fixed = validateConfig(config);

  return {
    async analyze(request: OpenAiFileAudioRequest): Promise<OpenAiFileAudioResult> {
      validateRequest(request);
      if (request.signal?.aborted) {
        throw redactedError("aborted");
      }

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

      const body = JSON.stringify({
        model: fixed.model,
        store: false,
        modalities: ["text"],
        max_completion_tokens: fixed.maxOutputTokens,
        messages: [
          {
            role: "developer",
            content: request.instructions,
          },
          {
            role: "user",
            content: [
              { type: "text", text: request.task },
              { type: "text", text: request.schemaText },
              {
                type: "input_audio",
                input_audio: {
                  data: request.audio.base64,
                  format: request.audio.format,
                },
              },
            ],
          },
        ],
      });

      try {
        const operation = requestAndParse(fixed, request, body, controller.signal);
        const aborted = new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(redactedError(abortReason === "timeout" ? "timeout" : "aborted")),
            { once: true },
          );
        });
        return await Promise.race([operation, aborted]);
      } catch (error: unknown) {
        if (abortReason === "timeout") {
          throw redactedError("timeout");
        }
        if (abortReason === "caller" || request.signal?.aborted) {
          throw redactedError("aborted");
        }
        if (error instanceof OpenAiFileAudioError) {
          throw error;
        }
        throw redactedError("transport_error");
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}

async function requestAndParse(
  config: ValidatedConfig,
  request: OpenAiFileAudioRequest,
  body: string,
  signal: AbortSignal,
): Promise<OpenAiFileAudioResult> {
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
  if (!response.ok) {
    throw new OpenAiFileAudioError(
      "http_error",
      `OpenAI audio request failed with HTTP status ${response.status}.`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(responseText);
  } catch {
    throw redactedError("invalid_response");
  }
  try {
    return parseResponse(value, request);
  } catch (error: unknown) {
    if (error instanceof OpenAiFileAudioError) throw error;
    throw redactedError("invalid_response");
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    return "";
  }

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
    if (error instanceof OpenAiFileAudioError) throw error;
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

function parseResponse(
  value: unknown,
  request: OpenAiFileAudioRequest,
): OpenAiFileAudioResult {
  if (!isRecord(value)) throw redactedError("invalid_response");
  const responseId = boundedString(value.id, 1, MAX_IDENTIFIER_CHARS);
  const model = boundedString(value.model, 1, MAX_IDENTIFIER_CHARS);
  if (!Array.isArray(value.choices) || value.choices.length < 1 || value.choices.length > 16) {
    throw redactedError("invalid_response");
  }
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw redactedError("invalid_response");
  }
  const text = boundedString(first.message.content, 1, MAX_TEXT_CHARS);
  assertNoAudioExperimentPromptEcho(text, {
    instructions: request.instructions,
    task: request.task,
    schemaText: request.schemaText,
  });
  const response = parseDirectAudioExperimentResponseText(text);
  assertNoAudioExperimentPromptEcho(collectResponseStrings(response), {
    instructions: request.instructions,
    task: request.task,
    schemaText: request.schemaText,
  });

  let usage: OpenAiFileAudioUsage | null = null;
  if (value.usage !== undefined && value.usage !== null) {
    if (!isRecord(value.usage)) throw redactedError("invalid_response");
    usage = {
      promptTokens: safeTokenCount(value.usage.prompt_tokens),
      completionTokens: safeTokenCount(value.usage.completion_tokens),
      totalTokens: safeTokenCount(value.usage.total_tokens),
    };
  }

  return { responseId, model, response, usage };
}

function collectResponseStrings(value: unknown): string {
  const strings: string[] = [];
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") {
      strings.push(entry);
    } else if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
    } else if (isRecord(entry)) {
      for (const item of Object.values(entry)) visit(item);
    }
  };
  visit(value);
  return strings.join("\n");
}

function validateConfig(config: OpenAiFileAudioAdapterConfig): ValidatedConfig {
  if (
    !isRecord(config) ||
    config.model !== REQUIRED_MODEL ||
    typeof config.transport !== "function"
  ) {
    throw redactedError("invalid_configuration");
  }
  if (
    typeof config.apiKey !== "string" ||
    config.apiKey.length === 0 ||
    config.apiKey.length > 16_384 ||
    /[\r\n]/.test(config.apiKey)
  ) {
    throw redactedError("invalid_configuration");
  }
  if (typeof config.endpoint !== "string" || config.endpoint.length > 2_048) {
    throw redactedError("invalid_configuration");
  }

  let url: URL;
  try {
    url = new URL(config.endpoint);
  } catch {
    throw redactedError("invalid_configuration");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.toString() !== REQUIRED_ENDPOINT
  ) {
    throw redactedError("invalid_configuration");
  }

  return {
    endpoint: REQUIRED_ENDPOINT,
    model: config.model,
    apiKey: config.apiKey,
    transport: config.transport,
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
  };
}

function validateRequest(request: OpenAiFileAudioRequest): void {
  if (!isRecord(request) || !isRecord(request.audio)) {
    throw redactedError("invalid_request");
  }
  assertExactRequestKeys(request, ["mode", "instructions", "task", "schemaText", "audio", "signal"]);
  assertExactRequestKeys(request.audio, ["format", "base64"]);
  if (request.mode !== "A" && request.mode !== "B") {
    throw redactedError("invalid_request");
  }
  for (const text of [request.instructions, request.task, request.schemaText]) {
    if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_PROMPT_CHARS
      || /\u0000/u.test(text)) {
      throw redactedError("invalid_request");
    }
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
    throw redactedError("invalid_request");
  }
  if (request.audio.format !== "mp3" && request.audio.format !== "wav") {
    throw redactedError("invalid_request");
  }
  if (!isBoundedBase64(request.audio.base64, MAX_AUDIO_BYTES)) {
    throw redactedError("invalid_request");
  }
}

function assertExactRequestKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw redactedError("invalid_request");
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw redactedError("invalid_request");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw redactedError("invalid_request");
    }
  }
}

function isBoundedBase64(value: unknown, maxBytes: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding <= maxBytes;
}

function boundedInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw redactedError("invalid_configuration");
  }
  return value as number;
}

function safeTokenCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw redactedError("invalid_response");
  }
  return value as number;
}

function boundedString(value: unknown, minLength: number, maxLength: number): string {
  if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
    throw redactedError("invalid_response");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactedError(code: OpenAiFileAudioErrorCode): OpenAiFileAudioError {
  const messages: Record<OpenAiFileAudioErrorCode, string> = {
    invalid_configuration: "Invalid OpenAI audio adapter configuration.",
    invalid_request: "Invalid OpenAI audio request.",
    aborted: "OpenAI audio request was aborted.",
    timeout: "OpenAI audio request timed out.",
    transport_error: "OpenAI audio transport failed.",
    http_error: "OpenAI audio request failed.",
    response_too_large: "OpenAI audio response exceeded its size limit.",
    invalid_response: "OpenAI audio response was invalid.",
  };
  return new OpenAiFileAudioError(code, messages[code]);
}
