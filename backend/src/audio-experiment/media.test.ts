import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import {
  LOCAL_MEDIA_PROCESS_LIMITS,
  MAX_AUDIO_DURATION_SECONDS,
  localProcessExecutor,
  probeAudio,
  sanitizeAudio,
  validateAudioBytes,
  type ProcessExecutor,
  type ProcessResult,
  type ProcessRunOptions,
} from "./media.js";

function riffChunk(id: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, 4, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, ...(data.length & 1 ? [Buffer.alloc(1)] : [])]);
}

function syntheticWav(options: { sampleRate?: number; samples?: number; metadata?: boolean } = {}): Buffer {
  const sampleRate = options.sampleRate ?? 8_000;
  const samples = options.samples ?? 80;
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate, 8);
  fmt.writeUInt16LE(1, 12);
  fmt.writeUInt16LE(8, 14);
  const chunks = [riffChunk("fmt ", fmt)];
  if (options.metadata) chunks.push(riffChunk("LIST", Buffer.from("INFOINAMSYNTHETIC_ARTIST", "ascii")));
  chunks.push(riffChunk("data", Buffer.alloc(samples, 0x80)));
  const payload = Buffer.concat([Buffer.from("WAVE", "ascii"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function syntheticBareMp3(): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]); // MPEG-1 Layer III, 128 kb/s, 44.1 kHz.
  return frame;
}

function syntheticMp3(): Buffer {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x54, 0x45, 0x53, 0x54]);
  return Buffer.concat([id3, syntheticBareMp3()]);
}

function success(stdout: Buffer | string = Buffer.alloc(0), stderr: Buffer | string = Buffer.alloc(0)): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr),
  };
}

class SyntheticMediaExecutor implements ProcessExecutor {
  readonly calls: Array<{ executable: string; args: readonly string[]; options: ProcessRunOptions }> = [];
  readonly privateModes: number[] = [];

  constructor(private readonly sanitized: Buffer) {}

  async run(executable: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ executable, args: [...args], options });
    assert.equal(options.timeoutMs, 1_234);
    assert.ok(options.maxStdoutBytes > 0);
    assert.ok(options.maxStderrBytes > 0);
    if (executable === "/synthetic/ffmpeg") {
      const input = args[args.indexOf("-i") + 1]!;
      const output = args.at(-1)!;
      this.privateModes.push(fs.statSync(input).mode & 0o777, fs.statSync(output).mode & 0o777);
      fs.writeFileSync(output, this.sanitized);
      return success();
    }
    assert.equal(executable, "/synthetic/ffprobe");
    const input = args.at(-1)!;
    this.privateModes.push(fs.statSync(input).mode & 0o777);
    const stat = fs.statSync(input);
    const baseName = path.basename(input);
    const isSource = baseName.startsWith("source.");
    const isMp3 = baseName.endsWith(".mp3");
    const duration = isMp3 ? String(1152 / 44_100) : "0.010000";
    return success(JSON.stringify({
      streams: [{
        codec_type: "audio",
        codec_name: isMp3 ? "mp3" : "pcm_u8",
        codec_long_name: isMp3 ? "MP3" : "PCM unsigned 8-bit",
        sample_rate: isMp3 ? "44100" : "8000",
        channels: isMp3 ? 2 : 1,
        channel_layout: isMp3 ? "stereo" : "mono",
        sample_fmt: isMp3 ? "fltp" : "u8",
        bits_per_sample: isMp3 ? 0 : 8,
        duration,
        tags: isSource ? { artist: "synthetic" } : {},
      }],
      format: {
        format_name: isMp3 ? "mp3" : "wav",
        format_long_name: isMp3 ? "MP2/3" : "WAV / WAVE",
        duration,
        size: String(stat.size),
        bit_rate: isMp3 ? "128000" : "64000",
        tags: isSource ? { title: "synthetic title" } : {},
      },
    }));
  }
}

test("structurally validates bounded RIFF/WAVE and MP3 without an external process", () => {
  const wav = syntheticWav({ metadata: true });
  const wavValidation = validateAudioBytes(wav, wav.length);
  assert.deepEqual(
    { format: wavValidation.format, duration: wavValidation.durationSeconds, rate: wavValidation.sampleRateHz, channels: wavValidation.channels },
    { format: "wav", duration: 0.01, rate: 8_000, channels: 1 },
  );

  const mp3 = syntheticMp3();
  const mp3Validation = validateAudioBytes(mp3, mp3.length);
  assert.equal(mp3Validation.format, "mp3");
  assert.equal(mp3Validation.sampleRateHz, 44_100);
  assert.equal(mp3Validation.channels, 2);
  assert.ok(Math.abs(mp3Validation.durationSeconds - 1152 / 44_100) < 1e-12);
  assert.equal(mp3Validation.audioDataBytes, 417);
});

test("enforces the caller byte cap and the explicit ten-minute duration cap", () => {
  const wav = syntheticWav();
  assert.throws(() => validateAudioBytes(wav, wav.length - 1), /caller-supplied byte limit/);
  const tooLong = syntheticWav({ sampleRate: 1, samples: MAX_AUDIO_DURATION_SECONDS + 1 });
  assert.throws(() => validateAudioBytes(tooLong, tooLong.length), /600-second limit/);
  assert.throws(() => validateAudioBytes(Buffer.from("ID3not-a-real-mp3"), 1024), /MP3/);
});

test("ffprobe independently enforces the ten-minute cap before ffmpeg work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-probe-duration-test-"));
  try {
    const wav = syntheticWav();
    const executor: ProcessExecutor = {
      async run(_executable, args) {
        const input = args.at(-1)!;
        return success(JSON.stringify({
          streams: [{ codec_type: "audio", codec_name: "pcm_u8", sample_rate: "8000", channels: 1, duration: "601" }],
          format: { format_name: "wav", duration: "601", size: String(fs.statSync(input).size) },
        }));
      },
    };
    await assert.rejects(probeAudio(wav, {
      maxBytes: wav.length,
      tempRoot: root,
      executor,
      ffprobePath: "/synthetic/ffprobe",
      timeoutMs: 1_234,
    }), /600-second limit/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sanitizes by deterministic stream copy, hashes exact output, probes both sides, and cleans private temporaries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-media-test-"));
  const sentinel = path.join(root, "caller-source-sentinel");
  fs.writeFileSync(sentinel, "must remain", { mode: 0o600 });
  try {
    const source = syntheticWav({ metadata: true });
    const sanitized = syntheticWav();
    const executor = new SyntheticMediaExecutor(sanitized);
    const result = await sanitizeAudio(source, {
      maxBytes: 1024 * 1024,
      tempRoot: root,
      executor,
      ffmpegPath: "/synthetic/ffmpeg",
      ffprobePath: "/synthetic/ffprobe",
      timeoutMs: 1_234,
    });

    assert.deepEqual(result.bytes, sanitized);
    assert.equal(result.sha256, createHash("sha256").update(sanitized).digest("hex"));
    assert.equal(result.sourceSha256, createHash("sha256").update(source).digest("hex"));
    assert.equal(result.method, "ffmpeg-stream-copy");
    assert.deepEqual(result.sourceProbe.tags, { title: "synthetic title", artist: "synthetic" });
    assert.deepEqual(result.probe.tags, {});
    assert.deepEqual(result.cleanup, { temporaryDirectoryRemoved: true, temporaryFileCount: 2, sourceDeleted: false });
    assert.ok(executor.privateModes.every((mode) => mode === 0o600));
    const ffmpegCall = executor.calls.find((call) => call.executable === "/synthetic/ffmpeg");
    assert.ok(ffmpegCall);
    assert.deepEqual(ffmpegCall.args.slice(ffmpegCall.args.indexOf("-map_metadata"), ffmpegCall.args.indexOf("-map_metadata") + 2), ["-map_metadata", "-1"]);
    assert.ok(ffmpegCall.args.includes("copy"));
    assert.ok(ffmpegCall.args.includes("-vn"));
    assert.equal(fs.readFileSync(sentinel, "utf8"), "must remain");
    assert.deepEqual(fs.readdirSync(root), ["caller-source-sentinel"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MP3 sanitation disables ID3v1 and ID3v2 while preserving audio frames", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-mp3-sanitize-test-"));
  try {
    const source = syntheticMp3();
    const sanitized = syntheticBareMp3();
    const executor = new SyntheticMediaExecutor(sanitized);
    const result = await sanitizeAudio(source, {
      maxBytes: 1024,
      tempRoot: root,
      executor,
      ffmpegPath: "/synthetic/ffmpeg",
      ffprobePath: "/synthetic/ffprobe",
      timeoutMs: 1_234,
    });
    assert.equal(result.format, "mp3");
    assert.deepEqual(result.bytes, sanitized);
    const ffmpegArgs = executor.calls.find((call) => call.executable === "/synthetic/ffmpeg")!.args;
    assert.deepEqual(ffmpegArgs.slice(ffmpegArgs.indexOf("-id3v2_version"), ffmpegArgs.indexOf("-id3v2_version") + 2), ["-id3v2_version", "0"]);
    assert.deepEqual(ffmpegArgs.slice(ffmpegArgs.indexOf("-write_id3v1"), ffmpegArgs.indexOf("-write_id3v1") + 2), ["-write_id3v1", "0"]);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("probe uses injected ffprobe and aborts before dispatch when already signaled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-probe-test-"));
  try {
    const wav = syntheticWav();
    const executor = new SyntheticMediaExecutor(wav);
    const probed = await probeAudio(wav, {
      maxBytes: wav.length,
      tempRoot: root,
      executor,
      ffprobePath: "/synthetic/ffprobe",
      timeoutMs: 1_234,
    });
    assert.equal(probed.ffprobe.durationSeconds, 0.01);
    assert.equal(probed.cleanup.temporaryDirectoryRemoved, true);

    const controller = new AbortController();
    controller.abort();
    const callsBeforeAbort = executor.calls.length;
    await assert.rejects(probeAudio(wav, {
      maxBytes: wav.length,
      tempRoot: root,
      executor,
      ffprobePath: "/synthetic/ffprobe",
      timeoutMs: 1_234,
      signal: controller.signal,
    }), /aborted/);
    assert.equal(executor.calls.length, callsBeforeAbort);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the built-in executor rejects relative or symlinked media executables and non-private workspaces", async (t) => {
  if (process.platform !== "linux") {
    t.skip("Linux-only media executor validation");
    return;
  }
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-media-executor-validation-"));
  fs.chmodSync(privateRoot, 0o700);
  const options = realProcessOptions(privateRoot);
  try {
    await assert.rejects(localProcessExecutor.run("ffprobe", [], options), /absolute path/);
    await assert.rejects(localProcessExecutor.run("/usr/bin/node", [], options), /ffmpeg or ffprobe/);
    const systemFfprobe = "/usr/bin/ffprobe";
    if (fs.existsSync(systemFfprobe) && fs.realpathSync(systemFfprobe) === systemFfprobe) {
      const linkedFfprobe = path.join(privateRoot, "ffprobe");
      fs.symlinkSync(systemFfprobe, linkedFfprobe);
      await assert.rejects(localProcessExecutor.run(linkedFfprobe, [], options), /canonical/);
      fs.unlinkSync(linkedFfprobe);
      fs.chmodSync(privateRoot, 0o755);
      await assert.rejects(localProcessExecutor.run(systemFfprobe, [], options), /owner-private/);
    }
  } finally {
    fs.chmodSync(privateRoot, 0o700);
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("the built-in executor has deterministic conservative native-process limits", () => {
  assert.ok(Object.isFrozen(LOCAL_MEDIA_PROCESS_LIMITS));
  assert.deepEqual(LOCAL_MEDIA_PROCESS_LIMITS, {
    addressSpaceBytes: 2 * 1024 * 1024 * 1024,
    fileSizeBytes: 32 * 1024 * 1024,
    cpuSeconds: 60,
    openFiles: 64,
    coreBytes: 0,
    processes: 1024,
  });
});

function realSandboxPrerequisite(): string | undefined {
  if (process.platform !== "linux") return "requires Linux";
  for (const executable of ["/usr/bin/prlimit", "/usr/bin/bwrap", "/usr/bin/ffmpeg", "/usr/bin/ffprobe"]) {
    try {
      const stat = fs.lstatSync(executable);
      if (fs.realpathSync(executable) !== executable || !stat.isFile()) return `${executable} is not canonical`;
      const effectiveUid = process.geteuid?.();
      if (stat.uid !== 0 && (effectiveUid === undefined || stat.uid === effectiveUid)) {
        return `${executable} is not system-owned`;
      }
      fs.accessSync(executable, fs.constants.X_OK);
    } catch {
      return `${executable} is unavailable`;
    }
  }
  return undefined;
}

function realProcessOptions(cwd: string, signal?: AbortSignal): ProcessRunOptions {
  return {
    cwd,
    timeoutMs: 5_000,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 128 * 1024,
    ...(signal ? { signal } : {}),
  };
}

test("real ffmpeg and ffprobe stay inside the no-network resource-limited private-workspace sandbox", async (t) => {
  const prerequisite = realSandboxPrerequisite();
  if (prerequisite) {
    t.skip(`Linux real-process sandbox test skipped: ${prerequisite}`);
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-real-media-sandbox-test-"));
  fs.chmodSync(root, 0o700);
  const markerPath = path.join(os.tmpdir(), `wayang-media-host-marker-${process.pid}-${Date.now()}.wav`);
  const markerBytes = syntheticWav({ samples: 40 });
  fs.writeFileSync(markerPath, markerBytes, { flag: "wx", mode: 0o600 });
  let server: net.Server | undefined;
  try {
    const preflight = await localProcessExecutor.run("/usr/bin/ffprobe", ["-version"], realProcessOptions(root));
    if (preflight.exitCode !== 0 && /(?:namespace|operation not permitted|permission denied)/i.test(preflight.stderr.toString("utf8"))) {
      t.skip("Linux real-process sandbox test skipped: bubblewrap namespaces are unavailable to this user");
      return;
    }
    assert.equal(preflight.exitCode, 0, "bubblewrap preflight failed unexpectedly");

    const wav = syntheticWav();
    const probed = await probeAudio(wav, {
      maxBytes: wav.length,
      tempRoot: root,
      ffprobePath: "/usr/bin/ffprobe",
      timeoutMs: 5_000,
    });
    assert.equal(probed.ffprobe.formatName, "wav");
    assert.equal(probed.ffprobe.sampleRateHz, 8_000);
    assert.equal(probed.cleanup.temporaryDirectoryRemoved, true);
    const sanitized = await sanitizeAudio(wav, {
      maxBytes: 1024 * 1024,
      tempRoot: root,
      ffmpegPath: "/usr/bin/ffmpeg",
      ffprobePath: "/usr/bin/ffprobe",
      timeoutMs: 5_000,
    });
    assert.equal(sanitized.format, "wav");
    assert.deepEqual(sanitized.probe.tags, {});
    assert.equal(sanitized.cleanup.temporaryDirectoryRemoved, true);

    const passwdProbe = await localProcessExecutor.run("/usr/bin/ffprobe", [
      "-v", "error", "-show_format", "/etc/passwd",
    ], realProcessOptions(root));
    assert.notEqual(passwdProbe.exitCode, 0, "the sandbox unexpectedly exposed the /etc/passwd denial target");

    const markerProbe = await localProcessExecutor.run("/usr/bin/ffprobe", [
      "-v", "error", "-show_format", markerPath,
    ], realProcessOptions(root));
    assert.notEqual(markerProbe.exitCode, 0, "the sandbox unexpectedly exposed a host /tmp marker");

    const inputPath = path.join(root, "input.wav");
    fs.writeFileSync(inputPath, syntheticWav({ samples: 160 }), { flag: "wx", mode: 0o600 });
    const tmpWrite = await localProcessExecutor.run("/usr/bin/ffmpeg", [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-i", inputPath,
      "-map", "0:a:0", "-c:a", "copy", "-f", "wav", markerPath,
    ], realProcessOptions(root));
    assert.equal(tmpWrite.exitCode, 0, "ffmpeg could not use its isolated ephemeral /tmp");
    assert.deepEqual(fs.readFileSync(markerPath), markerBytes, "sandboxed ffmpeg changed the host /tmp marker");

    const oversizedPath = path.join(root, "oversized.raw");
    const oversizedStartedAt = Date.now();
    const oversizedWrite = await localProcessExecutor.run("/usr/bin/ffmpeg", [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-t", "400", "-c:a", "pcm_s16le", "-f", "s16le", oversizedPath,
    ], realProcessOptions(root));
    assert.ok(oversizedWrite.exitCode !== 0 || oversizedWrite.signal !== null, "ffmpeg unexpectedly exceeded RLIMIT_FSIZE successfully");
    assert.ok(Date.now() - oversizedStartedAt < 6_500, "RLIMIT_FSIZE failure exceeded the wall-time cleanup bound");
    const oversizedStat = fs.lstatSync(oversizedPath);
    assert.ok(oversizedStat.isFile() && !oversizedStat.isSymbolicLink());
    assert.ok(oversizedStat.size > 0, "ffmpeg did not begin the oversized derivative write");
    assert.ok(oversizedStat.size <= LOCAL_MEDIA_PROCESS_LIMITS.fileSizeBytes, "RLIMIT_FSIZE allowed an oversized derivative");
    fs.rmSync(oversizedPath);
    assert.equal(fs.existsSync(oversizedPath), false, "bounded oversized derivative cleanup failed");

    const protocols = await localProcessExecutor.run("/usr/bin/ffprobe", ["-v", "error", "-protocols"], realProcessOptions(root));
    assert.equal(protocols.exitCode, 0);
    if (!/^  tcp$/m.test(protocols.stdout.toString("utf8"))) {
      t.skip("Linux real-process sandbox test skipped: ffprobe TCP protocol is unavailable for the loopback probe");
      return;
    }
    let acceptedConnections = 0;
    server = net.createServer((socket) => {
      acceptedConnections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const networkProbe = await localProcessExecutor.run("/usr/bin/ffprobe", [
      "-v", "error", "-rw_timeout", "500000", "-show_format", `tcp://127.0.0.1:${address.port}`,
    ], realProcessOptions(root));
    assert.notEqual(networkProbe.exitCode, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(acceptedConnections, 0, "sandboxed ffprobe reached a host-loopback listener");
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  } finally {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    fs.rmSync(markerPath, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the built-in executor rejects concurrency and releases its slot after abort", async (t) => {
  const prerequisite = realSandboxPrerequisite();
  if (prerequisite) {
    t.skip(`Linux real-process concurrency test skipped: ${prerequisite}`);
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-real-media-concurrency-test-"));
  fs.chmodSync(root, 0o700);
  try {
    const preflight = await localProcessExecutor.run("/usr/bin/ffprobe", ["-version"], realProcessOptions(root));
    if (preflight.exitCode !== 0 && /(?:namespace|operation not permitted|permission denied)/i.test(preflight.stderr.toString("utf8"))) {
      t.skip("Linux real-process concurrency test skipped: bubblewrap namespaces are unavailable to this user");
      return;
    }
    assert.equal(preflight.exitCode, 0, "resource-limited bubblewrap preflight failed unexpectedly");

    const controller = new AbortController();
    const startedAt = Date.now();
    const activeRun = localProcessExecutor.run("/usr/bin/ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-f", "null", "-",
    ], { ...realProcessOptions(root, controller.signal), timeoutMs: 10_000 });
    await assert.rejects(localProcessExecutor.run(
      "/usr/bin/ffprobe",
      ["-version"],
      realProcessOptions(root),
    ), /already active/);
    controller.abort();
    await assert.rejects(activeRun, /aborted/);
    assert.ok(Date.now() - startedAt < 2_500, "abort and process-group cleanup exceeded its bound");

    const afterAbort = await localProcessExecutor.run("/usr/bin/ffprobe", ["-version"], realProcessOptions(root));
    assert.equal(afterAbort.exitCode, 0, "native media concurrency slot was not released after abort cleanup");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
