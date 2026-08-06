import assert from "node:assert/strict";
import test from "node:test";

import { parseAudioExperimentResponseText } from "./response.js";
import {
  SolArtifactSynthesisError,
  createSolArtifactSynthesisAdapter,
  type SolArtifactSynthesisRequest,
  type SolArtifactTransport,
} from "./sol.js";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const API_KEY = "synthetic-sol-test-key";
const LABEL_ONE = "0123456789abcdef0123456789abcdef";
const LABEL_TWO = "fedcba9876543210fedcba9876543210";
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x53, 0x59, 0x4e,
]);

function request(overrides: Partial<SolArtifactSynthesisRequest> = {}): SolArtifactSynthesisRequest {
  return {
    synthesisInstructions: "Synthesize the supplied artifacts without inferring provenance.",
    responseSchemaText: '{"type":"object","required":["summary"]}',
    candidates: [
      { label: LABEL_TWO, response: { summary: "Second neutral observation", score: 0.8 } },
      { label: LABEL_ONE, response: { summary: "First neutral observation", score: 0.7 } },
    ],
    dspNumericMetadata: { duration_seconds: 1.25, peak_db: -3.5 },
    ...overrides,
  };
}

function successfulResponse(text = '{"summary":"combined"}'): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl_sol_test",
    model: "gpt-5.6-sol",
    choices: [{ index: 0, message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function assertSolError(error: unknown, code: SolArtifactSynthesisError["code"]): boolean {
  assert.ok(error instanceof SolArtifactSynthesisError);
  assert.equal(error.code, code);
  return true;
}

test("sends exact model, store false, developer instructions, and artifact-only user content", async () => {
  const captured: Array<{ endpoint: string; init: RequestInit }> = [];
  const transport: SolArtifactTransport = async (endpoint, init) => {
    captured.push({ endpoint, init });
    return successfulResponse();
  };
  const adapter = createSolArtifactSynthesisAdapter({
    endpoint: ENDPOINT,
    model: "gpt-5.6-sol",
    apiKey: API_KEY,
    transport,
    maxOutputTokens: 777,
  });

  const result = await adapter.synthesize(request());
  assert.deepEqual(result, {
    kind: "raw_text",
    responseId: "chatcmpl_sol_test",
    model: "gpt-5.6-sol",
    text: '{"summary":"combined"}',
    usage: { promptTokens: 40, completionTokens: 8, totalTokens: 48 },
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].endpoint, ENDPOINT);
  assert.equal(captured[0].init.method, "POST");
  assert.ok(captured[0].init.signal instanceof AbortSignal);
  const headers = new Headers(captured[0].init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${API_KEY}`);
  assert.equal(headers.get("content-type"), "application/json");

  const body = JSON.parse(captured[0].init.body as string) as {
    model: string;
    store: boolean;
    modalities: string[];
    max_completion_tokens: number;
    messages: Array<{ role: string; content: unknown }>;
  };
  assert.equal(body.model, "gpt-5.6-sol");
  assert.equal(body.store, false);
  assert.deepEqual(body.modalities, ["text"]);
  assert.equal(body.max_completion_tokens, 777);
  assert.equal(body.messages.length, 2);
  assert.deepEqual(body.messages.map((message) => message.role), ["developer", "user"]);
  assert.equal(body.messages[0].content, request().synthesisInstructions);

  const userContent = body.messages[1].content as Array<{ type: string; text?: string }>;
  assert.equal(userContent.length, 1);
  assert.equal(userContent[0].type, "text");
  const artifacts = JSON.parse(userContent[0].text!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(artifacts), [
    "response_schema",
    "candidate_responses",
    "dsp_numeric_metadata",
  ]);
  const candidates = artifacts.candidate_responses as Record<string, unknown>;
  assert.deepEqual(Object.keys(candidates), [LABEL_ONE, LABEL_TWO]);
  assert.deepEqual(candidates[LABEL_ONE], { summary: "First neutral observation", score: 0.7 });
  assert.deepEqual(candidates[LABEL_TWO], { summary: "Second neutral observation", score: 0.8 });

  const serialized = captured[0].init.body as string;
  assert.equal(serialized.includes("source_audio"), false);
  assert.equal(serialized.includes("private_path"), false);
  assert.equal(serialized.includes(API_KEY), false);
  assert.equal(serialized.includes("arm_id"), false);
  assert.equal(serialized.includes('"A"'), false);
  assert.equal(serialized.includes('"B"'), false);
});

test("transports up to three raw PNGs only as image_url data URLs", async () => {
  let body: Record<string, unknown> | undefined;
  const adapter = createSolArtifactSynthesisAdapter({
    endpoint: ENDPOINT,
    model: "gpt-5.6-sol",
    apiKey: API_KEY,
    transport: async (_endpoint, init) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      return successfulResponse();
    },
  });

  await adapter.synthesize(request({
    images: [
      { bytes: PNG, detail: "high" },
      { bytes: new Uint8Array(PNG), detail: "low" },
      { bytes: new Uint8Array(PNG) },
    ],
  }));
  const messages = body!.messages as Array<{ role: string; content: unknown }>;
  const content = messages[1].content as Array<Record<string, unknown>>;
  assert.equal(content.length, 4);
  for (const [index, detail] of ["high", "low", "auto"].entries()) {
    const block = content[index + 1];
    assert.equal(block.type, "image_url");
    const imageUrl = block.image_url as { url: string; detail: string };
    assert.equal(imageUrl.url, `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    assert.equal(imageUrl.detail, detail);
  }
  assert.equal((messages[0].content as string).includes("data:image"), false);
});

test("uses the available response.ts validator and otherwise keeps a narrow raw-text result", async () => {
  const synthesisText = JSON.stringify({
    schema_version: "audio-experiment.response.v1",
    mode: "synthesis",
    input_basis: "artifacts_only",
    temporal_observations: [{
      phase: "opening",
      observation: "Synthetic artifact observation.",
      evidence: "Two opaque reports and local DSP artifacts.",
      source_basis: "cross_artifact",
      confidence: "medium",
    }],
    immediate_response: null,
    interpretation: { primary: "The synthetic artifacts broadly agree.", alternatives: [] },
    uncertainties: [],
    crystallized_record: { core: "Synthetic synthesis record.", anchors: ["Opaque candidates"] },
    synthesis: {
      agreements: ["The candidates agree on the opening."],
      disagreements: [],
      dsp_correspondences: ["The envelope matches the reported development."],
      added_value: "Cross-artifact comparison adds bounded context.",
      limits: "Synthesis had artifacts only.",
    },
  });
  const validatedAdapter = createSolArtifactSynthesisAdapter({
    endpoint: ENDPOINT,
    model: "gpt-5.6-sol",
    apiKey: API_KEY,
    transport: async () => successfulResponse(synthesisText),
    responseValidator: (text) => parseAudioExperimentResponseText(text, {
      expectedMode: "synthesis",
    }),
  });
  const result = await validatedAdapter.synthesize(request());
  assert.equal(result.kind, "validated");
  if (result.kind === "validated") {
    assert.equal(result.value.mode, "synthesis");
    assert.equal(result.value.synthesis.added_value, "Cross-artifact comparison adds bounded context.");
  }

  const rejectingAdapter = createSolArtifactSynthesisAdapter({
    endpoint: ENDPOINT,
    model: "gpt-5.6-sol",
    apiKey: API_KEY,
    transport: async () => successfulResponse("not valid"),
    responseValidator: () => { throw new Error("validator private body"); },
  });
  await assert.rejects(
    rejectingAdapter.synthesize(request()),
    (error: unknown) => {
      assertSolError(error, "invalid_response");
      assert.equal((error as Error).message.includes("validator private body"), false);
      return true;
    },
  );
});

test("pins the exact official endpoint and model before any fake transport call", () => {
  const transport: SolArtifactTransport = async () => {
    assert.fail("transport must not be called");
  };
  assert.throws(
    () => createSolArtifactSynthesisAdapter({
      endpoint: "https://example.invalid/v1/chat/completions" as typeof ENDPOINT,
      model: "gpt-5.6-sol",
      apiKey: API_KEY,
      transport,
    }),
    (error: unknown) => assertSolError(error, "invalid_configuration"),
  );
  assert.throws(
    () => createSolArtifactSynthesisAdapter({
      endpoint: ENDPOINT,
      model: "gpt-5.6" as "gpt-5.6-sol",
      apiKey: API_KEY,
      transport,
    }),
    (error: unknown) => assertSolError(error, "invalid_configuration"),
  );
});

test("rejects non-opaque labels, identity fields, private paths, nonnumeric DSP, and excess images", async () => {
  let calls = 0;
  const adapter = createSolArtifactSynthesisAdapter({
    endpoint: ENDPOINT,
    model: "gpt-5.6-sol",
    apiKey: API_KEY,
    transport: async () => {
      calls += 1;
      return successfulResponse();
    },
  });
  const invalidRequests: SolArtifactSynthesisRequest[] = [
    request({ candidates: [
      { label: "A", response: { summary: "one" } },
      { label: LABEL_TWO, response: { summary: "two" } },
    ] }),
    request({ candidates: [
      { label: LABEL_ONE, response: { arm_id: "A", summary: "one" } },
      { label: LABEL_TWO, response: { summary: "two" } },
    ] }),
    request({ responseSchemaText: "Read /home/example/private/schema.json" }),
    request({ synthesisInstructions: "Prefer arm A over arm B." }),
    request({ dspNumericMetadata: { peak_db: "loud" as unknown as number } }),
    request({ images: [
      { bytes: PNG }, { bytes: PNG }, { bytes: PNG }, { bytes: PNG },
    ] }),
  ];
  for (const invalid of invalidRequests) {
    await assert.rejects(
      adapter.synthesize(invalid),
      (error: unknown) => assertSolError(error, "invalid_request"),
    );
  }
  assert.equal(calls, 0);
});

test("bounds request artifacts and streamed provider responses", async () => {
  let calls = 0;
  const requestAdapter = createSolArtifactSynthesisAdapter({
    endpoint: ENDPOINT,
    model: "gpt-5.6-sol",
    apiKey: API_KEY,
    transport: async () => {
      calls += 1;
      return successfulResponse();
    },
    maxRequestBytes: 512,
  });
  await assert.rejects(
    requestAdapter.synthesize(request()),
    (error: unknown) => assertSolError(error, "request_too_large"),
  );
  assert.equal(calls, 0);

  const responseAdapter = createSolArtifactSynthesisAdapter({
    endpoint: ENDPOINT,
    model: "gpt-5.6-sol",
    apiKey: API_KEY,
    transport: async () => new Response("x".repeat(65), { status: 200 }),
    maxResponseBytes: 64,
  });
  await assert.rejects(
    responseAdapter.synthesize(request()),
    (error: unknown) => assertSolError(error, "response_too_large"),
  );
});

test("honors caller abort and timeout while passing an aborted signal to fake transport", async () => {
  const observed: AbortSignal[] = [];
  const hangingTransport: SolArtifactTransport = async (_endpoint, init) => {
    const signal = init.signal as AbortSignal;
    observed.push(signal);
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private transport abort")), { once: true });
    });
  };
  const timeoutAdapter = createSolArtifactSynthesisAdapter({
    endpoint: ENDPOINT,
    model: "gpt-5.6-sol",
    apiKey: API_KEY,
    transport: hangingTransport,
    timeoutMs: 5,
  });
  await assert.rejects(
    timeoutAdapter.synthesize(request()),
    (error: unknown) => assertSolError(error, "timeout"),
  );
  assert.equal(observed[0].aborted, true);

  const abortAdapter = createSolArtifactSynthesisAdapter({
    endpoint: ENDPOINT,
    model: "gpt-5.6-sol",
    apiKey: API_KEY,
    transport: hangingTransport,
    timeoutMs: 1_000,
  });
  const controller = new AbortController();
  const pending = abortAdapter.synthesize(request({ signal: controller.signal }));
  controller.abort("private caller reason");
  await assert.rejects(pending, (error: unknown) => {
    assertSolError(error, "aborted");
    assert.equal((error as Error).message.includes("private caller reason"), false);
    return true;
  });
  assert.equal(observed[1].aborted, true);
});

test("redacts provider bodies, transport exceptions, credentials, and request artifacts", async () => {
  const providerBody = "provider-private-body";
  const artifactSecret = "artifact-private-detail";
  const httpAdapter = createSolArtifactSynthesisAdapter({
    endpoint: ENDPOINT,
    model: "gpt-5.6-sol",
    apiKey: API_KEY,
    transport: async () => new Response(providerBody, { status: 429 }),
  });
  await assert.rejects(
    httpAdapter.synthesize(request({ synthesisInstructions: artifactSecret })),
    (error: unknown) => {
      assertSolError(error, "http_error");
      const message = (error as Error).message;
      for (const secret of [providerBody, artifactSecret, API_KEY]) {
        assert.equal(message.includes(secret), false);
      }
      return true;
    },
  );

  const transportAdapter = createSolArtifactSynthesisAdapter({
    endpoint: ENDPOINT,
    model: "gpt-5.6-sol",
    apiKey: API_KEY,
    transport: async () => { throw new Error(`leaked ${API_KEY} ${artifactSecret}`); },
  });
  await assert.rejects(
    transportAdapter.synthesize(request({ synthesisInstructions: artifactSecret })),
    (error: unknown) => {
      assertSolError(error, "transport_error");
      assert.equal((error as Error).message.includes(API_KEY), false);
      assert.equal((error as Error).message.includes(artifactSecret), false);
      return true;
    },
  );
});
