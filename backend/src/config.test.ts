import assert from "node:assert/strict";
import test from "node:test";
import {
  assertStandardBrowserProfileHostsStartupReady,
  getConfig,
  STANDARD_BROWSER_PROFILE_HOSTS_STARTUP_ERROR,
} from "./config.js";

test("legacy identity-specific host flag is not runtime authority", () => {
  const previous = process.env.WAYANG_WREN_HOST_BASH;
  try {
    process.env.WAYANG_WREN_HOST_BASH = "1";
    const config = getConfig();
    assert.equal("wrenHostBash" in config, false);
  } finally {
    if (previous === undefined) delete process.env.WAYANG_WREN_HOST_BASH;
    else process.env.WAYANG_WREN_HOST_BASH = previous;
  }
});

test("Standard Browser Profile hosts gate is strict, disabled by default, and captured by Config", () => {
  const previous = process.env.WAYANG_STANDARD_BROWSER_PROFILE_HOSTS;
  try {
    delete process.env.WAYANG_STANDARD_BROWSER_PROFILE_HOSTS;
    const capturedDisabled = getConfig();
    assert.equal(capturedDisabled.standardBrowserProfileHosts, false);

    process.env.WAYANG_STANDARD_BROWSER_PROFILE_HOSTS = "1";
    assert.equal(capturedDisabled.standardBrowserProfileHosts, false, "existing Config is startup immutable");
    const capturedEnabled = getConfig();
    assert.equal(capturedEnabled.standardBrowserProfileHosts, true);

    process.env.WAYANG_STANDARD_BROWSER_PROFILE_HOSTS = "0";
    assert.equal(getConfig().standardBrowserProfileHosts, false);
    process.env.WAYANG_STANDARD_BROWSER_PROFILE_HOSTS = "1";
    assert.equal(
      getConfig({ standardBrowserProfileHosts: false }).standardBrowserProfileHosts,
      false,
      "explicit synthetic composition overrides a valid captured environment value",
    );

    for (const invalid of ["", "true", "01", " 1", "1 "]) {
      process.env.WAYANG_STANDARD_BROWSER_PROFILE_HOSTS = invalid;
      assert.throws(
        () => getConfig(),
        /WAYANG_STANDARD_BROWSER_PROFILE_HOSTS must be 0 or 1/,
      );
      assert.throws(
        () => getConfig({ standardBrowserProfileHosts: false }),
        /WAYANG_STANDARD_BROWSER_PROFILE_HOSTS must be 0 or 1/,
        "an override cannot hide malformed startup configuration",
      );
    }
  } finally {
    if (previous === undefined) delete process.env.WAYANG_STANDARD_BROWSER_PROFILE_HOSTS;
    else process.env.WAYANG_STANDARD_BROWSER_PROFILE_HOSTS = previous;
  }
});

test("enabled Standard Browser Profile hosts fail bounded production readiness before composition", () => {
  assert.doesNotThrow(() => assertStandardBrowserProfileHostsStartupReady({ standardBrowserProfileHosts: false }));
  assert.throws(
    () => assertStandardBrowserProfileHostsStartupReady({ standardBrowserProfileHosts: true }),
    { message: STANDARD_BROWSER_PROFILE_HOSTS_STARTUP_ERROR },
  );
  assert.ok(Buffer.byteLength(STANDARD_BROWSER_PROFILE_HOSTS_STARTUP_ERROR, "utf8") <= 160);
});

test("file-audio private prompt artifacts have distinct path and frozen-digest configuration fields", () => {
  const values: Record<string, string> = {
    WAYANG_FILE_AUDIO_EXPERIMENT_WREN_CAPSULE_PATH: "/synthetic/capsule",
    WAYANG_FILE_AUDIO_EXPERIMENT_WREN_CAPSULE_SHA256: "1".repeat(64),
    WAYANG_FILE_AUDIO_EXPERIMENT_SHARED_TASK_PATH: "/synthetic/task",
    WAYANG_FILE_AUDIO_EXPERIMENT_SHARED_TASK_SHA256: "2".repeat(64),
    WAYANG_FILE_AUDIO_EXPERIMENT_NEUTRAL_ADAPTER_PATH: "/synthetic/neutral",
    WAYANG_FILE_AUDIO_EXPERIMENT_NEUTRAL_ADAPTER_SHA256: "3".repeat(64),
    WAYANG_FILE_AUDIO_EXPERIMENT_RESPONSE_SCHEMA_PATH: "/synthetic/schema",
    WAYANG_FILE_AUDIO_EXPERIMENT_RESPONSE_SCHEMA_SHA256: "4".repeat(64),
    WAYANG_FILE_AUDIO_EXPERIMENT_SOL_SYNTHESIS_PROMPT_PATH: "/synthetic/sol",
    WAYANG_FILE_AUDIO_EXPERIMENT_SOL_SYNTHESIS_PROMPT_SHA256: "5".repeat(64),
  };
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, values);
    const audio = getConfig().fileAudioExperiment;
    assert.equal(audio.wrenCapsulePath, values.WAYANG_FILE_AUDIO_EXPERIMENT_WREN_CAPSULE_PATH);
    assert.equal(audio.wrenCapsuleSha256, values.WAYANG_FILE_AUDIO_EXPERIMENT_WREN_CAPSULE_SHA256);
    assert.equal(audio.sharedTaskPath, values.WAYANG_FILE_AUDIO_EXPERIMENT_SHARED_TASK_PATH);
    assert.equal(audio.sharedTaskSha256, values.WAYANG_FILE_AUDIO_EXPERIMENT_SHARED_TASK_SHA256);
    assert.equal(audio.neutralAdapterPath, values.WAYANG_FILE_AUDIO_EXPERIMENT_NEUTRAL_ADAPTER_PATH);
    assert.equal(audio.neutralAdapterSha256, values.WAYANG_FILE_AUDIO_EXPERIMENT_NEUTRAL_ADAPTER_SHA256);
    assert.equal(audio.responseSchemaPath, values.WAYANG_FILE_AUDIO_EXPERIMENT_RESPONSE_SCHEMA_PATH);
    assert.equal(audio.responseSchemaSha256, values.WAYANG_FILE_AUDIO_EXPERIMENT_RESPONSE_SCHEMA_SHA256);
    assert.equal(audio.solSynthesisPromptPath, values.WAYANG_FILE_AUDIO_EXPERIMENT_SOL_SYNTHESIS_PROMPT_PATH);
    assert.equal(audio.solSynthesisPromptSha256, values.WAYANG_FILE_AUDIO_EXPERIMENT_SOL_SYNTHESIS_PROMPT_SHA256);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("messaging is disabled by default and strict flags expose only a private config path selector", () => {
  const previousEnabled = process.env.WAYANG_MESSAGING_ENABLED;
  const previousPath = process.env.WAYANG_MESSAGING_CONFIG_PATH;
  try {
    delete process.env.WAYANG_MESSAGING_ENABLED;
    delete process.env.WAYANG_MESSAGING_CONFIG_PATH;
    assert.deepEqual(getConfig().messaging, { enabled: false, configPath: "" });
    process.env.WAYANG_MESSAGING_ENABLED = "1";
    process.env.WAYANG_MESSAGING_CONFIG_PATH = "/synthetic/private/messaging.json";
    assert.deepEqual(getConfig().messaging, {
      enabled: true,
      configPath: "/synthetic/private/messaging.json",
    });
    process.env.WAYANG_MESSAGING_ENABLED = "yes";
    assert.throws(() => getConfig(), /WAYANG_MESSAGING_ENABLED must be 0 or 1/);
  } finally {
    if (previousEnabled === undefined) delete process.env.WAYANG_MESSAGING_ENABLED;
    else process.env.WAYANG_MESSAGING_ENABLED = previousEnabled;
    if (previousPath === undefined) delete process.env.WAYANG_MESSAGING_CONFIG_PATH;
    else process.env.WAYANG_MESSAGING_CONFIG_PATH = previousPath;
  }
});

test("canonical KV warming is default-off and requires exact bounded selectors", () => {
  const names = [
    "WAYANG_CANONICAL_KV_WARMUP_ENABLED",
    "WAYANG_CANONICAL_KV_WARMUP_PROJECT_ID",
    "WAYANG_CANONICAL_KV_WARMUP_AGENT_PROFILE_ID",
    "WAYANG_CANONICAL_KV_WARMUP_PROVIDER",
    "WAYANG_CANONICAL_KV_WARMUP_MODEL",
    "WAYANG_CANONICAL_KV_WARMUP_FAMILY",
    "WAYANG_CANONICAL_KV_WARMUP_RUMINANT_BASE_URL",
    "WAYANG_CANONICAL_KV_WARMUP_API_KEY_FILE",
    "WAYANG_CANONICAL_KV_WARMUP_POLL_MS",
    "WAYANG_CANONICAL_KV_WARMUP_STATUS_TIMEOUT_MS",
    "WAYANG_CANONICAL_KV_WARMUP_REQUEST_TIMEOUT_MS",
    "WAYANG_CANONICAL_KV_WARMUP_MAX_TEMPLATE_BYTES",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.deepEqual(getConfig().canonicalKvWarmup, {
      enabled: false,
      projectId: "",
      agentProfileId: "",
      provider: "",
      model: "",
      family: "",
      ruminantBaseUrl: "",
      apiKeyFile: "",
      pollMs: 2_000,
      statusTimeoutMs: 2_000,
      requestTimeoutMs: 180_000,
      maxTemplateBytes: 8 * 1024 * 1024,
    });

    process.env.WAYANG_CANONICAL_KV_WARMUP_ENABLED = "1";
    assert.throws(() => getConfig(), /projectId/u);
    Object.assign(process.env, {
      WAYANG_CANONICAL_KV_WARMUP_PROJECT_ID: "project-memoriki",
      WAYANG_CANONICAL_KV_WARMUP_AGENT_PROFILE_ID: "profile-wren",
      WAYANG_CANONICAL_KV_WARMUP_PROVIDER: "narwhal-horn",
      WAYANG_CANONICAL_KV_WARMUP_MODEL: "qwen3.8-flash-next",
      WAYANG_CANONICAL_KV_WARMUP_FAMILY: "wren-memoriki-v1",
      WAYANG_CANONICAL_KV_WARMUP_RUMINANT_BASE_URL: "http://127.0.0.1:8055",
      WAYANG_CANONICAL_KV_WARMUP_API_KEY_FILE: "/private/ruminant-key",
    });
    const enabled = getConfig().canonicalKvWarmup;
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.projectId, "project-memoriki");
    assert.equal(enabled.ruminantBaseUrl, "http://127.0.0.1:8055");

    process.env.WAYANG_CANONICAL_KV_WARMUP_FAMILY = "contains spaces";
    assert.throws(() => getConfig(), /family is invalid/u);
    process.env.WAYANG_CANONICAL_KV_WARMUP_FAMILY = "wren-memoriki-v1";
    process.env.WAYANG_CANONICAL_KV_WARMUP_RUMINANT_BASE_URL = "http://127.0.0.1:8055/v1";
    assert.throws(() => getConfig(), /without credentials, path/u);
    process.env.WAYANG_CANONICAL_KV_WARMUP_RUMINANT_BASE_URL = "http://127.0.0.1:8055";
    process.env.WAYANG_CANONICAL_KV_WARMUP_ENABLED = "true";
    assert.throws(() => getConfig(), /WAYANG_CANONICAL_KV_WARMUP_ENABLED must be 0 or 1/u);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("memory-first traditional compaction is default-off with independently validated controls", () => {
  const names = [
    "WAYANG_MEMORY_FIRST_ENABLED",
    "WAYANG_MEMORY_FIRST_GUIDANCE_ENABLED",
    "WAYANG_MEMORY_FIRST_REVIEW_ENABLED",
    "WAYANG_MEMORY_FIRST_COMPACTION_CONTROLS_ENABLED",
    "WAYANG_MEMORY_FIRST_LEDGER_ENABLED",
    "WAYANG_MEMORY_FIRST_STANDARD_INTERACTIVE_ENABLED",
    "WAYANG_MEMORY_FIRST_STANDARD_SCHEDULED_ENABLED",
    "WAYANG_MEMORY_FIRST_PROTECTED_INTERACTIVE_ENABLED",
    "WAYANG_MEMORY_FIRST_PROTECTED_SCHEDULED_ENABLED",
    "WAYANG_MEMORY_FIRST_SUBAGENT_ENABLED",
    "WAYANG_MEMORY_FIRST_REVIEW_TOKENS",
    "WAYANG_MEMORY_FIRST_COMPACTION_TRIGGER_TOKENS",
    "WAYANG_MEMORY_FIRST_KEEP_RECENT_TOKENS",
    "WAYANG_MEMORY_FIRST_KEEP_COMPLETE_TURNS",
    "WAYANG_MEMORY_FIRST_STANDARD_ROUTE",
    "WAYANG_MEMORY_FIRST_PROTECTED_ROUTE",
    "WAYANG_MEMORY_FIRST_PROTECTED_PROJECT_PATH",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.deepEqual(getConfig().memoryFirstCompaction, {
      enabled: false,
      guidanceEnabled: false,
      reviewEnabled: false,
      compactionControlsEnabled: false,
      ledgerEnabled: false,
      standardInteractiveEnabled: false,
      standardScheduledEnabled: false,
      protectedInteractiveEnabled: false,
      protectedScheduledEnabled: false,
      subagentEnabled: false,
      reviewTokens: 96_000,
      compactionTriggerTokens: 128_000,
      keepRecentTokens: 20_000,
      keepCompleteTurns: false,
      standardRoute: "memoriki",
      protectedRoute: "project-local",
      protectedProjectMemoryPath: ".wayang/memory.md",
    });

    process.env.WAYANG_MEMORY_FIRST_GUIDANCE_ENABLED = "1";
    assert.equal(getConfig().memoryFirstCompaction.enabled, false,
      "a component flag cannot bypass the master gate");
    delete process.env.WAYANG_MEMORY_FIRST_GUIDANCE_ENABLED;

    process.env.WAYANG_MEMORY_FIRST_ENABLED = "1";
    const masterOnly = getConfig().memoryFirstCompaction;
    assert.deepEqual({
      enabled: masterOnly.enabled,
      guidanceEnabled: masterOnly.guidanceEnabled,
      reviewEnabled: masterOnly.reviewEnabled,
      compactionControlsEnabled: masterOnly.compactionControlsEnabled,
      ledgerEnabled: masterOnly.ledgerEnabled,
      keepCompleteTurns: masterOnly.keepCompleteTurns,
    }, {
      enabled: false,
      guidanceEnabled: false,
      reviewEnabled: false,
      compactionControlsEnabled: false,
      ledgerEnabled: false,
      keepCompleteTurns: false,
    }, "the master flag alone is completely inert");

    process.env.WAYANG_MEMORY_FIRST_GUIDANCE_ENABLED = "1";
    process.env.WAYANG_MEMORY_FIRST_PROTECTED_PROJECT_PATH = ".memory/review.md";
    assert.equal(getConfig().memoryFirstCompaction.enabled, false,
      "behavior flags remain inert until an explicit cohort is enabled");
    process.env.WAYANG_MEMORY_FIRST_STANDARD_INTERACTIVE_ENABLED = "1";
    let enabled = getConfig().memoryFirstCompaction;
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.standardInteractiveEnabled, true);
    assert.equal(enabled.standardScheduledEnabled, false);
    assert.equal(enabled.protectedInteractiveEnabled, false);
    assert.equal(enabled.protectedScheduledEnabled, false);
    assert.equal(enabled.subagentEnabled, false);
    assert.equal(enabled.guidanceEnabled, true);
    assert.equal(enabled.reviewEnabled, false);
    assert.equal(enabled.compactionControlsEnabled, false);
    assert.equal(enabled.ledgerEnabled, false);
    assert.equal(enabled.keepCompleteTurns, false);
    assert.equal(enabled.protectedProjectMemoryPath, ".memory/review.md");

    process.env.WAYANG_MEMORY_FIRST_COMPACTION_CONTROLS_ENABLED = "1";
    enabled = getConfig().memoryFirstCompaction;
    assert.equal(enabled.compactionControlsEnabled, true);
    assert.equal(enabled.keepCompleteTurns, false, "controls do not imply complete-turn retention");
    process.env.WAYANG_MEMORY_FIRST_KEEP_COMPLETE_TURNS = "1";
    assert.equal(getConfig().memoryFirstCompaction.keepCompleteTurns, true);

    process.env.WAYANG_MEMORY_FIRST_REVIEW_TOKENS = "128000";
    assert.throws(() => getConfig(), /REVIEW_TOKENS must be less than/);
    process.env.WAYANG_MEMORY_FIRST_REVIEW_TOKENS = "96000";
    process.env.WAYANG_MEMORY_FIRST_KEEP_RECENT_TOKENS = "96000";
    assert.throws(() => getConfig(), /KEEP_RECENT_TOKENS must be less than/);
    process.env.WAYANG_MEMORY_FIRST_KEEP_RECENT_TOKENS = "20000";
    process.env.WAYANG_MEMORY_FIRST_STANDARD_ROUTE = "external-memory";
    assert.throws(() => getConfig(), /STANDARD_ROUTE must be memoriki/);
    process.env.WAYANG_MEMORY_FIRST_STANDARD_ROUTE = "memoriki";
    process.env.WAYANG_MEMORY_FIRST_PROTECTED_PROJECT_PATH = "../outside.md";
    assert.throws(() => getConfig(), /traversal-free project-local path/);
    process.env.WAYANG_MEMORY_FIRST_PROTECTED_PROJECT_PATH = ".wayang/memory.md";
    process.env.WAYANG_MEMORY_FIRST_KEEP_COMPLETE_TURNS = "yes";
    assert.throws(() => getConfig(), /KEEP_COMPLETE_TURNS must be 0 or 1/);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("file-audio experiment is disabled by default with a bounded short permit TTL", () => {
  const previousEnabled = process.env.WAYANG_FILE_AUDIO_EXPERIMENT_ENABLED;
  const previousTtl = process.env.WAYANG_FILE_AUDIO_EXPERIMENT_PERMIT_TTL_MS;
  const previousFfmpeg = process.env.WAYANG_FILE_AUDIO_EXPERIMENT_FFMPEG_PATH;
  const previousFfprobe = process.env.WAYANG_FILE_AUDIO_EXPERIMENT_FFPROBE_PATH;
  try {
    delete process.env.WAYANG_FILE_AUDIO_EXPERIMENT_ENABLED;
    delete process.env.WAYANG_FILE_AUDIO_EXPERIMENT_PERMIT_TTL_MS;
    delete process.env.WAYANG_FILE_AUDIO_EXPERIMENT_FFMPEG_PATH;
    delete process.env.WAYANG_FILE_AUDIO_EXPERIMENT_FFPROBE_PATH;
    assert.equal(getConfig().fileAudioExperiment.enabled, false);
    assert.equal(getConfig().fileAudioExperiment.permitTtlMs, 60_000);
    assert.equal(getConfig().fileAudioExperiment.ffmpegPath, "/usr/bin/ffmpeg");
    assert.equal(getConfig().fileAudioExperiment.ffprobePath, "/usr/bin/ffprobe");

    process.env.WAYANG_FILE_AUDIO_EXPERIMENT_ENABLED = "1";
    process.env.WAYANG_FILE_AUDIO_EXPERIMENT_PERMIT_TTL_MS = "120000";
    assert.equal(getConfig().fileAudioExperiment.enabled, true);
    assert.equal(getConfig().fileAudioExperiment.permitTtlMs, 120_000);

    process.env.WAYANG_FILE_AUDIO_EXPERIMENT_PERMIT_TTL_MS = "120001";
    assert.throws(() => getConfig(), /WAYANG_FILE_AUDIO_EXPERIMENT_PERMIT_TTL_MS/);
    process.env.WAYANG_FILE_AUDIO_EXPERIMENT_ENABLED = "yes";
    assert.throws(() => getConfig(), /WAYANG_FILE_AUDIO_EXPERIMENT_ENABLED must be 0 or 1/);
  } finally {
    if (previousEnabled === undefined) delete process.env.WAYANG_FILE_AUDIO_EXPERIMENT_ENABLED;
    else process.env.WAYANG_FILE_AUDIO_EXPERIMENT_ENABLED = previousEnabled;
    if (previousTtl === undefined) delete process.env.WAYANG_FILE_AUDIO_EXPERIMENT_PERMIT_TTL_MS;
    else process.env.WAYANG_FILE_AUDIO_EXPERIMENT_PERMIT_TTL_MS = previousTtl;
    if (previousFfmpeg === undefined) delete process.env.WAYANG_FILE_AUDIO_EXPERIMENT_FFMPEG_PATH;
    else process.env.WAYANG_FILE_AUDIO_EXPERIMENT_FFMPEG_PATH = previousFfmpeg;
    if (previousFfprobe === undefined) delete process.env.WAYANG_FILE_AUDIO_EXPERIMENT_FFPROBE_PATH;
    else process.env.WAYANG_FILE_AUDIO_EXPERIMENT_FFPROBE_PATH = previousFfprobe;
  }
});
