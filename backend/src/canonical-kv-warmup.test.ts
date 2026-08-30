import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CanonicalKvWarmupCoordinator,
  sanitizeCanonicalWarmPayload,
  validateCanonicalKvWarmupConfig,
  type CanonicalKvWarmupConfig,
} from "./canonical-kv-warmup.js";

const SYSTEM = "stable-system-prefix";
const TOOL = {
  type: "function",
  function: {
    name: "synthetic_tool",
    description: "Schema-only synthetic tool",
    parameters: { type: "object", properties: { value: { type: "string" } } },
  },
};

function config(overrides: Partial<CanonicalKvWarmupConfig> = {}): CanonicalKvWarmupConfig {
  return {
    enabled: true,
    projectId: "project-memoriki",
    agentProfileId: "profile-wren",
    provider: "narwhal-horn",
    model: "qwen3.8-flash-next",
    family: "wren-memoriki-v1",
    ruminantBaseUrl: "http://ruminant.test:8055",
    apiKeyFile: "/private/ruminant-key",
    pollMs: 300_000,
    statusTimeoutMs: 2_000,
    requestTimeoutMs: 180_000,
    maxTemplateBytes: 8 * 1024 * 1024,
    ...overrides,
  };
}

function providerPayload(conversationMarker = "private-conversation-marker"): Record<string, unknown> {
  return {
    model: "qwen3.8-flash-next",
    messages: [
      { role: "system", content: SYSTEM },
      { role: "developer", content: "stable-developer-prefix" },
      { role: "user", content: conversationMarker },
      { role: "assistant", content: "private-assistant-history" },
      { role: "tool", content: "private-tool-result", tool_call_id: "call-private" },
    ],
    tools: [TOOL],
    chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
    reasoning_effort: "low",
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 32_768,
    tool_choice: "auto",
    prompt_cache_key: "private-session-id",
    user: "private-account-id",
    metadata: { private: true },
  };
}

test("sanitizer retains only the stable system/tool prefix and produces a history-independent hash", () => {
  const first = sanitizeCanonicalWarmPayload(
    providerPayload("first-private-user"),
    "qwen3.8-flash-next",
    8 * 1024 * 1024,
  );
  const second = sanitizeCanonicalWarmPayload(
    providerPayload("different-private-user"),
    "qwen3.8-flash-next",
    8 * 1024 * 1024,
  );
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.bundleHash, second.bundleHash);
  const encoded = JSON.stringify(first.payload);
  assert.match(encoded, /stable-system-prefix/u);
  assert.match(encoded, /synthetic_tool/u);
  assert.doesNotMatch(encoded, /first-private-user|private-assistant-history|private-tool-result|private-session-id|private-account-id/u);
  assert.deepEqual(first.payload.messages, [
    { role: "system", content: SYSTEM },
    { role: "developer", content: "stable-developer-prefix" },
    { role: "user", content: "Warm this stable prefix without taking action or calling tools." },
  ]);
  assert.equal(first.payload.stream, false);
  assert.equal(first.payload.max_tokens, 1);
  assert.equal(first.payload.tool_choice, "none");
  assert.equal(first.payload.n, 1);
  assert.equal("stream_options" in first.payload, false);
  assert.equal("metadata" in first.payload, false);
});

test("sanitizer fails closed for wrong models, missing leading system roles, malformed tools, and bounds", () => {
  assert.equal(sanitizeCanonicalWarmPayload(providerPayload(), "other-model", 1_000_000), null);
  assert.equal(sanitizeCanonicalWarmPayload({
    model: "qwen3.8-flash-next",
    messages: [{ role: "user", content: "not stable" }],
  }, "qwen3.8-flash-next", 1_000_000), null);
  assert.equal(sanitizeCanonicalWarmPayload({
    model: "qwen3.8-flash-next",
    messages: [{ role: "system", content: SYSTEM }],
    tools: "not-an-array",
  }, "qwen3.8-flash-next", 1_000_000), null);
  assert.equal(sanitizeCanonicalWarmPayload(providerPayload(), "qwen3.8-flash-next", 100), null);
});

test("session binding captures only after exact model bind and tags subsequent requests", () => {
  const coordinator = new CanonicalKvWarmupCoordinator(config(), {
    readSecretFile: () => "opaque-key",
    fetch: async () => new Response("unreachable", { status: 503 }),
  });
  const binding = coordinator.createSessionBinding({
    projectId: "project-memoriki",
    agentProfileId: "profile-wren",
  });
  assert.ok(binding);
  assert.equal(coordinator.createSessionBinding({
    projectId: "other-project",
    agentProfileId: "profile-wren",
  }), undefined);

  const handlers = new Map<string, (event: any) => unknown>();
  binding.extensionFactory({
    on(event: string, handler: (event: any) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI);

  const headersBefore: Record<string, string> = {};
  handlers.get("before_provider_headers")?.({ headers: headersBefore });
  assert.deepEqual(headersBefore, {});
  handlers.get("before_provider_request")?.({ payload: providerPayload() });
  assert.equal(coordinator.snapshot().templateAvailable, false);

  binding.bindModel("narwhal-horn", "qwen3.8-flash-next", "http://ruminant.test:8055/v1");
  handlers.get("before_provider_request")?.({ payload: providerPayload() });
  const captured = coordinator.snapshot();
  assert.equal(captured.templateAvailable, true);
  assert.equal(captured.capturesAccepted, 1);

  const headersAfter: Record<string, string> = {};
  handlers.get("before_provider_headers")?.({ headers: headersAfter });
  assert.equal(headersAfter["x-ruminant-prefix-family"], "wren-memoriki-v1");
  assert.equal(headersAfter["x-ruminant-prefix-bundle"], captured.templateBundleHash);

  binding.bindModel("narwhal-horn", "qwen3.8-flash-next", "http://narwhal-horn.test:8090/v1");
  handlers.get("before_provider_request")?.({ payload: providerPayload("direct-route-private-user") });
  assert.equal(coordinator.snapshot().capturesAccepted, 1, "direct Narwhal routes must not race the Ruminant warm lane");

  handlers.get("model_select")?.({ model: { provider: "together", id: "other", baseUrl: "https://api.together.xyz/v1" } });
  const wrongModelHeaders: Record<string, string> = {};
  handlers.get("before_provider_headers")?.({ headers: wrongModelHeaders });
  assert.deepEqual(wrongModelHeaders, {});
});

test("controller submits one sanitized template for the current generation without reading response content", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/ruminant/status")) {
      return new Response(JSON.stringify({
        warmup: {
          enabled: true,
          generation: "1".repeat(32),
          state: "needed",
          warm_bundle_hash: null,
          attempt_active: false,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ status: "warmed" }), { status: 200 });
  };
  const coordinator = new CanonicalKvWarmupCoordinator(config(), {
    readSecretFile: () => "opaque-client-key",
    fetch: fetchMock,
    warn: () => assert.fail("successful controller run must not warn"),
  });
  coordinator.start();
  coordinator.capture(providerPayload("private-user-must-not-leave-wayang"));
  await coordinator.runOnce();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://ruminant.test:8055/ruminant/status");
  assert.equal(requests[1].url, `http://ruminant.test:8055/ruminant/warmup/${"1".repeat(32)}`);
  const headers = requests[1].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer opaque-client-key");
  assert.equal(headers["x-ruminant-prefix-family"], "wren-memoriki-v1");
  const body = String(requests[1].init.body);
  assert.match(body, /stable-system-prefix/u);
  assert.doesNotMatch(body, /private-user-must-not-leave-wayang|private-assistant-history|private-tool-result/u);
  assert.equal(coordinator.snapshot().lastOutcome, "warmed");
  assert.equal(coordinator.snapshot().attempts, 1);
  await coordinator.close();
});

test("controller treats current bundle as warm and never opens the secret source when disabled", async () => {
  let secretReads = 0;
  let fetches = 0;
  let bundleHash = "";
  const coordinator = new CanonicalKvWarmupCoordinator(config(), {
    readSecretFile: () => {
      secretReads += 1;
      return "opaque-key";
    },
    fetch: async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        warmup: {
          enabled: true,
          generation: "2".repeat(32),
          state: "warm",
          warm_bundle_hash: bundleHash,
          attempt_active: false,
        },
      }), { status: 200 });
    },
  });
  coordinator.start();
  coordinator.capture(providerPayload());
  bundleHash = coordinator.snapshot().templateBundleHash ?? "";
  await coordinator.runOnce();
  assert.equal(secretReads, 1);
  assert.equal(fetches, 1);
  assert.equal(coordinator.snapshot().lastOutcome, "already_warm");
  await coordinator.close();

  const disabled = new CanonicalKvWarmupCoordinator(config({
    enabled: false,
    projectId: "",
    agentProfileId: "",
    provider: "",
    model: "",
    family: "",
    ruminantBaseUrl: "",
    apiKeyFile: "",
  }), {
    readSecretFile: () => {
      assert.fail("disabled coordinator must not read a secret file");
    },
    fetch: async () => {
      assert.fail("disabled coordinator must not fetch");
    },
  });
  disabled.start();
  disabled.capture(providerPayload());
  await disabled.runOnce();
  assert.deepEqual(disabled.snapshot(), {
    enabled: false,
    started: true,
    templateAvailable: false,
    templateBundleHash: null,
    templateBytes: null,
    inFlight: false,
    lastOutcome: "disabled",
    capturesAccepted: 0,
    capturesRejected: 0,
    attempts: 0,
    failures: 0,
  });
  await disabled.close();
});

test("controller treats foreground preemption as retryable rather than a failure", async () => {
  let calls = 0;
  const coordinator = new CanonicalKvWarmupCoordinator(config(), {
    readSecretFile: () => "opaque-key",
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          warmup: {
            enabled: true,
            generation: "3".repeat(32),
            state: "needed",
            warm_bundle_hash: null,
            attempt_active: false,
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ detail: { error: "warmup_preempted" } }), { status: 409 });
    },
    warn: () => assert.fail("foreground preemption is not an operational warning"),
  });
  coordinator.start();
  coordinator.capture(providerPayload());
  await coordinator.runOnce();
  assert.equal(coordinator.snapshot().lastOutcome, "preempted");
  assert.equal(coordinator.snapshot().attempts, 1);
  assert.equal(coordinator.snapshot().failures, 0);
  await coordinator.close();
});

test("controller failures expose only content-free diagnostics", async () => {
  const warnings: string[] = [];
  const privateMarker = "private-marker-must-not-enter-diagnostics";
  const coordinator = new CanonicalKvWarmupCoordinator(config(), {
    readSecretFile: () => "opaque-key",
    fetch: async () => new Response(privateMarker, { status: 503 }),
    warn: (message) => warnings.push(message),
  });
  coordinator.start();
  coordinator.capture(providerPayload(privateMarker));
  await coordinator.runOnce();
  assert.equal(coordinator.snapshot().lastOutcome, "error");
  assert.equal(coordinator.snapshot().failures, 1);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /private-marker|stable-system-prefix|opaque-key/u);
  await coordinator.close();
});

test("default secret reader accepts only a private regular non-symlink file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-kv-warmup-"));
  const key = path.join(root, "key");
  fs.writeFileSync(key, "opaque-key\n", { mode: 0o600 });
  const good = new CanonicalKvWarmupCoordinator(config({ apiKeyFile: key }));
  good.start();
  await good.close();

  fs.chmodSync(key, 0o644);
  const broad = new CanonicalKvWarmupCoordinator(config({ apiKeyFile: key }));
  assert.throws(() => broad.start(), /must not be accessible/u);

  fs.chmodSync(key, 0o600);
  const link = path.join(root, "link");
  fs.symlinkSync(key, link);
  const symlink = new CanonicalKvWarmupCoordinator(config({ apiKeyFile: link }));
  assert.throws(() => symlink.start(), /regular non-symlink/u);
  fs.rmSync(root, { recursive: true, force: true });
});

test("configuration requires an exact bounded target and origin when enabled", () => {
  assert.doesNotThrow(() => validateCanonicalKvWarmupConfig(config()));
  assert.throws(() => validateCanonicalKvWarmupConfig(config({ projectId: "" })), /projectId/u);
  assert.throws(() => validateCanonicalKvWarmupConfig(config({ family: "contains spaces" })), /family/u);
  assert.throws(() => validateCanonicalKvWarmupConfig(config({ apiKeyFile: "relative/key" })), /absolute/u);
  assert.throws(() => validateCanonicalKvWarmupConfig(config({ ruminantBaseUrl: "http://ruminant.test:8055/v1" })), /without credentials, path/u);
  assert.throws(() => validateCanonicalKvWarmupConfig(config({ ruminantBaseUrl: "http://user:pass@ruminant.test:8055" })), /without credentials, path/u);
});
