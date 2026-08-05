import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_EXPERIMENT_PROMPT_ECHO_MIN_CHARS,
  AUDIO_EXPERIMENT_RESPONSE_VERSION,
  AudioExperimentResponseError,
  MAX_AUDIO_EXPERIMENT_RESPONSE_DEPTH,
  assertNoAudioExperimentPromptEcho,
  parseAudioExperimentResponse,
  parseAudioExperimentResponseText,
  parseDirectAudioExperimentResponse,
  parseSynthesisAudioExperimentResponseText,
} from "./response.js";

function text(length: number): string {
  return "x ".repeat(Math.ceil(length / 2)).slice(0, length);
}

function temporal(source_basis: "direct_audio" | "candidate_report" | "dsp" | "cross_artifact" = "direct_audio") {
  return {
    phase: "opening",
    observation: "Synthetic observation.",
    evidence: "Synthetic evidence.",
    source_basis,
    confidence: "medium",
  };
}

function direct() {
  return {
    schema_version: AUDIO_EXPERIMENT_RESPONSE_VERSION,
    mode: "direct_encounter",
    input_basis: "direct_audio",
    temporal_observations: [temporal()],
    immediate_response: {
      opening: "A quiet synthetic opening.",
      developments: "A bounded synthetic development.",
      residue: "A short synthetic residue.",
    },
    interpretation: {
      primary: "The synthetic material develops consistently.",
      alternatives: [],
    },
    uncertainties: [],
    crystallized_record: {
      core: "Synthetic core record.",
      anchors: ["Synthetic anchor."],
    },
    synthesis: null,
  };
}

function synthesis() {
  return {
    schema_version: AUDIO_EXPERIMENT_RESPONSE_VERSION,
    mode: "synthesis",
    input_basis: "artifacts_only",
    temporal_observations: [temporal("candidate_report"), temporal("dsp"), temporal("cross_artifact")],
    immediate_response: null,
    interpretation: {
      primary: "The synthetic artifacts broadly agree.",
      alternatives: ["One bounded alternative."],
    },
    uncertainties: [{ question: "What remains unknown?", reason: "The source is synthetic." }],
    crystallized_record: {
      core: "Synthetic synthesis record.",
      anchors: ["Candidate report", "DSP artifact"],
    },
    synthesis: {
      agreements: ["Candidates agree on the opening."],
      disagreements: [{
        topic: "Intensity",
        candidate_positions: "Candidate A says low; candidate B says medium.",
        resolution: "Retain the bounded disagreement.",
      }],
      dsp_correspondences: ["The local envelope corresponds to the reported development."],
      added_value: "Cross-artifact comparison adds bounded context.",
      limits: "No direct audio was available to synthesis.",
    },
  };
}

function assertResponseError(error: unknown): boolean {
  assert.ok(error instanceof AudioExperimentResponseError);
  assert.equal(error.message.includes("Synthetic"), false);
  return true;
}

test("parses and freezes exact direct_encounter and synthesis contracts", () => {
  const parsedDirect = parseDirectAudioExperimentResponse(direct());
  assert.deepEqual(parsedDirect, direct());
  assert.equal(Object.isFrozen(parsedDirect), true);
  assert.equal(Object.isFrozen(parsedDirect.temporal_observations), true);
  assert.equal(Object.isFrozen(parsedDirect.temporal_observations[0]), true);
  assert.equal(Object.isFrozen(parsedDirect.immediate_response), true);

  const parsedSynthesis = parseSynthesisAudioExperimentResponseText(JSON.stringify(synthesis()));
  assert.deepEqual(parsedSynthesis, synthesis());
  assert.equal(Object.isFrozen(parsedSynthesis.synthesis), true);
  assert.equal(Object.isFrozen(parsedSynthesis.synthesis.disagreements[0]), true);
});

test("enforces mode, input_basis, immediate_response, and synthesis conditionals", () => {
  const invalid: unknown[] = [
    { ...direct(), mode: "direct" },
    { ...direct(), input_basis: "artifacts_only" },
    { ...direct(), immediate_response: null },
    { ...direct(), synthesis: synthesis().synthesis },
    { ...synthesis(), mode: "direct_encounter" },
    { ...synthesis(), input_basis: "direct_audio" },
    { ...synthesis(), immediate_response: direct().immediate_response },
    { ...synthesis(), synthesis: null },
  ];
  for (const value of invalid) {
    assert.throws(() => parseAudioExperimentResponse(value), assertResponseError);
  }
  assert.throws(
    () => parseAudioExperimentResponse(direct(), { expectedMode: "synthesis" }),
    assertResponseError,
  );
});

test("enforces runtime temporal source_basis conditioning beyond structural schema", () => {
  for (const source_basis of ["candidate_report", "dsp", "cross_artifact"] as const) {
    assert.throws(
      () => parseAudioExperimentResponse({
        ...direct(),
        temporal_observations: [temporal(source_basis)],
      }),
      assertResponseError,
    );
  }
  assert.throws(
    () => parseAudioExperimentResponse({
      ...synthesis(),
      temporal_observations: [temporal("direct_audio")],
    }),
    assertResponseError,
  );
  for (const source_basis of ["candidate_report", "dsp", "cross_artifact"] as const) {
    assert.doesNotThrow(() => parseAudioExperimentResponse({
      ...synthesis(),
      temporal_observations: [temporal(source_basis)],
    }));
  }
});

test("rejects additional properties on every schema object", () => {
  const baseDirect = direct();
  const baseSynthesis = synthesis();
  const invalid: unknown[] = [
    { ...baseDirect, extra: true },
    { ...baseDirect, temporal_observations: [{ ...baseDirect.temporal_observations[0], extra: true }] },
    { ...baseDirect, immediate_response: { ...baseDirect.immediate_response, extra: true } },
    { ...baseDirect, interpretation: { ...baseDirect.interpretation, extra: true } },
    { ...baseDirect, uncertainties: [{ question: "q", reason: "r", extra: true }] },
    { ...baseDirect, crystallized_record: { ...baseDirect.crystallized_record, extra: true } },
    { ...baseSynthesis, synthesis: { ...baseSynthesis.synthesis, extra: true } },
    {
      ...baseSynthesis,
      synthesis: {
        ...baseSynthesis.synthesis,
        disagreements: [{ ...baseSynthesis.synthesis.disagreements[0], extra: true }],
      },
    },
  ];
  for (const value of invalid) {
    assert.throws(() => parseAudioExperimentResponse(value), assertResponseError);
  }
});

test("accepts every documented maximum bound", () => {
  const maxDirect = {
    ...direct(),
    temporal_observations: Array.from({ length: 12 }, () => ({
      phase: text(120),
      observation: text(1_200),
      evidence: text(1_200),
      source_basis: "direct_audio",
      confidence: "high",
    })),
    immediate_response: {
      opening: text(1_200),
      developments: text(1_800),
      residue: text(1_200),
    },
    interpretation: {
      primary: text(2_000),
      alternatives: Array.from({ length: 4 }, () => text(1_000)),
    },
    uncertainties: Array.from({ length: 8 }, () => ({ question: text(800), reason: text(1_000) })),
    crystallized_record: {
      core: text(1_600),
      anchors: Array.from({ length: 6 }, () => text(600)),
    },
  };
  assert.doesNotThrow(() => parseAudioExperimentResponse(maxDirect));

  const maxSynthesis = {
    ...synthesis(),
    synthesis: {
      agreements: Array.from({ length: 10 }, () => text(1_000)),
      disagreements: Array.from({ length: 10 }, () => ({
        topic: text(600),
        candidate_positions: text(1_400),
        resolution: text(1_000),
      })),
      dsp_correspondences: Array.from({ length: 10 }, () => text(1_200)),
      added_value: text(1_600),
      limits: text(1_600),
    },
  };
  assert.doesNotThrow(() => parseAudioExperimentResponse(maxSynthesis));
});

test("enforces every documented array count", () => {
  const baseDirect = direct();
  const baseSynthesis = synthesis();
  assert.doesNotThrow(() => parseAudioExperimentResponse({
    ...baseSynthesis,
    synthesis: {
      ...baseSynthesis.synthesis,
      agreements: [],
      disagreements: [],
      dsp_correspondences: [],
    },
  }));
  const invalid: unknown[] = [
    { ...baseDirect, temporal_observations: [] },
    { ...baseDirect, temporal_observations: Array.from({ length: 13 }, () => temporal()) },
    { ...baseDirect, interpretation: { primary: "p", alternatives: Array(5).fill("a") } },
    { ...baseDirect, uncertainties: Array.from({ length: 9 }, () => ({ question: "q", reason: "r" })) },
    { ...baseDirect, crystallized_record: { core: "c", anchors: [] } },
    { ...baseDirect, crystallized_record: { core: "c", anchors: Array(7).fill("a") } },
    { ...baseSynthesis, synthesis: { ...baseSynthesis.synthesis, agreements: Array(11).fill("a") } },
    {
      ...baseSynthesis,
      synthesis: {
        ...baseSynthesis.synthesis,
        disagreements: Array.from({ length: 11 }, () => ({
          topic: "t", candidate_positions: "p", resolution: "r",
        })),
      },
    },
    { ...baseSynthesis, synthesis: { ...baseSynthesis.synthesis, dsp_correspondences: Array(11).fill("d") } },
  ];
  for (const value of invalid) {
    assert.throws(() => parseAudioExperimentResponse(value), assertResponseError);
  }
});

test("rejects every documented string maximum and required-string minimum", () => {
  const d = direct();
  const s = synthesis();
  const temporalBase = temporal();
  const invalid: unknown[] = [
    { ...d, schema_version: "wrong" },
    { ...d, temporal_observations: [{ ...temporalBase, phase: "" }] },
    { ...d, temporal_observations: [{ ...temporalBase, phase: text(121) }] },
    { ...d, temporal_observations: [{ ...temporalBase, observation: "" }] },
    { ...d, temporal_observations: [{ ...temporalBase, observation: text(1_201) }] },
    { ...d, temporal_observations: [{ ...temporalBase, evidence: "" }] },
    { ...d, temporal_observations: [{ ...temporalBase, evidence: text(1_201) }] },
    { ...d, temporal_observations: [{ ...temporalBase, confidence: "certain" }] },
    { ...d, temporal_observations: [{ ...temporalBase, source_basis: "raw_audio" }] },
    { ...d, immediate_response: { ...d.immediate_response, opening: "" } },
    { ...d, immediate_response: { ...d.immediate_response, opening: text(1_201) } },
    { ...d, immediate_response: { ...d.immediate_response, developments: "" } },
    { ...d, immediate_response: { ...d.immediate_response, developments: text(1_801) } },
    { ...d, immediate_response: { ...d.immediate_response, residue: "" } },
    { ...d, immediate_response: { ...d.immediate_response, residue: text(1_201) } },
    { ...d, interpretation: { ...d.interpretation, primary: "" } },
    { ...d, interpretation: { ...d.interpretation, primary: text(2_001) } },
    { ...d, interpretation: { ...d.interpretation, alternatives: [""] } },
    { ...d, interpretation: { ...d.interpretation, alternatives: [text(1_001)] } },
    { ...d, uncertainties: [{ question: "", reason: "r" }] },
    { ...d, uncertainties: [{ question: text(801), reason: "r" }] },
    { ...d, uncertainties: [{ question: "q", reason: "" }] },
    { ...d, uncertainties: [{ question: "q", reason: text(1_001) }] },
    { ...d, crystallized_record: { ...d.crystallized_record, core: "" } },
    { ...d, crystallized_record: { ...d.crystallized_record, core: text(1_601) } },
    { ...d, crystallized_record: { ...d.crystallized_record, anchors: [""] } },
    { ...d, crystallized_record: { ...d.crystallized_record, anchors: [text(601)] } },
    { ...s, synthesis: { ...s.synthesis, agreements: [""] } },
    { ...s, synthesis: { ...s.synthesis, agreements: [text(1_001)] } },
    {
      ...s,
      synthesis: {
        ...s.synthesis,
        disagreements: [{ topic: "", candidate_positions: "p", resolution: "r" }],
      },
    },
    {
      ...s,
      synthesis: {
        ...s.synthesis,
        disagreements: [{ topic: text(601), candidate_positions: "p", resolution: "r" }],
      },
    },
    {
      ...s,
      synthesis: {
        ...s.synthesis,
        disagreements: [{ topic: "t", candidate_positions: "", resolution: "r" }],
      },
    },
    {
      ...s,
      synthesis: {
        ...s.synthesis,
        disagreements: [{ topic: "t", candidate_positions: text(1_401), resolution: "r" }],
      },
    },
    {
      ...s,
      synthesis: {
        ...s.synthesis,
        disagreements: [{ topic: "t", candidate_positions: "p", resolution: "" }],
      },
    },
    {
      ...s,
      synthesis: {
        ...s.synthesis,
        disagreements: [{ topic: "t", candidate_positions: "p", resolution: text(1_001) }],
      },
    },
    { ...s, synthesis: { ...s.synthesis, dsp_correspondences: [""] } },
    { ...s, synthesis: { ...s.synthesis, dsp_correspondences: [text(1_201)] } },
    { ...s, synthesis: { ...s.synthesis, added_value: "" } },
    { ...s, synthesis: { ...s.synthesis, added_value: text(1_601) } },
    { ...s, synthesis: { ...s.synthesis, limits: "" } },
    { ...s, synthesis: { ...s.synthesis, limits: text(1_601) } },
  ];
  for (const value of invalid) {
    assert.throws(() => parseAudioExperimentResponse(value), assertResponseError);
  }
});

test("keeps aggregate depth/text safety and rejects long base64-like strings", () => {
  const invalid: unknown[] = [
    { ...direct(), immediate_response: { ...direct().immediate_response, opening: "A".repeat(256) } },
    { ...direct(), immediate_response: { ...direct().immediate_response, opening: "_-".repeat(128) } },
    {
      ...direct(),
      immediate_response: {
        ...direct().immediate_response,
        opening: `${"A".repeat(128)}\n${"B".repeat(128)}`,
      },
    },
    { ...direct(), immediate_response: { ...direct().immediate_response, opening: "bad\u0000text" } },
  ];
  for (const value of invalid) {
    assert.throws(() => parseAudioExperimentResponse(value), assertResponseError);
  }

  let nested: unknown = "leaf";
  for (let index = 0; index < MAX_AUDIO_EXPERIMENT_RESPONSE_DEPTH + 2; index += 1) nested = { nested };
  assert.throws(() => parseAudioExperimentResponse(nested), assertResponseError);
});

test("rejects malformed JSON and non-exact expected modes", () => {
  assert.throws(() => parseAudioExperimentResponseText("```json\n{}\n```"), assertResponseError);
  assert.throws(
    () => parseAudioExperimentResponse(synthesis(), { expectedMode: "direct_encounter" }),
    assertResponseError,
  );
});

test("echo guard rejects exact and normalized-whitespace private-prompt chunks", () => {
  const exactChunk = "private adapter sentence ".repeat(4);
  assert.ok(exactChunk.length >= AUDIO_EXPERIMENT_PROMPT_ECHO_MIN_CHARS);
  const sources = {
    instructions: `prefix ${exactChunk} suffix`,
    task: "A separate synthetic task that is intentionally shorter than the protected chunk threshold.",
    schemaText: "A separate synthetic schema description with no overlap in the output.",
  };
  assert.throws(
    () => assertNoAudioExperimentPromptEcho(`response copied ${exactChunk} verbatim`, sources),
    assertResponseError,
  );
  assert.throws(
    () => assertNoAudioExperimentPromptEcho(
      `response copied ${exactChunk.replace(/ /g, " \n\t ")} with whitespace changed`,
      sources,
    ),
    assertResponseError,
  );
});

test("echo guard ignores short fragments and never includes private text in errors", () => {
  assert.doesNotThrow(() => assertNoAudioExperimentPromptEcho("short private phrase", {
    instructions: "short private phrase",
    task: "synthetic task",
    schemaText: "synthetic schema",
  }));

  const privateText = `do-not-log-${"private-".repeat(12)}`;
  assert.throws(
    () => assertNoAudioExperimentPromptEcho(privateText, {
      instructions: privateText,
      task: "synthetic task",
      schemaText: "synthetic schema",
    }),
    (error: unknown) => {
      assertResponseError(error);
      assert.equal((error as Error).message.includes(privateText), false);
      return true;
    },
  );
});
