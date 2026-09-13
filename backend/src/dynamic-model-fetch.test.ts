import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchJsonWithRetry,
  isRetryableModelFetchError,
  isRetryableModelFetchStatus,
  ModelFetchStatusError,
} from "./dynamic-model-fetch.js";

function fakeJsonResponse(value: unknown, status = 200, statusText = "OK"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => value,
    body: null,
  } as unknown as Response;
}

function fakeStatusResponse(status: number, statusText = "Error"): Response {
  return {
    ok: false,
    status,
    statusText,
    json: async () => ({}),
    body: null,
  } as unknown as Response;
}

function recordingSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

test("returns parsed JSON on first success without sleeping", async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;
  const value = await fetchJsonWithRetry("https://example.test/v1/models", {}, {
    fetchImpl: (async () => {
      calls += 1;
      return fakeJsonResponse({ data: [1, 2] });
    }) as typeof fetch,
    sleepImpl: sleep,
  });
  assert.deepEqual(value, { data: [1, 2] });
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test("retries a retryable 503 and applies exponential backoff", async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;
  const value = await fetchJsonWithRetry("https://example.test/v1/models", {}, {
    fetchImpl: (async () => {
      calls += 1;
      return calls === 1 ? fakeStatusResponse(503, "Service Unavailable") : fakeJsonResponse({ ok: true });
    }) as typeof fetch,
    sleepImpl: sleep,
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [500]);
});

test("retries a network TypeError then succeeds", async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;
  const value = await fetchJsonWithRetry("https://example.test/v1/models", {}, {
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return fakeJsonResponse({ ok: true });
    }) as typeof fetch,
    sleepImpl: sleep,
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [500]);
});

test("does not retry a non-retryable status", async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;
  await assert.rejects(
    fetchJsonWithRetry("https://example.test/v1/models", {}, {
      fetchImpl: (async () => {
        calls += 1;
        return fakeStatusResponse(401, "Unauthorized");
      }) as typeof fetch,
      sleepImpl: sleep,
    }),
    (error: unknown) => error instanceof ModelFetchStatusError && error.status === 401,
  );
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test("exhausts attempts on persistent retryable failure", async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;
  await assert.rejects(
    fetchJsonWithRetry("https://example.test/v1/models", {}, {
      attempts: 3,
      fetchImpl: (async () => {
        calls += 1;
        return fakeStatusResponse(502, "Bad Gateway");
      }) as typeof fetch,
      sleepImpl: sleep,
    }),
    (error: unknown) => error instanceof ModelFetchStatusError && error.status === 502,
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [500, 1000]);
});

test("caps backoff at maxDelayMs", async () => {
  const { delays, sleep } = recordingSleep();
  await assert.rejects(
    fetchJsonWithRetry("https://example.test/v1/models", {}, {
      attempts: 4,
      baseDelayMs: 1000,
      maxDelayMs: 1500,
      fetchImpl: (async () => fakeStatusResponse(503)) as typeof fetch,
      sleepImpl: sleep,
    }),
  );
  assert.deepEqual(delays, [1000, 1500, 1500]);
});

test("times out an unresponsive fetch and retries with the abort error", async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;
  await assert.rejects(
    fetchJsonWithRetry("https://example.test/v1/models", {}, {
      attempts: 2,
      timeoutMs: 5,
      fetchImpl: ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        calls += 1;
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })) as typeof fetch,
      sleepImpl: sleep,
    }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(calls, 2);
  assert.deepEqual(delays, [500]);
});

test("classifies retryable statuses and errors", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504, 524]) {
    assert.equal(isRetryableModelFetchStatus(status), true, String(status));
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryableModelFetchStatus(status), false, String(status));
  }
  assert.equal(isRetryableModelFetchError(new TypeError("fetch failed")), true);
  assert.equal(isRetryableModelFetchError(new DOMException("Aborted", "AbortError")), true);
  assert.equal(isRetryableModelFetchError(new ModelFetchStatusError(429, "Too Many Requests")), true);
  assert.equal(isRetryableModelFetchError(new ModelFetchStatusError(401, "Unauthorized")), false);
  assert.equal(isRetryableModelFetchError(new Error("boom")), false);
});
