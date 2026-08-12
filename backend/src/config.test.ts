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

    for (const invalid of ["", "true", "01", " 1", "1 "]) {
      process.env.WAYANG_STANDARD_BROWSER_PROFILE_HOSTS = invalid;
      assert.throws(
        () => getConfig(),
        /WAYANG_STANDARD_BROWSER_PROFILE_HOSTS must be 0 or 1/,
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
