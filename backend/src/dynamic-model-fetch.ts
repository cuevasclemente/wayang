/**
 * Bounded retry/backoff for Wayang's direct provider HTTP fetches.
 *
 * These calls refresh provider model catalogs (Together, OpenRouter, Anthropic)
 * outside the pi SDK, so they never traverse pi's assistant-level retry gate.
 * Transient network failures, timeouts, and throttling/unavailable responses
 * previously failed the refresh outright; retry them instead with a small,
 * fixed attempt budget so a flaky upstream cannot stall catalog refresh.
 */

export interface DynamicModelFetchOptions {
  /** Total attempts, including the first. Must be >= 1. */
  attempts?: number;
  /** First backoff delay; doubles each retry up to `maxDelayMs`. */
  baseDelayMs?: number;
  /** Upper bound for a single backoff delay. */
  maxDelayMs?: number;
  /** Per-attempt request timeout. */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests; defaults to setTimeout. */
  sleepImpl?: (delayMs: number) => Promise<void>;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 4_000;
const DEFAULT_TIMEOUT_MS = 8_000;

export class ModelFetchStatusError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`${status} ${statusText}`.trim());
    this.name = "ModelFetchStatusError";
    this.status = status;
  }
}

export function isRetryableModelFetchStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function isRetryableModelFetchError(error: unknown): boolean {
  if (error instanceof ModelFetchStatusError) return isRetryableModelFetchStatus(error.status);
  // A network-level failure surfaces as TypeError("fetch failed"); the timeout
  // controller surfaces its abort as an AbortError DOMException.
  if (error instanceof TypeError) return true;
  return error instanceof DOMException && error.name === "AbortError";
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

async function fetchJsonOnce(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ModelFetchStatusError(response.status, response.statusText);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch and parse JSON with bounded retries. Retries only transient transport
 * failures; a non-retryable status (for example 401/404) fails on first contact.
 */
export async function fetchJsonWithRetry(
  url: string,
  init: RequestInit = {},
  options: DynamicModelFetchOptions = {},
): Promise<unknown> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_ATTEMPTS));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJsonOnce(url, init, fetchImpl, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableModelFetchError(error)) throw error;
    }
    const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
    await sleepImpl(delayMs);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
