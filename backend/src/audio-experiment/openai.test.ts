import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenAiFileAudioError,
  createOpenAiFileAudioAdapter,
  type OpenAiAudioTransport,
  type OpenAiFileAudioRequest,
} from "./openai.js";
import { AUDIO_EXPERIMENT_RESPONSE_VERSION } from "./response.js";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const API_KEY = "synthetic-test-key";
const AUDIO_BASE64 = "UklGRg==";

function directResponse(opening = "A bounded synthetic analysis.") {
  return {
    schema_version: AUDIO_EXPERIMENT_RESPONSE_VERSION,
    mode: "direct_encounter",
    input_basis: "direct_audio",
    temporal_observations: [{
      phase: "opening",
      observation: "Synthetic observation.",
      evidence: "Synthetic evidence.",
      source_basis: "direct_audio",
      confidence: "medium",
    }],
    immediate_response: {
      opening,
      developments: "A bounded development.",
      residue: "A bounded residue.",
    },
    interpretation: { primary: "Synthetic interpretation.", alternatives: [] },
    uncertainties: [],
    crystallized_record: { core: "Synthetic core.", anchors: ["Synthetic anchor."] },
    synthesis: null,
  };
}

function successfulResponse(response: unknown = directResponse()): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_test_123",
      model: "gpt-audio-1.5-2026-08-01",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(response) } }],
      usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function request(
  mode: "A" | "B" = "A",
  format: "mp3" | "wav" = "mp3",
): OpenAiFileAudioRequest {
  return {
    mode,
    instructions: mode === "A"
      ? "Synthetic arm-A developer instructions; keep the analysis concise and bounded."
      : "Synthetic neutral developer instructions; do not assume a named identity.",
    task: "Analyze the attached synthetic audio and provide bounded observations.",
    schemaText: "Return only one strict audio-experiment.response.v1 direct_encounter JSON object.",
    audio: { format, base64: AUDIO_BASE64 },
  };
}

function assertAdapterError(error: unknown, code: OpenAiFileAudioError["code"]): boolean {
  assert.ok(error instanceof OpenAiFileAudioError);
  assert.equal(error.code, code);
  return true;
}

test("separates developer instructions from user task, schema, and inline audio for A/B", async () => {
  const captured: Array<{ endpoint: string; init: RequestInit }> = [];
  const transport: OpenAiAudioTransport = async (endpoint, init) => {
    captured.push({ endpoint, init });
    return successfulResponse();
  };
  const adapter = createOpenAiFileAudioAdapter({
    endpoint: ENDPOINT,
    model: "gpt-audio-1.5",
    apiKey: API_KEY,
    transport,
    timeoutMs: 1_000,
    maxOutputTokens: 321,
  });

  const requests = [request("A", "mp3"), request("B", "wav")] as const;
  const first = await adapter.analyze(requests[0]);
  await adapter.analyze(requests[1]);

  assert.deepEqual(first, {
    responseId: "chatcmpl_test_123",
    model: "gpt-audio-1.5-2026-08-01",
    response: directResponse(),
    usage: { promptTokens: 21, completionTokens: 7, totalTokens: 28 },
  });
  assert.equal(captured.length, 2);

  captured.forEach((call, index) => {
    const expected = requests[index]!;
    assert.equal(call.endpoint, ENDPOINT);
    assert.equal(call.init.method, "POST");
    assert.ok(call.init.signal instanceof AbortSignal);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${API_KEY}`);
    assert.equal(headers.get("content-type"), "application/json");
    const body = JSON.parse(call.init.body as string) as Record<string, unknown>;
    assert.deepEqual(body, {
      model: "gpt-audio-1.5",
      store: false,
      modalities: ["text"],
      max_completion_tokens: 321,
      messages: [
        { role: "developer", content: expected.instructions },
        {
          role: "user",
          content: [
            { type: "text", text: expected.task },
            { type: "text", text: expected.schemaText },
            {
              type: "input_audio",
              input_audio: { data: AUDIO_BASE64, format: expected.audio.format },
            },
          ],
        },
      ],
    });
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    assert.equal(JSON.stringify(messages[1]!.content).includes(expected.instructions), false);
    assert.equal("files" in body, false);
    assert.equal("mode" in body, false);
  });
});

test("returns null usage when the provider omits optional usage", async () => {
  const adapter = createOpenAiFileAudioAdapter({
    endpoint: ENDPOINT,
    model: "gpt-audio-1.5",
    apiKey: API_KEY,
    transport: async () =>
      new Response(JSON.stringify({
        id: "chatcmpl_no_usage",
        model: "gpt-audio-1.5",
        choices: [{ message: { content: JSON.stringify(directResponse()) } }],
      }), { status: 200 }),
  });

  assert.equal((await adapter.analyze(request())).usage, null);
});

test("rejects non-Chat-Completions endpoints and wrong model before transport", () => {
  const transport: OpenAiAudioTransport = async () => {
    assert.fail("transport must not be called");
  };
  assert.throws(() => createOpenAiFileAudioAdapter({
    endpoint: "https://api.openai.com/v1/files" as typeof ENDPOINT,
    model: "gpt-audio-1.5",
    apiKey: API_KEY,
    transport,
  }), (error: unknown) => assertAdapterError(error, "invalid_configuration"));
  assert.throws(() => createOpenAiFileAudioAdapter({
    endpoint: ENDPOINT,
    model: "another-model" as "gpt-audio-1.5",
    apiKey: API_KEY,
    transport,
  }), (error: unknown) => assertAdapterError(error, "invalid_configuration"));
});

test("rejects data URLs, unsupported modes, extra fields, and empty separated prompts", async () => {
  let calls = 0;
  const adapter = createOpenAiFileAudioAdapter({
    endpoint: ENDPOINT,
    model: "gpt-audio-1.5",
    apiKey: API_KEY,
    transport: async () => {
      calls += 1;
      return successfulResponse();
    },
  });

  const invalid: OpenAiFileAudioRequest[] = [
    { ...request(), audio: { format: "mp3", base64: "data:audio/mpeg;base64,UklGRg==" } },
    { ...request(), mode: "C" as "A" },
    { ...request(), instructions: " " },
    { ...request(), task: "" },
    { ...request(), schemaText: "\u0000" },
    { ...request(), signal: "not-a-signal" } as unknown as OpenAiFileAudioRequest,
    { ...request(), extra: true } as OpenAiFileAudioRequest,
  ];
  for (const value of invalid) {
    await assert.rejects(adapter.analyze(value),
      (error: unknown) => assertAdapterError(error, "invalid_request"));
  }
  assert.equal(calls, 0);
});

test("parses only the exact direct_encounter response contract", async () => {
  const valid = directResponse();
  const invalidResponses: unknown[] = [
    { ...valid, mode: "synthesis", input_basis: "artifacts_only", immediate_response: null },
    { ...valid, input_basis: "artifacts_only" },
    { ...valid, extra: true },
    { ...valid, synthesis: { agreements: [] } },
    { ...valid, temporal_observations: [{ ...valid.temporal_observations[0], source_basis: "dsp" }] },
    { ...valid, immediate_response: { ...valid.immediate_response, opening: "A".repeat(256) } },
  ];

  for (const response of invalidResponses) {
    const adapter = createOpenAiFileAudioAdapter({
      endpoint: ENDPOINT,
      model: "gpt-audio-1.5",
      apiKey: API_KEY,
      transport: async () => successfulResponse(response),
    });
    await assert.rejects(adapter.analyze(request()),
      (error: unknown) => assertAdapterError(error, "invalid_response"));
  }
});

test("rejects exact and normalized-whitespace prompt echoes without exposing them", async () => {
  const privateChunk = `private-capsule-${"sensitive adapter words ".repeat(4)}`;
  for (const echoed of [privateChunk, privateChunk.replace(/ /g, " \n\t ")]) {
    const input = { ...request(), instructions: `prefix ${privateChunk} suffix` };
    const adapter = createOpenAiFileAudioAdapter({
      endpoint: ENDPOINT,
      model: "gpt-audio-1.5",
      apiKey: API_KEY,
      transport: async () => successfulResponse(directResponse(echoed)),
    });
    await assert.rejects(adapter.analyze(input), (error: unknown) => {
      assertAdapterError(error, "invalid_response");
      assert.equal((error as Error).message.includes(privateChunk), false);
      return true;
    });
  }
});

test("bounds response bytes before JSON parsing", async () => {
  const adapter = createOpenAiFileAudioAdapter({
    endpoint: ENDPOINT,
    model: "gpt-audio-1.5",
    apiKey: API_KEY,
    transport: async () => new Response("x".repeat(65), { status: 200 }),
    maxResponseBytes: 64,
  });
  await assert.rejects(adapter.analyze(request()),
    (error: unknown) => assertAdapterError(error, "response_too_large"));
});

test("redacts provider bodies, prompt/audio data, keys, and transport exceptions", async () => {
  const providerSecret = "provider-body-private-detail";
  const input = request("B", "wav");
  const httpAdapter = createOpenAiFileAudioAdapter({
    endpoint: ENDPOINT,
    model: "gpt-audio-1.5",
    apiKey: API_KEY,
    transport: async () => new Response(providerSecret, { status: 429 }),
  });
  await assert.rejects(httpAdapter.analyze(input), (error: unknown) => {
    assertAdapterError(error, "http_error");
    for (const secret of [providerSecret, input.instructions, input.task, AUDIO_BASE64, API_KEY]) {
      assert.equal((error as Error).message.includes(secret), false);
    }
    return true;
  });

  const transportAdapter = createOpenAiFileAudioAdapter({
    endpoint: ENDPOINT,
    model: "gpt-audio-1.5",
    apiKey: API_KEY,
    transport: async () => { throw new Error(`network leaked ${API_KEY}`); },
  });
  await assert.rejects(transportAdapter.analyze(request()), (error: unknown) => {
    assertAdapterError(error, "transport_error");
    assert.equal((error as Error).message.includes(API_KEY), false);
    return true;
  });
});

test("enforces timeout and caller abort with redacted errors", async () => {
  let observedSignal: AbortSignal | undefined;
  const adapter = createOpenAiFileAudioAdapter({
    endpoint: ENDPOINT,
    model: "gpt-audio-1.5",
    apiKey: API_KEY,
    transport: async (_endpoint, init) => {
      observedSignal = init.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(new Error("raw abort")), { once: true });
      });
    },
    timeoutMs: 5,
  });
  await assert.rejects(adapter.analyze(request()),
    (error: unknown) => assertAdapterError(error, "timeout"));
  assert.equal(observedSignal?.aborted, true);

  const controller = new AbortController();
  const pending = createOpenAiFileAudioAdapter({
    endpoint: ENDPOINT,
    model: "gpt-audio-1.5",
    apiKey: API_KEY,
    transport: async (_endpoint, init) => await new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("private reason")), { once: true });
    }),
  }).analyze({ ...request(), signal: controller.signal });
  controller.abort("do not expose this reason");
  await assert.rejects(pending, (error: unknown) => {
    assertAdapterError(error, "aborted");
    assert.equal((error as Error).message.includes("do not expose"), false);
    return true;
  });
});

test("rejects malformed success payloads with a fixed error", async () => {
  const adapter = createOpenAiFileAudioAdapter({
    endpoint: ENDPOINT,
    model: "gpt-audio-1.5",
    apiKey: API_KEY,
    transport: async () => new Response(
      JSON.stringify({ id: "private malformed object", choices: [] }),
      { status: 200 },
    ),
  });
  await assert.rejects(adapter.analyze(request()), (error: unknown) => {
    assertAdapterError(error, "invalid_response");
    assert.equal((error as Error).message.includes("private malformed object"), false);
    return true;
  });
});
