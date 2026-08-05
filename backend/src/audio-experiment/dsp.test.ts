import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateArmCRepresentations,
  MAX_ARM_C_NUMERIC_TEXT_BYTES,
} from "./dsp.js";
import type { ProcessExecutor, ProcessResult, ProcessRunOptions } from "./media.js";

function riffChunk(id: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, 4, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, ...(data.length & 1 ? [Buffer.alloc(1)] : [])]);
}

function syntheticWav(): Buffer {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(8_000, 4);
  fmt.writeUInt32LE(8_000, 8);
  fmt.writeUInt16LE(1, 12);
  fmt.writeUInt16LE(8, 14);
  const payload = Buffer.concat([
    Buffer.from("WAVE", "ascii"),
    riffChunk("fmt ", fmt),
    riffChunk("data", Buffer.alloc(80, 0x80)),
  ]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x53, 0x59, 0x4e, 0x54, 0x48, 0x45, 0x54, 0x49, 0x43]);

function processResult(exitCode: number, stdout = "", stderr = ""): ProcessResult {
  return { exitCode, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

class SyntheticDspExecutor implements ProcessExecutor {
  readonly calls: Array<{ executable: string; args: readonly string[]; options: ProcessRunOptions }> = [];
  readonly modes: number[] = [];

  constructor(private readonly failCqt = true) {}

  async run(executable: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ executable, args: [...args], options });
    assert.equal(options.timeoutMs, 2_345);
    assert.ok(options.maxStdoutBytes <= 256 * 1024);
    assert.ok(options.maxStderrBytes <= 192 * 1024);
    if (executable === "/synthetic/ffprobe") {
      const input = args.at(-1)!;
      this.modes.push(fs.statSync(input).mode & 0o777);
      return processResult(0, JSON.stringify({
        streams: [{
          codec_type: "audio",
          codec_name: "pcm_u8",
          sample_rate: "8000",
          channels: 1,
          channel_layout: "mono",
          sample_fmt: "u8",
          bits_per_sample: 8,
          duration: "0.010000",
        }],
        format: {
          format_name: "wav",
          duration: "0.010000",
          size: String(fs.statSync(input).size),
          bit_rate: "64000",
        },
      }));
    }
    assert.equal(executable, "/synthetic/ffmpeg");
    const joined = args.join(" ");
    if (joined.includes("showcqt=") && this.failCqt) return processResult(1, "", "No such filter: showcqt");
    if (joined.includes("astats=")) {
      return processResult(0, "", [
        "[Parsed_astats_0 @ synthetic] Peak level dB: -1.250000",
        "[Parsed_astats_0 @ synthetic] RMS level dB: -18.500000",
        "[Parsed_astats_0 @ synthetic] Dynamic range: 42.000000",
        "[Parsed_astats_0 @ synthetic] Number of samples: 80",
      ].join("\n"));
    }
    if (joined.includes("ebur128=")) {
      return processResult(0, "", [
        "[Parsed_ebur128_0 @ synthetic] Summary:",
        "Integrated loudness:",
        "I: -19.2 LUFS",
        "Threshold: -29.2 LUFS",
        "Loudness range:",
        "LRA: 3.4 LU",
        "True peak:",
        "Peak: -1.2 dBFS",
      ].join("\n"));
    }
    const output = args.at(-1)!;
    this.modes.push(fs.statSync(output).mode & 0o777);
    fs.writeFileSync(output, PNG);
    return processResult(0);
  }
}

test("generates private bounded waveform, spectrogram, supported frequency visual, and numeric loudness text", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-dsp-test-"));
  try {
    const wav = syntheticWav();
    const executor = new SyntheticDspExecutor(true);
    const result = await generateArmCRepresentations(wav, {
      maxBytes: wav.length,
      maxDerivativeBytes: 1024,
      tempRoot: root,
      executor,
      ffmpegPath: "/synthetic/ffmpeg",
      ffprobePath: "/synthetic/ffprobe",
      timeoutMs: 2_345,
    });

    assert.equal(result.sourceFormat, "wav");
    assert.equal(result.sanitizedSha256, createHash("sha256").update(wav).digest("hex"));
    assert.equal(result.waveform.width, 1200);
    assert.equal(result.waveform.height, 240);
    assert.deepEqual(result.waveform.bytes, PNG);
    assert.equal(result.spectrogram.height, 600);
    assert.equal(result.frequencyVisual.kind, "showfreqs");
    assert.deepEqual(result.frequencyVisual.bytes, PNG);
    assert.match(result.numericText, /duration_seconds=0\.010000/);
    assert.match(result.numericText, /Peak level dB: -1\.250000/);
    assert.match(result.numericText, /I: -19\.2 LUFS/);
    assert.match(result.numericText, /Peak: -1\.2 dBFS/);
    assert.ok(Buffer.byteLength(result.numericText) <= MAX_ARM_C_NUMERIC_TEXT_BYTES);
    assert.deepEqual(result.cleanup, { temporaryDirectoryRemoved: true, temporaryFileCount: 4, sourceDeleted: false });
    assert.ok(executor.modes.every((mode) => mode === 0o600));
    assert.equal(executor.calls.filter((call) => call.executable === "/synthetic/ffprobe").length, 1);
    assert.equal(executor.calls.filter((call) => call.args.join(" ").includes("showcqt=")).length, 1);
    assert.equal(executor.calls.filter((call) => call.args.join(" ").includes("showfreqs=")).length, 1);
    const visualCalls = executor.calls.filter((call) => call.args.includes("-filter_complex"));
    assert.ok(visualCalls.length >= 3);
    assert.ok(visualCalls.every((call) => {
      const mapIndex = call.args.indexOf("-map");
      return mapIndex >= 0 && call.args[mapIndex + 1] === "[v]";
    }));
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an oversized derivative and still removes the disposable workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-dsp-bound-test-"));
  try {
    const wav = syntheticWav();
    const executor = new SyntheticDspExecutor(false);
    await assert.rejects(generateArmCRepresentations(wav, {
      maxBytes: wav.length,
      maxDerivativeBytes: 8,
      tempRoot: root,
      executor,
      ffmpegPath: "/synthetic/ffmpeg",
      ffprobePath: "/synthetic/ffprobe",
      timeoutMs: 2_345,
    }), /derivative.*byte limit/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
