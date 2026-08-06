export const AUDIO_EXPERIMENT_RESPONSE_VERSION = "audio-experiment.response.v1" as const;

export const AUDIO_EXPERIMENT_PROMPT_ECHO_MIN_CHARS = 64;
export const MAX_AUDIO_EXPERIMENT_RESPONSE_BYTES = 128 * 1024;
export const MAX_AUDIO_EXPERIMENT_RESPONSE_STRING_CHARS = 16_384;
export const MAX_AUDIO_EXPERIMENT_RESPONSE_ARRAY_ITEMS = 64;
export const MAX_AUDIO_EXPERIMENT_RESPONSE_OBJECT_PROPERTIES = 32;
export const MAX_AUDIO_EXPERIMENT_RESPONSE_DEPTH = 8;

const MAX_PROMPT_SOURCE_CHARS = 32_000;
const MAX_ECHO_SCAN_OUTPUT_CHARS = 256_000;
const LONG_BASE64_LIKE_CHARS = 256;

export type AudioExperimentResponseMode = "direct_encounter" | "synthesis";
export type AudioExperimentInputBasis = "direct_audio" | "artifacts_only";
export type AudioExperimentTemporalSourceBasis =
  | "direct_audio"
  | "candidate_report"
  | "dsp"
  | "cross_artifact";
export type AudioExperimentConfidence = "low" | "medium" | "high";

export interface AudioExperimentTemporalObservation {
  readonly phase: string;
  readonly observation: string;
  readonly evidence: string;
  readonly source_basis: AudioExperimentTemporalSourceBasis;
  readonly confidence: AudioExperimentConfidence;
}

export interface AudioExperimentImmediateResponse {
  readonly opening: string;
  readonly developments: string;
  readonly residue: string;
}

export interface AudioExperimentInterpretation {
  readonly primary: string;
  readonly alternatives: readonly string[];
}

export interface AudioExperimentUncertainty {
  readonly question: string;
  readonly reason: string;
}

export interface AudioExperimentCrystallizedRecord {
  readonly core: string;
  readonly anchors: readonly string[];
}

export interface AudioExperimentSynthesisDisagreement {
  readonly topic: string;
  readonly candidate_positions: string;
  readonly resolution: string;
}

export interface AudioExperimentSynthesis {
  readonly agreements: readonly string[];
  readonly disagreements: readonly AudioExperimentSynthesisDisagreement[];
  readonly dsp_correspondences: readonly string[];
  readonly added_value: string;
  readonly limits: string;
}

interface AudioExperimentResponseBase {
  readonly schema_version: typeof AUDIO_EXPERIMENT_RESPONSE_VERSION;
  readonly temporal_observations: readonly AudioExperimentTemporalObservation[];
  readonly interpretation: AudioExperimentInterpretation;
  readonly uncertainties: readonly AudioExperimentUncertainty[];
  readonly crystallized_record: AudioExperimentCrystallizedRecord;
}

export interface AudioExperimentDirectResponse extends AudioExperimentResponseBase {
  readonly mode: "direct_encounter";
  readonly input_basis: "direct_audio";
  readonly immediate_response: AudioExperimentImmediateResponse;
  readonly synthesis: null;
}

export interface AudioExperimentSynthesisResponse extends AudioExperimentResponseBase {
  readonly mode: "synthesis";
  readonly input_basis: "artifacts_only";
  readonly immediate_response: null;
  readonly synthesis: AudioExperimentSynthesis;
}

export type AudioExperimentResponse =
  | AudioExperimentDirectResponse
  | AudioExperimentSynthesisResponse;

export interface ParseAudioExperimentResponseOptions {
  readonly expectedMode?: AudioExperimentResponseMode;
}

export interface AudioExperimentPrivatePromptSources {
  readonly instructions: string;
  readonly task: string;
  readonly schemaText: string;
}

/** Fixed-message validation error. It never includes response or private-prompt text. */
export class AudioExperimentResponseError extends Error {
  constructor(message = "Audio experiment response was invalid.") {
    super(message);
    this.name = "AudioExperimentResponseError";
  }
}

/**
 * Reject a meaningful contiguous echo of private adapter/task/schema material.
 *
 * The conservative minimum is 64 characters: shorter common schema phrases are
 * ignored, while any exact or whitespace-normalized 64-character source window
 * appearing in the output is rejected. Inputs are bounded before the linear
 * window-set scan. This function never logs or includes compared text in errors.
 */
export function assertNoAudioExperimentPromptEcho(
  outputText: string,
  sources: AudioExperimentPrivatePromptSources,
): void {
  if (
    typeof outputText !== "string" ||
    outputText.length > MAX_ECHO_SCAN_OUTPUT_CHARS ||
    !isPlainRecord(sources)
  ) {
    throw new AudioExperimentResponseError();
  }

  const sourceTexts = [sources.instructions, sources.task, sources.schemaText];
  if (sourceTexts.some((source) =>
    typeof source !== "string" || source.length === 0 || source.length > MAX_PROMPT_SOURCE_CHARS
  )) {
    throw new AudioExperimentResponseError();
  }

  for (const source of sourceTexts) {
    if (
      containsSourceWindow(outputText, source) ||
      containsSourceWindow(normalizeWhitespace(outputText), normalizeWhitespace(source))
    ) {
      throw new AudioExperimentResponseError("Audio experiment response was rejected.");
    }
  }
}

export function parseAudioExperimentResponse(
  value: unknown,
  options: ParseAudioExperimentResponseOptions = {},
): AudioExperimentResponse {
  try {
    assertAggregateShape(value, 0);
    assertExactKeys(value, [
      "schema_version",
      "mode",
      "input_basis",
      "temporal_observations",
      "immediate_response",
      "interpretation",
      "uncertainties",
      "crystallized_record",
      "synthesis",
    ]);
    const record = value as Record<string, unknown>;
    if (record.schema_version !== AUDIO_EXPERIMENT_RESPONSE_VERSION) fail();
    if (record.mode !== "direct_encounter" && record.mode !== "synthesis") fail();
    if (options.expectedMode !== undefined && record.mode !== options.expectedMode) fail();

    const temporalObservations = parseTemporalObservations(
      record.temporal_observations,
      record.mode,
    );
    const interpretation = parseInterpretation(record.interpretation);
    const uncertainties = parseUncertainties(record.uncertainties);
    const crystallizedRecord = parseCrystallizedRecord(record.crystallized_record);

    const parsed: AudioExperimentResponse = record.mode === "direct_encounter"
      ? parseDirect(record, temporalObservations, interpretation, uncertainties, crystallizedRecord)
      : parseSynthesis(record, temporalObservations, interpretation, uncertainties, crystallizedRecord);

    const serialized = JSON.stringify(parsed);
    if (Buffer.byteLength(serialized, "utf8") > MAX_AUDIO_EXPERIMENT_RESPONSE_BYTES) fail();
    return Object.freeze(parsed);
  } catch (error: unknown) {
    if (error instanceof AudioExperimentResponseError) throw error;
    throw new AudioExperimentResponseError();
  }
}

export function parseAudioExperimentResponseText(
  text: string,
  options: ParseAudioExperimentResponseOptions = {},
): AudioExperimentResponse {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > MAX_AUDIO_EXPERIMENT_RESPONSE_BYTES
  ) {
    throw new AudioExperimentResponseError();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AudioExperimentResponseError();
  }
  return parseAudioExperimentResponse(value, options);
}

export function parseDirectAudioExperimentResponse(value: unknown): AudioExperimentDirectResponse {
  return parseAudioExperimentResponse(value, {
    expectedMode: "direct_encounter",
  }) as AudioExperimentDirectResponse;
}

export function parseDirectAudioExperimentResponseText(text: string): AudioExperimentDirectResponse {
  return parseAudioExperimentResponseText(text, {
    expectedMode: "direct_encounter",
  }) as AudioExperimentDirectResponse;
}

export function parseSynthesisAudioExperimentResponse(value: unknown): AudioExperimentSynthesisResponse {
  return parseAudioExperimentResponse(value, {
    expectedMode: "synthesis",
  }) as AudioExperimentSynthesisResponse;
}

export function parseSynthesisAudioExperimentResponseText(text: string): AudioExperimentSynthesisResponse {
  return parseAudioExperimentResponseText(text, {
    expectedMode: "synthesis",
  }) as AudioExperimentSynthesisResponse;
}

function parseDirect(
  record: Record<string, unknown>,
  temporalObservations: readonly AudioExperimentTemporalObservation[],
  interpretation: AudioExperimentInterpretation,
  uncertainties: readonly AudioExperimentUncertainty[],
  crystallizedRecord: AudioExperimentCrystallizedRecord,
): AudioExperimentDirectResponse {
  if (record.input_basis !== "direct_audio" || record.synthesis !== null) fail();
  const immediateResponse = parseImmediateResponse(record.immediate_response);
  return {
    schema_version: AUDIO_EXPERIMENT_RESPONSE_VERSION,
    mode: "direct_encounter",
    input_basis: "direct_audio",
    temporal_observations: temporalObservations,
    immediate_response: immediateResponse,
    interpretation,
    uncertainties,
    crystallized_record: crystallizedRecord,
    synthesis: null,
  };
}

function parseSynthesis(
  record: Record<string, unknown>,
  temporalObservations: readonly AudioExperimentTemporalObservation[],
  interpretation: AudioExperimentInterpretation,
  uncertainties: readonly AudioExperimentUncertainty[],
  crystallizedRecord: AudioExperimentCrystallizedRecord,
): AudioExperimentSynthesisResponse {
  if (record.input_basis !== "artifacts_only" || record.immediate_response !== null) fail();
  const synthesis = parseSynthesisObject(record.synthesis);
  return {
    schema_version: AUDIO_EXPERIMENT_RESPONSE_VERSION,
    mode: "synthesis",
    input_basis: "artifacts_only",
    temporal_observations: temporalObservations,
    immediate_response: null,
    interpretation,
    uncertainties,
    crystallized_record: crystallizedRecord,
    synthesis,
  };
}

function parseTemporalObservations(
  value: unknown,
  mode: AudioExperimentResponseMode,
): readonly AudioExperimentTemporalObservation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) fail();
  return Object.freeze(value.map((entry) => {
    assertExactKeys(entry, ["phase", "observation", "evidence", "source_basis", "confidence"]);
    const item = entry as Record<string, unknown>;
    if (!isTemporalSourceBasis(item.source_basis) || !isConfidence(item.confidence)) fail();
    if (mode === "direct_encounter" && item.source_basis !== "direct_audio") fail();
    if (mode === "synthesis" && item.source_basis === "direct_audio") fail();
    return Object.freeze({
      phase: boundedString(item.phase, 1, 120),
      observation: boundedString(item.observation, 1, 1_200),
      evidence: boundedString(item.evidence, 1, 1_200),
      source_basis: item.source_basis,
      confidence: item.confidence,
    });
  }));
}

function parseImmediateResponse(value: unknown): AudioExperimentImmediateResponse {
  assertExactKeys(value, ["opening", "developments", "residue"]);
  return Object.freeze({
    opening: boundedString(value.opening, 1, 1_200),
    developments: boundedString(value.developments, 1, 1_800),
    residue: boundedString(value.residue, 1, 1_200),
  });
}

function parseInterpretation(value: unknown): AudioExperimentInterpretation {
  assertExactKeys(value, ["primary", "alternatives"]);
  return Object.freeze({
    primary: boundedString(value.primary, 1, 2_000),
    alternatives: parseStringArray(value.alternatives, 0, 4, 1, 1_000),
  });
}

function parseUncertainties(value: unknown): readonly AudioExperimentUncertainty[] {
  if (!Array.isArray(value) || value.length > 8) fail();
  return Object.freeze(value.map((entry) => {
    assertExactKeys(entry, ["question", "reason"]);
    return Object.freeze({
      question: boundedString(entry.question, 1, 800),
      reason: boundedString(entry.reason, 1, 1_000),
    });
  }));
}

function parseCrystallizedRecord(value: unknown): AudioExperimentCrystallizedRecord {
  assertExactKeys(value, ["core", "anchors"]);
  return Object.freeze({
    core: boundedString(value.core, 1, 1_600),
    anchors: parseStringArray(value.anchors, 1, 6, 1, 600),
  });
}

function parseSynthesisObject(value: unknown): AudioExperimentSynthesis {
  assertExactKeys(value, [
    "agreements",
    "disagreements",
    "dsp_correspondences",
    "added_value",
    "limits",
  ]);
  if (!Array.isArray(value.disagreements) || value.disagreements.length > 10) fail();
  const disagreements = Object.freeze(value.disagreements.map((entry) => {
    assertExactKeys(entry, ["topic", "candidate_positions", "resolution"]);
    return Object.freeze({
      topic: boundedString(entry.topic, 1, 600),
      candidate_positions: boundedString(entry.candidate_positions, 1, 1_400),
      resolution: boundedString(entry.resolution, 1, 1_000),
    });
  }));
  return Object.freeze({
    agreements: parseStringArray(value.agreements, 0, 10, 1, 1_000),
    disagreements,
    dsp_correspondences: parseStringArray(value.dsp_correspondences, 0, 10, 1, 1_200),
    added_value: boundedString(value.added_value, 1, 1_600),
    limits: boundedString(value.limits, 1, 1_600),
  });
}

function parseStringArray(
  value: unknown,
  minItems: number,
  maxItems: number,
  minChars: number,
  maxChars: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) fail();
  return Object.freeze(value.map((entry) => boundedString(entry, minChars, maxChars)));
}

function boundedString(value: unknown, minChars: number, maxChars: number): string {
  if (typeof value !== "string") fail();
  const characterCount = Array.from(value).length;
  if (characterCount < minChars || characterCount > maxChars
    || hasUnsafeText(value) || containsLongBase64LikeRun(value)) fail();
  return value;
}

function isTemporalSourceBasis(value: unknown): value is AudioExperimentTemporalSourceBasis {
  return value === "direct_audio" || value === "candidate_report" || value === "dsp"
    || value === "cross_artifact";
}

function isConfidence(value: unknown): value is AudioExperimentConfidence {
  return value === "low" || value === "medium" || value === "high";
}

function assertExactKeys(value: unknown, expected: readonly string[]): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) fail();
  const keys = exactEnumerableKeys(value);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) fail();
}

function exactEnumerableKeys(value: Record<string, unknown>): string[] {
  const keys = Reflect.ownKeys(value);
  const result: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) fail();
    result.push(key);
  }
  return result;
}

function assertAggregateShape(value: unknown, depth: number): void {
  if (depth > MAX_AUDIO_EXPERIMENT_RESPONSE_DEPTH) fail();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) fail();
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_AUDIO_EXPERIMENT_RESPONSE_STRING_CHARS || hasUnsafeText(value)
      || containsLongBase64LikeRun(value)) fail();
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_AUDIO_EXPERIMENT_RESPONSE_ARRAY_ITEMS) fail();
    for (const entry of value) assertAggregateShape(entry, depth + 1);
    return;
  }
  if (!isPlainRecord(value)) fail();
  const keys = exactEnumerableKeys(value);
  if (keys.length > MAX_AUDIO_EXPERIMENT_RESPONSE_OBJECT_PROPERTIES) fail();
  for (const key of keys) {
    if (key.length < 1 || key.length > 64 || hasUnsafeText(key) || key === "__proto__") fail();
    assertAggregateShape(value[key], depth + 1);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasUnsafeText(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function containsLongBase64LikeRun(value: string): boolean {
  const runs = value.match(/[A-Za-z0-9+/_-]{256,}={0,2}/gu);
  if (runs?.some((run) => run.length >= LONG_BASE64_LIKE_CHARS)) return true;
  if (!/[\r\n\t]/u.test(value) || !/^[A-Za-z0-9+/_=\r\n\t]+$/u.test(value)) return false;
  const compact = value.replace(/[\r\n\t]/gu, "");
  return compact.length >= LONG_BASE64_LIKE_CHARS
    && /^(?:[A-Za-z0-9+/_-]+={0,2})$/u.test(compact);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function containsSourceWindow(output: string, source: string): boolean {
  if (output.length < AUDIO_EXPERIMENT_PROMPT_ECHO_MIN_CHARS
    || source.length < AUDIO_EXPERIMENT_PROMPT_ECHO_MIN_CHARS) return false;
  const windows = new Set<string>();
  for (let index = 0; index <= source.length - AUDIO_EXPERIMENT_PROMPT_ECHO_MIN_CHARS; index += 1) {
    windows.add(source.slice(index, index + AUDIO_EXPERIMENT_PROMPT_ECHO_MIN_CHARS));
  }
  for (let index = 0; index <= output.length - AUDIO_EXPERIMENT_PROMPT_ECHO_MIN_CHARS; index += 1) {
    if (windows.has(output.slice(index, index + AUDIO_EXPERIMENT_PROMPT_ECHO_MIN_CHARS))) return true;
  }
  return false;
}

function fail(): never {
  throw new AudioExperimentResponseError();
}
