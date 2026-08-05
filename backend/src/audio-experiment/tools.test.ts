import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareAttachments } from "../attachments.js";
import { issueBrowserTurnProvenance, type BrowserTurnProvenance } from "../interactive-turn-provenance.js";
import { normalizeFileAudioArms } from "./path.js";
import { createFileAudioExperimentRuntime } from "./tools.js";
import type {
  FileAudioExperimentBinding,
  FileAudioExperimentDependencies,
} from "./types.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x53]);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");

function direct(result: string) {
  return {
    schema_version: "audio-experiment.response.v1" as const,
    mode: "direct_encounter" as const,
    input_basis: "direct_audio" as const,
    temporal_observations: [{
      phase: "opening",
      observation: result,
      evidence: "Synthetic direct-audio evidence.",
      source_basis: "direct_audio" as const,
      confidence: "medium" as const,
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
  };
}

function synthesized() {
  return {
    schema_version: "audio-experiment.response.v1" as const,
    mode: "synthesis" as const,
    input_basis: "artifacts_only" as const,
    temporal_observations: [{
      phase: "opening",
      observation: "The blinded reports agree on a quiet opening.",
      evidence: "Both candidate reports describe the same bounded development.",
      source_basis: "candidate_report" as const,
      confidence: "medium" as const,
    }, {
      phase: "development",
      observation: "The local envelope supports the reported development.",
      evidence: "Bounded DSP metadata and image artifacts correspond.",
      source_basis: "dsp" as const,
      confidence: "medium" as const,
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
      added_value: "Cross-artifact comparison adds bounded context.",
      limits: "Synthesis received artifacts only and no direct audio.",
    },
  };
}

function parsed(result: any): any {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

function fixture(name: string, options: { gate?: Promise<void>; now?: () => number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  const sourceSessionId = "12345678-1234-4234-8234-123456789abc";
  const binding: FileAudioExperimentBinding = {
    sourceSessionId,
    runtimeGeneration: "runtime-a",
    processBootNonce: "boot-a",
    projectId: "project-a",
    projectCwd: path.join(root, "project"),
    agentProfileId: "00000000-0000-4000-8000-000000000001",
    provider: "synthetic-provider",
    model: "synthetic-outer-model",
  };
  const issued = issueBrowserTurnProvenance(
    { ...binding, acceptedEntryCount: 0 },
    "Compare this audio",
    options.now?.() ?? Date.now(),
  );
  let currentTurn: BrowserTurnProvenance | null = Object.freeze({ ...issued, piUserEntryId: "entry-a" });
  const calls: string[] = [];
  let synthesisInput: Parameters<FileAudioExperimentDependencies["synthesis"]["synthesize"]>[0] | undefined;
  const dependencies: FileAudioExperimentDependencies = {
    media: {
      async inspect({ bytes, signal }) {
        calls.push("media");
        if (options.gate) await options.gate;
        if (signal.aborted) throw new Error("revoked");
        return { bytes, format: "wav", mimeType: "audio/wav" };
      },
    },
    providerPrompts: { async prepare() { calls.push("prompts"); } },
    wrenAdapter: {
      arm: "A",
      async analyze({ media }) {
        calls.push("A");
        return {
          arm: "A", implementation: "PRIVATE_WREN_IMPLEMENTATION", response: direct("Synthetic option alpha."),
          provider: { responseId: "direct-one", model: "gpt-audio-1.5", usage: null },
        };
      },
    },
    neutralAdapter: {
      arm: "B",
      async analyze({ media }) {
        calls.push("B");
        return {
          arm: "B", implementation: "PRIVATE_NEUTRAL_IMPLEMENTATION", response: direct("Synthetic option beta."),
          provider: { responseId: "direct-two", model: "gpt-audio-1.5", usage: null },
        };
      },
    },
    dsp: {
      async analyze() {
        calls.push("DSP");
        return {
          implementation: "PRIVATE_DSP_IMPLEMENTATION",
          numericText: "duration_seconds=1.000000\nsample_rate_hz=8000",
          metadata: { sanitized_sha256: "1".repeat(64), channels: 1 },
          images: ["waveform", "spectrogram", "frequency-showfreqs"].map((label) => ({
            label, mimeType: "image/png" as const, width: 16, height: 16, bytes: PNG, sha256: PNG_SHA,
          })),
        };
      },
    },
    synthesis: {
      async synthesize(input) {
        calls.push("Sol");
        synthesisInput = input;
        assert.deepEqual(new Set(input.candidates.map((candidate) => candidate.result.arm)), new Set(["A", "B"]));
        assert.equal(input.dsp.images.length, 3);
        return {
          response: synthesized(),
          provider: { responseId: "sol-one", model: "gpt-5.6-sol", usage: null },
        };
      },
    },
  };
  const upload = prepareAttachments(sourceSessionId, [{
    name: "probe.wav",
    mimeType: "audio/wav",
    data: Buffer.from("RIFF_SYNTHETIC_AUDIO_CANARY").toString("base64"),
  }]);
  const runtime = createFileAudioExperimentRuntime({
    binding,
    dependencies,
    getCurrentTurn: () => currentTurn,
    isRuntimeCurrent: () => true,
    permitTtlMs: 1_000,
    now: options.now,
  });
  return {
    attachmentId: upload.attachmentIds[0]!, calls,
    execute: (input: unknown) => (runtime.tool.execute as any)("synthetic-call", input),
    get currentTurn() { return currentTurn; },
    setCurrentTurn(value: BrowserTurnProvenance | null) { currentTurn = value; },
    get synthesisInput() { return synthesisInput; },
    cleanup() {
      void runtime.close();
      if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
      else process.env.WAYANG_DATA_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function preview(f: ReturnType<typeof fixture>): Promise<any> {
  return parsed(await f.execute({ operation: "preview", attachment_id: f.attachmentId }));
}

test("the retained arm helper rejects partial, duplicate, and reordered topologies", () => {
  assert.deepEqual(normalizeFileAudioArms(undefined), ["A", "B", "C"]);
  assert.deepEqual(normalizeFileAudioArms(["A", "B", "C"]), ["A", "B", "C"]);
  assert.throws(() => normalizeFileAudioArms(["A", "B"]), /complete A\/B\/C/);
  assert.throws(() => normalizeFileAudioArms(["A", "A", "C"]), /complete A\/B\/C/);
  assert.throws(() => normalizeFileAudioArms(["C", "B", "A"]), /complete A\/B\/C/);
});

test("preview is inert, arm selection is absent, and execute is complete and single-use", async () => {
  const f = fixture("wayang-audio-topology-");
  try {
    await assert.rejects(
      () => f.execute({ operation: "preview", attachment_id: f.attachmentId, arms: ["A"] }),
      /unsupported fields/,
    );
    assert.deepEqual(f.calls, []);
    const permit = await preview(f);
    assert.deepEqual(permit.arms, ["A", "B", "C"]);
    assert.deepEqual(f.calls, []);
    const result = parsed(await f.execute({ operation: "execute", permit_id: permit.permit_id }));
    assert.deepEqual(f.calls, ["media", "prompts", "A", "B", "DSP", "Sol"]);
    assert.equal(result.candidates.length, 2);
    assert.equal(result.synthesis.provider.model, "gpt-5.6-sol");
    assert.equal(result.synthesis.response.mode, "synthesis");
    assert.equal(result.dsp.artifacts.length, 3);
    await assert.rejects(() => f.execute({ operation: "execute", permit_id: permit.permit_id }), /already used/);
  } finally { f.cleanup(); }
});

test("opaque labels are distinct random 128-bit hex and public output has no mapping or private artifacts", async () => {
  const first = fixture("wayang-audio-blind-one-");
  let firstValue: any = null;
  let firstSynthesisLabels: string[] = [];
  try {
    firstValue = parsed(await first.execute({ operation: "execute", permit_id: (await preview(first)).permit_id }));
    firstSynthesisLabels = first.synthesisInput!.candidates.map((candidate) => candidate.label);
  } finally { first.cleanup(); }

  const second = fixture("wayang-audio-blind-two-");
  try {
    const secondValue = parsed(await second.execute({ operation: "execute", permit_id: (await preview(second)).permit_id }));
    const labels = firstValue.candidates.map((candidate: any) => candidate.label);
    assert.match(labels[0], /^[a-f0-9]{32}$/);
    assert.match(labels[1], /^[a-f0-9]{32}$/);
    assert.notEqual(labels[0], labels[1]);
    assert.equal(secondValue.candidates.some((candidate: any) => labels.includes(candidate.label)), false);
    assert.deepEqual(firstSynthesisLabels!, labels);

    const text = JSON.stringify(firstValue);
    for (const forbidden of [
      "PRIVATE_WREN_IMPLEMENTATION", "PRIVATE_NEUTRAL_IMPLEMENTATION", "PRIVATE_DSP_IMPLEMENTATION",
      "synthesis_context", "response_schema", "raw_audio", "audio_base64", "image_url",
      "direct-one", "direct-two", PNG.toString("base64"),
    ]) assert.equal(text.includes(forbidden), false, forbidden);
    assert.equal(Object.hasOwn(firstValue.candidates[0], "arm"), false);
    assert.equal(Object.hasOwn(firstValue.candidates[1], "implementation"), false);
  } finally { second.cleanup(); }
});

test("revoke requires the exact same current turn, including for an in-flight permit", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture("wayang-audio-revoke-turn-", { gate });
  try {
    const permit = await preview(f);
    const original = f.currentTurn!;
    f.setCurrentTurn(Object.freeze({ ...original, token: "next-turn", piUserEntryId: "entry-b" }));
    await assert.rejects(
      () => f.execute({ operation: "revoke", permit_id: permit.permit_id }),
      /exact current user turn/,
    );
    f.setCurrentTurn(original);
    const running = f.execute({ operation: "execute", permit_id: permit.permit_id });
    await new Promise((resolve) => setImmediate(resolve));
    f.setCurrentTurn(Object.freeze({ ...original, token: "next-turn", piUserEntryId: "entry-b" }));
    await assert.rejects(
      () => f.execute({ operation: "revoke", permit_id: permit.permit_id }),
      /exact current user turn/,
    );
    f.setCurrentTurn(original);
    assert.deepEqual(parsed(await f.execute({ operation: "revoke", permit_id: permit.permit_id })), { revoked: true });
    release();
    await assert.rejects(running, /revoked/);
  } finally { release(); f.cleanup(); }
});
