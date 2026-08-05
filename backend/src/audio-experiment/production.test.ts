import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareAttachments } from "../attachments.js";
import type { FileAudioExperimentConfig } from "../config.js";
import { issueBrowserTurnProvenance } from "../interactive-turn-provenance.js";
import type { SanitizedAudio } from "./media.js";
import type { ArmCRepresentations } from "./dsp.js";
import {
  FILE_AUDIO_OPENAI_MODEL,
  bootstrapFileAudioExperimentProduction,
  createFileAudioExperimentProductionDependencies,
  readPrivateFileAudioPrompt,
} from "./production.js";
import { createFileAudioExperimentRuntime } from "./tools.js";
import type { FileAudioExperimentBinding } from "./types.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x53]);
const CAPSULE = Buffer.from("SYNTHETIC PRIVATE WREN CAPSULE");
const TASK = Buffer.from("SYNTHETIC SHARED TASK");
const NEUTRAL = Buffer.from("SYNTHETIC PRIVATE NEUTRAL ADAPTER");
const SCHEMA = Buffer.from("SYNTHETIC PRIVATE RESPONSE SCHEMA");
const SOL_PROMPT = Buffer.from("SYNTHETIC PRIVATE SOL SYNTHESIS INSTRUCTIONS ".repeat(2));
const API_KEY = "synthetic-production-key";
const PATHS = {
  capsule: "/synthetic/private/wren.txt",
  task: "/synthetic/private/task.txt",
  neutral: "/synthetic/private/neutral.txt",
  schema: "/synthetic/private/schema.txt",
  sol: "/synthetic/private/sol.txt",
};

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function config(overrides: Partial<FileAudioExperimentConfig> = {}): FileAudioExperimentConfig {
  return {
    enabled: false,
    permitTtlMs: 60_000,
    wrenCapsulePath: PATHS.capsule,
    wrenCapsuleSha256: sha256(CAPSULE),
    sharedTaskPath: PATHS.task,
    sharedTaskSha256: sha256(TASK),
    neutralAdapterPath: PATHS.neutral,
    neutralAdapterSha256: sha256(NEUTRAL),
    responseSchemaPath: PATHS.schema,
    responseSchemaSha256: sha256(SCHEMA),
    solSynthesisPromptPath: PATHS.sol,
    solSynthesisPromptSha256: sha256(SOL_PROMPT),
    mediaTempRoot: "/synthetic/private/media-tmp",
    ffmpegPath: "/synthetic/bin/ffmpeg",
    ffprobePath: "/synthetic/bin/ffprobe",
    ...overrides,
  };
}

function wav(): Buffer {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(8_000, 4);
  fmt.writeUInt32LE(8_000, 8); fmt.writeUInt16LE(1, 12); fmt.writeUInt16LE(8, 14);
  const chunk = (id: string, data: Buffer) => {
    const header = Buffer.alloc(8); header.write(id, 0, 4); header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data]);
  };
  const payload = Buffer.concat([Buffer.from("WAVE"), chunk("fmt ", fmt), chunk("data", Buffer.alloc(80, 0x80))]);
  const header = Buffer.alloc(8); header.write("RIFF", 0, 4); header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function sanitized(source: Buffer, exact: Buffer): SanitizedAudio {
  const validation = {
    format: "wav" as const, byteLength: exact.length, durationSeconds: 0.01,
    sampleRateHz: 8_000, channels: 1, codec: "pcm_u8", audioDataBytes: 80,
  };
  return {
    format: "wav", bytes: exact, byteLength: exact.length, sha256: sha256(exact), sourceSha256: sha256(source),
    sourceValidation: validation, validation, sourceProbe: {} as SanitizedAudio["sourceProbe"],
    probe: {} as SanitizedAudio["probe"], method: "ffmpeg-stream-copy",
    cleanup: { temporaryDirectoryRemoved: true, temporaryFileCount: 2, sourceDeleted: false },
  };
}

function dsp(exact: Buffer): ArmCRepresentations {
  const validation = {
    format: "wav" as const, byteLength: exact.length, durationSeconds: 0.01,
    sampleRateHz: 8_000, channels: 1, codec: "pcm_u8", audioDataBytes: 80,
  };
  const image = { mimeType: "image/png" as const, width: 16, height: 16, bytes: PNG, byteLength: PNG.length, sha256: sha256(PNG) };
  return {
    sourceFormat: "wav", sanitizedSha256: sha256(exact), validation,
    ffprobe: { formatName: "wav", durationSeconds: 0.01, sizeBytes: exact.length, codecName: "pcm_u8", sampleRateHz: 8_000, channels: 1, tags: {} },
    waveform: image, spectrogram: image, frequencyVisual: { ...image, kind: "showfreqs" },
    numericText: "duration_seconds=0.010000\nsample_rate_hz=8000\nchannels=1",
    cleanup: { temporaryDirectoryRemoved: true, temporaryFileCount: 4, sourceDeleted: false },
  };
}

function directText(result: string): string {
  return JSON.stringify({
    schema_version: "audio-experiment.response.v1",
    mode: "direct_encounter",
    input_basis: "direct_audio",
    temporal_observations: [{
      phase: "opening",
      observation: result,
      evidence: "Synthetic direct-audio evidence.",
      source_basis: "direct_audio",
      confidence: "medium",
    }],
    immediate_response: {
      opening: "A quiet synthetic opening.",
      developments: result,
      residue: "A bounded synthetic residue.",
    },
    interpretation: {
      primary: "The synthetic material develops consistently.",
      alternatives: [],
    },
    uncertainties: [],
    crystallized_record: {
      core: result,
      anchors: ["Synthetic direct-audio anchor."],
    },
    synthesis: null,
  });
}

function synthesisObject(addedValue = "Cross-artifact comparison adds bounded context.") {
  return {
    schema_version: "audio-experiment.response.v1",
    mode: "synthesis",
    input_basis: "artifacts_only",
    temporal_observations: [{
      phase: "opening",
      observation: "The blinded reports agree on a quiet opening.",
      evidence: "Both candidate reports describe the same bounded development.",
      source_basis: "candidate_report",
      confidence: "medium",
    }, {
      phase: "development",
      observation: "The local envelope supports the reported development.",
      evidence: "Bounded DSP metadata and image artifacts correspond.",
      source_basis: "dsp",
      confidence: "medium",
    }],
    immediate_response: null,
    interpretation: {
      primary: "The synthetic artifacts broadly agree.",
      alternatives: ["One bounded alternative remains."],
    },
    uncertainties: [{ question: "What remains unknown?", reason: "The source is synthetic." }],
    crystallized_record: {
      core: "Synthetic blinded synthesis record.",
      anchors: ["Candidate reports", "DSP artifacts"],
    },
    synthesis: {
      agreements: ["The reports agree on the opening."],
      disagreements: [],
      dsp_correspondences: ["The local envelope corresponds to the reported development."],
      added_value: addedValue,
      limits: "Synthesis received artifacts only and no direct audio.",
    },
  };
}

function synthesisText(): string {
  return JSON.stringify(synthesisObject());
}

function runtime(name: string, dependencies: ReturnType<typeof createFileAudioExperimentProductionDependencies>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const prior = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  const sourceSessionId = "12345678-1234-4234-8234-123456789abc";
  const binding: FileAudioExperimentBinding = {
    sourceSessionId, runtimeGeneration: "runtime", processBootNonce: "boot", projectId: "project",
    projectCwd: path.join(root, "project"), agentProfileId: "00000000-0000-4000-8000-000000000001",
    provider: "outer-provider", model: "outer-model",
  };
  const source = wav();
  const upload = prepareAttachments(sourceSessionId, [{ name: "probe.wav", mimeType: "audio/wav", data: source.toString("base64") }]);
  const turn = Object.freeze({
    ...issueBrowserTurnProvenance({ ...binding, acceptedEntryCount: 0 }, "Compare audio"),
    piUserEntryId: "entry",
  });
  const tool = createFileAudioExperimentRuntime({ binding, dependencies, getCurrentTurn: () => turn, isRuntimeCurrent: () => true });
  return {
    source,
    execute: (input: unknown) => (tool.tool.execute as any)("call", input),
    attachmentId: upload.attachmentIds[0]!,
    cleanup() {
      void tool.close();
      if (prior === undefined) delete process.env.WAYANG_DATA_DIR; else process.env.WAYANG_DATA_DIR = prior;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function parse(result: any): any { return JSON.parse(result.content[0].text); }

function artifactReader(promptPath: string): Buffer {
  if (promptPath === PATHS.capsule) return CAPSULE;
  if (promptPath === PATHS.task) return TASK;
  if (promptPath === PATHS.neutral) return NEUTRAL;
  if (promptPath === PATHS.schema) return SCHEMA;
  if (promptPath === PATHS.sol) return SOL_PROMPT;
  assert.fail("unexpected private artifact path");
}

test("private prompt reader remains owner-private, absolute, and no-follow", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-audio-private-"));
  try {
    const file = path.join(root, "prompt.txt");
    fs.writeFileSync(file, "synthetic prompt", { mode: 0o600 });
    assert.equal(readPrivateFileAudioPrompt(file).toString(), "synthetic prompt");
    assert.throws(() => readPrivateFileAudioPrompt("relative"), /configuration is invalid/);
    if (process.platform !== "win32") {
      const link = path.join(root, "link"); fs.symlinkSync(file, link);
      assert.throws(() => readPrivateFileAudioPrompt(link), /validation failed/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("production is startup/preview inert and composes exact A/B roles then DSP into isolated validated Sol", async () => {
  const effects = { reads: 0, keys: 0, sanitize: 0, dsp: 0, audio: 0, sol: 0 };
  const audioBodies: any[] = [];
  let solBody: any;
  const exact = wav();
  const ports = {
    readPrivatePrompt(promptPath: string) { effects.reads++; return artifactReader(promptPath); },
    resolveOpenAiApiKey() { effects.keys++; return API_KEY; },
    async sanitize(source: Uint8Array) { effects.sanitize++; return sanitized(Buffer.from(source), exact); },
    async generateArmC(input: Uint8Array) { effects.dsp++; assert.equal(input, exact); return dsp(exact); },
    async audioTransport(_endpoint: string, init: RequestInit) {
      effects.audio++; const body = JSON.parse(init.body as string); audioBodies.push(body);
      return new Response(JSON.stringify({
        id: `direct-${effects.audio}`, model: FILE_AUDIO_OPENAI_MODEL,
        choices: [{ message: { content: directText(effects.audio === 1 ? "option north" : "option south") } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }), { status: 200 });
    },
    async solTransport(_endpoint: string, init: RequestInit) {
      effects.sol++; solBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        id: "sol-response", model: "gpt-5.6-sol", choices: [{ message: { content: synthesisText() } }],
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
      }), { status: 200 });
    },
  };
  const dependencies = createFileAudioExperimentProductionDependencies(config(), ports);
  const bootstrap = bootstrapFileAudioExperimentProduction(config(), ports);
  assert.deepEqual(effects, { reads: 0, keys: 0, sanitize: 0, dsp: 0, audio: 0, sol: 0 });
  await bootstrap.close();

  const f = runtime("wayang-audio-production-", dependencies);
  try {
    const permit = parse(await f.execute({ operation: "preview", attachment_id: f.attachmentId })).permit_id;
    assert.deepEqual(effects, { reads: 0, keys: 0, sanitize: 0, dsp: 0, audio: 0, sol: 0 });
    const toolResult = await f.execute({ operation: "execute", permit_id: permit });
    assert.deepEqual(effects, { reads: 6, keys: 3, sanitize: 1, dsp: 1, audio: 2, sol: 1 });

    assert.equal(audioBodies[0].messages[0].role, "developer");
    assert.equal(audioBodies[0].messages[0].content, CAPSULE.toString());
    assert.equal(audioBodies[1].messages[0].role, "developer");
    assert.equal(audioBodies[1].messages[0].content, NEUTRAL.toString());
    assert.equal(audioBodies[0].messages[1].role, "user");
    assert.equal(audioBodies[0].messages[1].content[0].text, TASK.toString());
    assert.equal(audioBodies[1].messages[1].content[0].text, TASK.toString());
    assert.equal(audioBodies[0].messages[1].content[1].text, SCHEMA.toString());
    assert.deepEqual(
      Buffer.from(audioBodies[0].messages[1].content[2].input_audio.data, "base64"),
      Buffer.from(audioBodies[1].messages[1].content[2].input_audio.data, "base64"),
    );

    assert.equal(solBody.model, "gpt-5.6-sol");
    assert.equal(solBody.messages[0].role, "developer");
    assert.equal(solBody.messages[0].content, SOL_PROMPT.toString());
    assert.equal(solBody.messages[1].role, "user");
    assert.equal(solBody.messages[1].content.filter((part: any) => part.type === "image_url").length, 3);
    const solArtifacts = JSON.parse(solBody.messages[1].content[0].text);
    const labels = Object.keys(solArtifacts.candidate_responses);
    assert.equal(labels.length, 2);
    assert.match(labels[0]!, /^[a-f0-9]{32}$/);
    assert.match(labels[1]!, /^[a-f0-9]{32}$/);
    assert.notEqual(labels[0], labels[1]);

    const publicValue = parse(toolResult);
    assert.equal(toolResult.content.length, 1, "DSP PNG blocks stay isolated from the outer model");
    assert.equal(publicValue.candidates.length, 2);
    assert.equal(publicValue.synthesis.response.mode, "synthesis");
    assert.equal(publicValue.dsp.artifacts.length, 3);
    const publicText = toolResult.content[0].text as string;
    for (const forbidden of [
      CAPSULE.toString(), TASK.toString(), NEUTRAL.toString(), SCHEMA.toString(), SOL_PROMPT.toString(), API_KEY,
      exact.toString("base64"), ...Object.values(PATHS), config().mediaTempRoot, config().ffmpegPath,
      "wren-gpt-audio", "neutral-gpt-audio", "deterministic-local-dsp", "image_url",
    ]) assert.equal(publicText.includes(forbidden), false, forbidden);
  } finally { f.cleanup(); }
});

test("the isolated synthesis validator rejects a 64-character private-prompt echo", async () => {
  const exact = wav();
  let audioCalls = 0;
  const echoed = JSON.stringify(synthesisObject(SOL_PROMPT.toString()));
  const dependencies = createFileAudioExperimentProductionDependencies(config(), {
    readPrivatePrompt: artifactReader,
    resolveOpenAiApiKey: () => API_KEY,
    async sanitize(source) { return sanitized(Buffer.from(source), exact); },
    async generateArmC() { return dsp(exact); },
    async audioTransport() {
      audioCalls++;
      return new Response(JSON.stringify({
        id: `direct-${audioCalls}`, model: FILE_AUDIO_OPENAI_MODEL,
        choices: [{ message: { content: directText(audioCalls === 1 ? "option north" : "option south") } }],
      }), { status: 200 });
    },
    async solTransport() {
      return new Response(JSON.stringify({
        id: "sol-echo", model: "gpt-5.6-sol", choices: [{ message: { content: echoed } }],
      }), { status: 200 });
    },
  });
  const f = runtime("wayang-audio-sol-echo-", dependencies);
  try {
    const permit = parse(await f.execute({ operation: "preview", attachment_id: f.attachmentId })).permit_id;
    await assert.rejects(() => f.execute({ operation: "execute", permit_id: permit }), /response was invalid/);
  } finally { f.cleanup(); }
});

test("a synthesis hash failure occurs only after complete A/B plus DSP and before Sol key/transport", async () => {
  const effects = { reads: 0, keys: 0, audio: 0, dsp: 0, sol: 0 };
  const exact = wav();
  const dependencies = createFileAudioExperimentProductionDependencies(
    config({ solSynthesisPromptSha256: "0".repeat(64) }),
    {
      readPrivatePrompt(promptPath) { effects.reads++; return artifactReader(promptPath); },
      resolveOpenAiApiKey() { effects.keys++; return API_KEY; },
      async sanitize(source) { return sanitized(Buffer.from(source), exact); },
      async generateArmC() { effects.dsp++; return dsp(exact); },
      async audioTransport() {
        effects.audio++;
        return new Response(JSON.stringify({
          id: `direct-${effects.audio}`, model: FILE_AUDIO_OPENAI_MODEL,
          choices: [{ message: { content: directText(effects.audio === 1 ? "option north" : "option south") } }],
        }), { status: 200 });
      },
      async solTransport() { effects.sol++; assert.fail("Sol transport must not run"); },
    },
  );
  const f = runtime("wayang-audio-sol-hash-", dependencies);
  try {
    const permit = parse(await f.execute({ operation: "preview", attachment_id: f.attachmentId })).permit_id;
    await assert.rejects(() => f.execute({ operation: "execute", permit_id: permit }), /Sol synthesis prompt digest mismatch/);
    assert.equal(effects.audio, 2);
    assert.equal(effects.dsp, 1);
    assert.equal(effects.keys, 2, "Sol key is not resolved after its prompt hash fails");
    assert.equal(effects.sol, 0);
  } finally { f.cleanup(); }
});
