import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export const MAX_AUDIO_DURATION_SECONDS = 10 * 60;
export const DEFAULT_MEDIA_PROCESS_TIMEOUT_MS = 20_000;
export const DEFAULT_PROCESS_STDOUT_BYTES = 256 * 1024;
export const DEFAULT_PROCESS_STDERR_BYTES = 128 * 1024;

export type SupportedAudioFormat = "mp3" | "wav";

export interface AudioValidation {
  format: SupportedAudioFormat;
  byteLength: number;
  durationSeconds: number;
  sampleRateHz: number;
  channels: number;
  codec: string;
  audioDataBytes: number;
}

export interface ProcessRunOptions {
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface ProcessExecutor {
  run(executable: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult>;
}

export interface FfprobeAudioMetadata {
  formatName: string;
  formatLongName?: string;
  durationSeconds: number;
  sizeBytes: number;
  bitRate?: number;
  codecName: string;
  codecLongName?: string;
  sampleRateHz: number;
  channels: number;
  channelLayout?: string;
  sampleFormat?: string;
  bitsPerSample?: number;
  tags: Readonly<Record<string, string>>;
}

export interface MediaCleanupMetadata {
  temporaryDirectoryRemoved: boolean;
  temporaryFileCount: number;
  sourceDeleted: false;
}

export interface ProbeAudioOptions {
  maxBytes: number;
  tempRoot?: string;
  ffprobePath?: string;
  executor?: ProcessExecutor;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProbedAudio {
  validation: AudioValidation;
  sha256: string;
  ffprobe: FfprobeAudioMetadata;
  cleanup: MediaCleanupMetadata;
}

export interface SanitizeAudioOptions extends ProbeAudioOptions {
  ffmpegPath?: string;
}

export interface SanitizedAudio {
  format: SupportedAudioFormat;
  bytes: Buffer;
  byteLength: number;
  sha256: string;
  sourceSha256: string;
  sourceValidation: AudioValidation;
  validation: AudioValidation;
  sourceProbe: FfprobeAudioMetadata;
  probe: FfprobeAudioMetadata;
  method: "ffmpeg-stream-copy";
  cleanup: MediaCleanupMetadata;
}

function requirePositiveBound(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
}

function requireDurationWithinCap(durationSeconds: number): void {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) throw new Error("Audio duration is invalid");
  if (durationSeconds > MAX_AUDIO_DURATION_SECONDS + 1e-6) {
    throw new Error(`Audio duration exceeds the ${MAX_AUDIO_DURATION_SECONDS}-second limit`);
  }
}

function validateWav(bytes: Buffer): AudioValidation {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Invalid RIFF/WAVE audio");
  }
  const declaredLength = bytes.readUInt32LE(4) + 8;
  if (declaredLength !== bytes.length) throw new Error("RIFF/WAVE length does not match the supplied bytes");

  let offset = 12;
  let formatCode: number | undefined;
  let channels: number | undefined;
  let sampleRateHz: number | undefined;
  let blockAlign: number | undefined;
  let bitsPerSample: number | undefined;
  let audioDataBytes = 0;
  let sawData = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error("RIFF/WAVE has a truncated chunk header");
    const chunkId = bytes.toString("ascii", offset, offset + 4);
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const paddedEnd = dataEnd + (chunkLength & 1);
    if (dataEnd > bytes.length || paddedEnd > bytes.length) throw new Error("RIFF/WAVE has a truncated chunk");

    if (chunkId === "fmt ") {
      if (formatCode !== undefined) throw new Error("RIFF/WAVE contains multiple format chunks");
      if (chunkLength < 16) throw new Error("RIFF/WAVE format chunk is too short");
      formatCode = bytes.readUInt16LE(dataStart);
      channels = bytes.readUInt16LE(dataStart + 2);
      sampleRateHz = bytes.readUInt32LE(dataStart + 4);
      const byteRate = bytes.readUInt32LE(dataStart + 8);
      blockAlign = bytes.readUInt16LE(dataStart + 12);
      bitsPerSample = bytes.readUInt16LE(dataStart + 14);
      if (channels < 1 || channels > 64 || sampleRateHz < 1 || sampleRateHz > 768_000 || blockAlign < 1 || byteRate < 1) {
        throw new Error("RIFF/WAVE format values are invalid");
      }
    } else if (chunkId === "data") {
      if (sawData) throw new Error("RIFF/WAVE contains multiple data chunks");
      sawData = true;
      audioDataBytes = chunkLength;
    }
    offset = paddedEnd;
  }

  if (offset !== bytes.length || formatCode === undefined || channels === undefined || sampleRateHz === undefined || blockAlign === undefined || !sawData || audioDataBytes === 0) {
    throw new Error("RIFF/WAVE is missing required audio chunks");
  }
  if (audioDataBytes % blockAlign !== 0) throw new Error("RIFF/WAVE audio data is not block-aligned");
  const durationSeconds = audioDataBytes / blockAlign / sampleRateHz;
  requireDurationWithinCap(durationSeconds);
  const codec = formatCode === 1
    ? `pcm_s${bitsPerSample ?? 0}le`
    : formatCode === 3
      ? `pcm_f${bitsPerSample ?? 0}le`
      : formatCode === 0xfffe
        ? "wave_extensible"
        : `wave_format_${formatCode}`;
  return { format: "wav", byteLength: bytes.length, durationSeconds, sampleRateHz, channels, codec, audioDataBytes };
}

const MPEG1_BITRATES: Readonly<Record<number, readonly number[]>> = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};
const MPEG2_BITRATES: Readonly<Record<number, readonly number[]>> = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

function readSynchsafeInteger(bytes: Buffer, offset: number): number {
  let value = 0;
  for (let index = 0; index < 4; index += 1) {
    const octet = bytes[offset + index]!;
    if ((octet & 0x80) !== 0) throw new Error("MP3 ID3 tag has an invalid synchsafe length");
    value = (value << 7) | octet;
  }
  return value;
}

function validateMp3(bytes: Buffer): AudioValidation {
  let offset = 0;
  if (bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "ID3") {
    const major = bytes[3]!;
    if (major < 2 || major > 4) throw new Error("Unsupported MP3 ID3 version");
    const footerBytes = major === 4 && (bytes[5]! & 0x10) !== 0 ? 10 : 0;
    offset = 10 + readSynchsafeInteger(bytes, 6) + footerBytes;
    if (offset > bytes.length) throw new Error("MP3 ID3 tag exceeds the supplied bytes");
  }

  let frameCount = 0;
  let durationSeconds = 0;
  let audioDataBytes = 0;
  let firstSampleRate = 0;
  let firstChannels = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes.length - offset === 128 && bytes.toString("ascii", offset, offset + 3) === "TAG") {
      offset = bytes.length;
      break;
    }
    const header = bytes.readUInt32BE(offset);
    if ((header >>> 21) !== 0x7ff) break;
    const versionBits = (header >>> 19) & 0x3;
    const layerBits = (header >>> 17) & 0x3;
    const bitrateIndex = (header >>> 12) & 0xf;
    const sampleRateIndex = (header >>> 10) & 0x3;
    const padding = (header >>> 9) & 0x1;
    if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
      throw new Error("MP3 contains an unsupported frame header");
    }
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
    const bitrateTable = version === 1 ? MPEG1_BITRATES : MPEG2_BITRATES;
    const bitrateKbps = bitrateTable[layer]![bitrateIndex];
    if (!bitrateKbps) throw new Error("MP3 free-format frames are not supported");
    const baseSampleRate = [44_100, 48_000, 32_000][sampleRateIndex]!;
    const sampleRateHz = version === 1 ? baseSampleRate : version === 2 ? baseSampleRate / 2 : baseSampleRate / 4;
    const bitrate = bitrateKbps * 1000;
    const frameLength = layer === 1
      ? Math.floor((12 * bitrate) / sampleRateHz + padding) * 4
      : layer === 3 && version !== 1
        ? Math.floor((72 * bitrate) / sampleRateHz + padding)
        : Math.floor((144 * bitrate) / sampleRateHz + padding);
    const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;
    if (frameLength < 4 || offset + frameLength > bytes.length) throw new Error("MP3 contains a truncated frame");
    const frameChannels = ((header >>> 6) & 0x3) === 3 ? 1 : 2;
    if (frameCount === 0) {
      firstSampleRate = sampleRateHz;
      firstChannels = frameChannels;
    } else if (sampleRateHz !== firstSampleRate || frameChannels !== firstChannels) {
      throw new Error("MP3 changes audio shape between frames");
    }
    durationSeconds += samplesPerFrame / sampleRateHz;
    requireDurationWithinCap(durationSeconds);
    audioDataBytes += frameLength;
    frameCount += 1;
    offset += frameLength;
  }

  if (frameCount === 0) throw new Error("MP3 contains no complete audio frames");
  const remainder = bytes.subarray(offset);
  if (remainder.length > 4096 || remainder.some((octet) => octet !== 0)) throw new Error("MP3 contains unsupported trailing bytes");
  return {
    format: "mp3",
    byteLength: bytes.length,
    durationSeconds,
    sampleRateHz: firstSampleRate,
    channels: firstChannels,
    codec: "mp3",
    audioDataBytes,
  };
}

/** Validate complete MP3 or RIFF/WAVE bytes before any external process is started. */
export function validateAudioBytes(input: Uint8Array, maxBytes: number): AudioValidation {
  requirePositiveBound(maxBytes, "maxBytes");
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length === 0) throw new Error("Audio input is empty");
  if (bytes.length > maxBytes) throw new Error("Audio input exceeds the caller-supplied byte limit");
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF") return validateWav(bytes);
  return validateMp3(bytes);
}

const BWRAP_PATH = "/usr/bin/bwrap";
const PRLIMIT_PATH = "/usr/bin/prlimit";
const DEFAULT_FFMPEG_PATH = "/usr/bin/ffmpeg";
const DEFAULT_FFPROBE_PATH = "/usr/bin/ffprobe";
const PROCESS_TERMINATION_BOUND_MS = 1_000;
let localMediaProcessActive = false;

// 2 GiB leaves codec/demux headroom over the 20 MiB input ceiling; 32 MiB is four times
// the derivative ceiling. CPU complements the shorter wall timeout, 64 FDs cover the
// fixed runtime closure, and no cores may be written. NPROC is a coarse real-UID ceiling;
// the stricter aggregate guard is the one-active-built-in-executor slot below.
export const LOCAL_MEDIA_PROCESS_LIMITS = Object.freeze({
  addressSpaceBytes: 2 * 1024 * 1024 * 1024,
  fileSizeBytes: 32 * 1024 * 1024,
  cpuSeconds: 60,
  openFiles: 64,
  coreBytes: 0,
  processes: 1024,
});

function hasTrustedSystemOwner(stat: fs.Stats): boolean {
  const effectiveUid = process.geteuid?.();
  return stat.uid === 0 || (effectiveUid !== undefined && stat.uid !== effectiveUid);
}

function requireCanonicalExecutable(executable: string): void {
  if (!path.isAbsolute(executable)) throw new Error("Media executable must be an absolute path");
  const baseName = path.basename(executable);
  if (baseName !== "ffmpeg" && baseName !== "ffprobe") throw new Error("Media executable must be ffmpeg or ffprobe");
  let canonical: string;
  let stat: fs.Stats;
  try {
    canonical = fs.realpathSync(executable);
    stat = fs.lstatSync(executable);
  } catch {
    throw new Error("Media executable is unavailable");
  }
  if (canonical !== executable || !stat.isFile() || stat.isSymbolicLink() || !hasTrustedSystemOwner(stat)
    || (stat.mode & 0o111) === 0 || (stat.mode & 0o6022) !== 0) {
    throw new Error("Media executable must be a canonical, non-writable executable file");
  }
}

function requireCanonicalLauncher(executable: string): void {
  let canonical: string;
  let stat: fs.Stats;
  try {
    canonical = fs.realpathSync(executable);
    stat = fs.lstatSync(executable);
  } catch {
    throw new Error(`Canonical ${executable} is unavailable`);
  }
  if (canonical !== executable || !stat.isFile() || stat.isSymbolicLink() || !hasTrustedSystemOwner(stat)
    || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) {
    throw new Error(`Canonical ${executable} is unavailable`);
  }
}

function requirePrivateCanonicalWorkspace(cwd: string): void {
  if (!path.isAbsolute(cwd)) throw new Error("Media workspace must be absolute");
  let canonical: string;
  let stat: fs.Stats;
  try {
    canonical = fs.realpathSync(cwd);
    stat = fs.lstatSync(cwd);
  } catch {
    throw new Error("Media workspace is unavailable");
  }
  const effectiveUid = process.geteuid?.();
  if (canonical !== cwd || !stat.isDirectory() || stat.isSymbolicLink() || effectiveUid === undefined || stat.uid !== effectiveUid || (stat.mode & 0o077) !== 0) {
    throw new Error("Media workspace must be a canonical owner-private directory");
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function addReadOnlyMount(args: string[], hostPath: string): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(hostPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Media sandbox runtime path is unavailable: ${hostPath}`);
  }
  if ((!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink() || !hasTrustedSystemOwner(stat)
    || (stat.mode & 0o022) !== 0 || fs.realpathSync(hostPath) !== hostPath) {
    throw new Error(`Unsafe media sandbox runtime path: ${hostPath}`);
  }
  args.push("--ro-bind", hostPath, hostPath);
}

function addUsrLib64(args: string[]): void {
  const hostPath = "/usr/lib64";
  let stat: fs.Stats;
  try { stat = fs.lstatSync(hostPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Media sandbox runtime path is unavailable: ${hostPath}`);
  }
  if (!hasTrustedSystemOwner(stat)) throw new Error(`Unsafe media sandbox runtime path: ${hostPath}`);
  if (stat.isSymbolicLink()) {
    if (fs.realpathSync(hostPath) !== "/usr/lib") throw new Error(`Unsafe media sandbox compatibility link: ${hostPath}`);
    args.push("--symlink", fs.readlinkSync(hostPath), hostPath);
    return;
  }
  if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || fs.realpathSync(hostPath) !== hostPath) {
    throw new Error(`Unsafe media sandbox runtime path: ${hostPath}`);
  }
  args.push("--ro-bind", hostPath, hostPath);
}

function addCompatibilityPath(args: string[], hostPath: "/bin" | "/sbin" | "/lib" | "/lib64"): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(hostPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Media sandbox runtime path is unavailable: ${hostPath}`);
  }
  if (!hasTrustedSystemOwner(stat)) throw new Error(`Unsafe media sandbox runtime path: ${hostPath}`);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(hostPath);
    const resolved = fs.realpathSync(hostPath);
    const allowed = hostPath === "/bin" || hostPath === "/sbin"
      ? new Set(["/usr/bin", "/usr/sbin"])
      : new Set(["/usr/lib", "/usr/lib64"]);
    if (!allowed.has(resolved)) throw new Error(`Unsafe media sandbox compatibility link: ${hostPath}`);
    args.push("--symlink", target, hostPath);
    return;
  }
  if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || fs.realpathSync(hostPath) !== hostPath) throw new Error(`Unsafe media sandbox runtime path: ${hostPath}`);
  if (hostPath === "/lib" || hostPath === "/lib64") args.push("--ro-bind", hostPath, hostPath);
  else args.push("--dir", hostPath);
}

function mediaSandboxArguments(executable: string, args: readonly string[], cwd: string): string[] {
  const sandboxArgs = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--hostname", "wayang-media",
    "--cap-drop", "ALL",
    "--clearenv",
    "--setenv", "LANG", "C",
    "--setenv", "LC_ALL", "C",
    "--setenv", "HOME", "/nonexistent",
    "--setenv", "PATH", "/usr/bin:/bin",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
  ];
  addReadOnlyMount(sandboxArgs, "/usr/lib");
  addUsrLib64(sandboxArgs);
  addCompatibilityPath(sandboxArgs, "/bin");
  addCompatibilityPath(sandboxArgs, "/sbin");
  addCompatibilityPath(sandboxArgs, "/lib");
  addCompatibilityPath(sandboxArgs, "/lib64");
  addReadOnlyMount(sandboxArgs, "/etc/ld.so.cache");
  addReadOnlyMount(sandboxArgs, "/etc/fonts");
  addReadOnlyMount(sandboxArgs, "/usr/share/fonts");
  addReadOnlyMount(sandboxArgs, "/usr/share/fontconfig");
  sandboxArgs.push(
    "--ro-bind", executable, executable,
    "--bind", cwd, cwd,
    "--remount-ro", "/",
    "--chdir", cwd,
    "--",
    executable,
    ...args,
  );
  return sandboxArgs;
}

function limitedMediaProcessArguments(executable: string, args: readonly string[], cwd: string): string[] {
  return [
    `--as=${LOCAL_MEDIA_PROCESS_LIMITS.addressSpaceBytes}`,
    `--fsize=${LOCAL_MEDIA_PROCESS_LIMITS.fileSizeBytes}`,
    `--cpu=${LOCAL_MEDIA_PROCESS_LIMITS.cpuSeconds}`,
    `--nofile=${LOCAL_MEDIA_PROCESS_LIMITS.openFiles}`,
    `--core=${LOCAL_MEDIA_PROCESS_LIMITS.coreBytes}`,
    `--nproc=${LOCAL_MEDIA_PROCESS_LIMITS.processes}`,
    "--",
    BWRAP_PATH,
    ...mediaSandboxArguments(executable, args, cwd),
  ];
}

/** Linux-only, resource-limited Bubblewrap runner with no host network and one private writable workspace. */
export const localProcessExecutor: ProcessExecutor = {
  run(executable, args, options) {
    requirePositiveBound(options.timeoutMs, "timeoutMs");
    requirePositiveBound(options.maxStdoutBytes, "maxStdoutBytes");
    requirePositiveBound(options.maxStderrBytes, "maxStderrBytes");
    if (process.platform !== "linux") return Promise.reject(new Error("Sandboxed media processes require Linux"));
    try {
      requireCanonicalExecutable(executable);
      requirePrivateCanonicalWorkspace(options.cwd);
      requireCanonicalLauncher(BWRAP_PATH);
      requireCanonicalLauncher(PRLIMIT_PATH);
      if (isWithin(options.cwd, executable) || isWithin(options.cwd, BWRAP_PATH) || isWithin(options.cwd, PRLIMIT_PATH)) {
        throw new Error("Media executable and sandbox launchers must be outside the writable workspace");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    if (options.signal?.aborted) return Promise.reject(new Error("Media process aborted"));
    if (localMediaProcessActive) return Promise.reject(new Error("A native media process is already active"));
    localMediaProcessActive = true;
    return new Promise<ProcessResult>((resolve, reject) => {
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(PRLIMIT_PATH, limitedMediaProcessArguments(executable, args, options.cwd), {
          cwd: "/",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: { LANG: "C", LC_ALL: "C" },
          windowsHide: true,
          detached: true,
        });
      } catch (error) {
        localMediaProcessActive = false;
        reject(error);
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure: Error | undefined;
      let settled = false;
      let terminationRequested = false;
      let timer: NodeJS.Timeout | undefined;
      let terminationTimer: NodeJS.Timeout | undefined;
      function abort(): void { stop(new Error("Media process aborted")); }
      function finish(callback: () => void): void {
        if (settled) return;
        settled = true;
        localMediaProcessActive = false;
        if (timer) clearTimeout(timer);
        if (terminationTimer) clearTimeout(terminationTimer);
        options.signal?.removeEventListener("abort", abort);
        callback();
      }
      function stop(error: Error): void {
        if (!failure) failure = error;
        if (terminationRequested) return;
        terminationRequested = true;
        if (typeof child.pid === "number") {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch { if (!child.killed) child.kill("SIGKILL"); }
        } else if (!child.killed) {
          child.kill("SIGKILL");
        }
        terminationTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(() => reject(failure!));
        }, PROCESS_TERMINATION_BOUND_MS);
      }
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > options.maxStdoutBytes) stop(new Error("Media process stdout exceeded its byte limit"));
        else stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > options.maxStderrBytes) stop(new Error("Media process stderr exceeded its byte limit"));
        else stderr.push(Buffer.from(chunk));
      });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (exitCode, signal) => finish(() => {
        if (failure) reject(failure);
        else resolve({ exitCode, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      }));
      timer = setTimeout(() => stop(new Error("Media process timed out")), options.timeoutMs);
      timer.unref();
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  },
};

export interface MediaWorkspace {
  readonly directory: string;
  readonly fileCount: number;
  writePrivateFile(name: string, bytes: Uint8Array): string;
  preparePrivateOutput(name: string): string;
  readPrivateFile(name: string, maxBytes: number): Buffer;
}

function safeWorkspaceName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new Error("Invalid media workspace filename");
}

/** Create an owner-only disposable workspace and report verified cleanup. */
export async function withMediaWorkspace<T>(
  tempRoot: string | undefined,
  operation: (workspace: MediaWorkspace) => Promise<T>,
): Promise<{ value: T; cleanup: MediaCleanupMetadata }> {
  const root = tempRoot ?? os.tmpdir();
  if (!path.isAbsolute(root)) throw new Error("Media temporary root must be absolute");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(root, "wayang-audio-"));
  fs.chmodSync(directory, 0o700);
  const files = new Map<string, { device: number; inode: number }>();
  const rememberFile = (name: string, filePath: string): void => {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
      throw new Error("Media workspace file is not a private regular file");
    }
    files.set(name, { device: stat.dev, inode: stat.ino });
  };
  const workspace: MediaWorkspace = {
    directory,
    get fileCount() { return files.size; },
    writePrivateFile(name, bytes) {
      safeWorkspaceName(name);
      const filePath = path.join(directory, name);
      fs.writeFileSync(filePath, bytes, { flag: "wx", mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
      rememberFile(name, filePath);
      return filePath;
    },
    preparePrivateOutput(name) {
      safeWorkspaceName(name);
      const filePath = path.join(directory, name);
      const descriptor = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.closeSync(descriptor);
      fs.chmodSync(filePath, 0o600);
      rememberFile(name, filePath);
      return filePath;
    },
    readPrivateFile(name, maxBytes) {
      safeWorkspaceName(name);
      requirePositiveBound(maxBytes, "maxBytes");
      const filePath = path.join(directory, name);
      const expected = files.get(name);
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      try {
        const before = fs.fstatSync(descriptor);
        if (!expected || !before.isFile() || before.dev !== expected.device || before.ino !== expected.inode || before.size > maxBytes || (process.platform !== "win32" && (before.mode & 0o077) !== 0)) {
          throw new Error("Media derivative is invalid or exceeds its byte limit");
        }
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor);
        if (bytes.length !== before.size || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino) {
          throw new Error("Media derivative changed while being read");
        }
        return bytes;
      } finally {
        fs.closeSync(descriptor);
      }
    },
  };

  let value: T;
  let operationError: unknown;
  try {
    value = await operation(workspace);
  } catch (error) {
    operationError = error;
    value = undefined as T;
  }
  let cleanupError: unknown;
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    if (fs.existsSync(directory)) throw new Error("Media temporary workspace cleanup failed");
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== undefined && cleanupError !== undefined) throw new AggregateError([operationError, cleanupError], "Media operation and cleanup failed");
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return {
    value,
    cleanup: { temporaryDirectoryRemoved: true, temporaryFileCount: files.size, sourceDeleted: false },
  };
}

export async function runProcessChecked(
  executor: ProcessExecutor,
  executable: string,
  args: readonly string[],
  options: ProcessRunOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new Error("Media process aborted");
  const result = await executor.run(executable, args, options);
  if (options.signal?.aborted) throw new Error("Media process aborted");
  if (result.stdout.length > options.maxStdoutBytes) throw new Error("Media process stdout exceeded its byte limit");
  if (result.stderr.length > options.maxStderrBytes) throw new Error("Media process stderr exceeded its byte limit");
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString("utf8").replace(/[\r\n\t]+/g, " ").trim().slice(0, 512);
    throw new Error(`Media process failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function boundedTags(...tagSets: unknown[]): Readonly<Record<string, string>> {
  const tags: Record<string, string> = {};
  for (const candidate of tagSets) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    for (const [key, rawValue] of Object.entries(candidate as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
      if (Object.keys(tags).length >= 32) return tags;
      if (typeof rawValue !== "string" && typeof rawValue !== "number") continue;
      tags[key.slice(0, 128)] = String(rawValue).slice(0, 512);
    }
  }
  return tags;
}

/** Probe one already-bounded private file with ffprobe and normalize its bounded JSON. */
export async function probeAudioPath(
  filePath: string,
  validation: AudioValidation,
  options: {
    executor: ProcessExecutor;
    ffprobePath: string;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<FfprobeAudioMetadata> {
  const result = await runProcessChecked(options.executor, options.ffprobePath, [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_streams",
    "-show_format",
    "-of", "json",
    filePath,
  ], {
    cwd: path.dirname(filePath),
    timeoutMs: options.timeoutMs,
    maxStdoutBytes: DEFAULT_PROCESS_STDOUT_BYTES,
    maxStderrBytes: DEFAULT_PROCESS_STDERR_BYTES,
    signal: options.signal,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new Error("ffprobe returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("ffprobe returned invalid metadata");
  const document = parsed as { streams?: unknown; format?: unknown };
  if (!Array.isArray(document.streams) || document.streams.length !== 1 || !document.streams[0] || typeof document.streams[0] !== "object") {
    throw new Error("ffprobe did not return exactly one selected audio stream");
  }
  const stream = document.streams[0] as Record<string, unknown>;
  const format = document.format && typeof document.format === "object" ? document.format as Record<string, unknown> : {};
  if (stream.codec_type !== undefined && stream.codec_type !== "audio") throw new Error("ffprobe selected a non-audio stream");
  const durationSeconds = finiteNumber(stream.duration) ?? finiteNumber(format.duration);
  if (durationSeconds === undefined) throw new Error("ffprobe did not report a finite audio duration");
  requireDurationWithinCap(durationSeconds);
  const sampleRateHz = finiteNumber(stream.sample_rate);
  const channels = finiteNumber(stream.channels);
  const sizeBytes = finiteNumber(format.size) ?? validation.byteLength;
  if (!sampleRateHz || !Number.isInteger(sampleRateHz) || !channels || !Number.isInteger(channels)) throw new Error("ffprobe audio shape is invalid");
  if (sampleRateHz !== validation.sampleRateHz || channels !== validation.channels) throw new Error("ffprobe audio shape does not match structural validation");
  if (sizeBytes !== validation.byteLength) throw new Error("ffprobe size does not match the supplied bytes");
  const codecName = typeof stream.codec_name === "string" ? stream.codec_name.slice(0, 128) : "unknown";
  const formatName = typeof format.format_name === "string" ? format.format_name.slice(0, 128) : validation.format;
  if (validation.format === "mp3" && (codecName !== "mp3" || !formatName.split(",").includes("mp3"))) {
    throw new Error("ffprobe metadata does not match the validated MP3 container");
  }
  if (validation.format === "wav" && !formatName.split(",").includes("wav")) {
    throw new Error("ffprobe metadata does not match the validated RIFF/WAVE container");
  }
  return {
    formatName,
    ...(typeof format.format_long_name === "string" ? { formatLongName: format.format_long_name.slice(0, 256) } : {}),
    durationSeconds,
    sizeBytes,
    ...(finiteNumber(format.bit_rate) !== undefined ? { bitRate: finiteNumber(format.bit_rate)! } : {}),
    codecName,
    ...(typeof stream.codec_long_name === "string" ? { codecLongName: stream.codec_long_name.slice(0, 256) } : {}),
    sampleRateHz,
    channels,
    ...(typeof stream.channel_layout === "string" ? { channelLayout: stream.channel_layout.slice(0, 128) } : {}),
    ...(typeof stream.sample_fmt === "string" ? { sampleFormat: stream.sample_fmt.slice(0, 64) } : {}),
    ...(finiteNumber(stream.bits_per_sample) !== undefined ? { bitsPerSample: finiteNumber(stream.bits_per_sample)! } : {}),
    tags: boundedTags(format.tags, stream.tags),
  };
}

function mediaRuntimeOptions(options: ProbeAudioOptions): {
  executor: ProcessExecutor;
  ffprobePath: string;
  timeoutMs: number;
  signal?: AbortSignal;
} {
  requirePositiveBound(options.maxBytes, "maxBytes");
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEDIA_PROCESS_TIMEOUT_MS;
  requirePositiveBound(timeoutMs, "timeoutMs");
  const executor = options.executor ?? localProcessExecutor;
  return {
    executor,
    ffprobePath: options.ffprobePath ?? (executor === localProcessExecutor ? DEFAULT_FFPROBE_PATH : "ffprobe"),
    timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

/** Validate, hash, and ffprobe bounded in-memory audio without retaining a source copy. */
export async function probeAudio(input: Uint8Array, options: ProbeAudioOptions): Promise<ProbedAudio> {
  const validation = validateAudioBytes(input, options.maxBytes);
  const bytes = Buffer.from(input);
  const runtime = mediaRuntimeOptions(options);
  const result = await withMediaWorkspace(options.tempRoot, async (workspace) => {
    const inputPath = workspace.writePrivateFile(`input.${validation.format}`, bytes);
    const ffprobe = await probeAudioPath(inputPath, validation, runtime);
    return { validation, sha256: createHash("sha256").update(bytes).digest("hex"), ffprobe };
  });
  return { ...result.value, cleanup: result.cleanup };
}

/** Strip metadata, artwork, chapters, video, subtitles, and data using audio stream copy. */
export async function sanitizeAudio(input: Uint8Array, options: SanitizeAudioOptions): Promise<SanitizedAudio> {
  const sourceValidation = validateAudioBytes(input, options.maxBytes);
  const sourceBytes = Buffer.from(input);
  const runtime = mediaRuntimeOptions(options);
  const ffmpegPath = options.ffmpegPath ?? (runtime.executor === localProcessExecutor ? DEFAULT_FFMPEG_PATH : "ffmpeg");
  const result = await withMediaWorkspace(options.tempRoot, async (workspace) => {
    const inputName = `source.${sourceValidation.format}`;
    const outputName = `sanitized.${sourceValidation.format}`;
    const inputPath = workspace.writePrivateFile(inputName, sourceBytes);
    const outputPath = workspace.preparePrivateOutput(outputName);
    const sourceProbe = await probeAudioPath(inputPath, sourceValidation, runtime);
    const muxerArgs = sourceValidation.format === "mp3"
      ? ["-f", "mp3", "-id3v2_version", "0", "-write_id3v1", "0"]
      : ["-f", "wav", "-write_bext", "0"];
    await runProcessChecked(runtime.executor, ffmpegPath, [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-threads", "1",
      "-i", inputPath,
      "-map", "0:a:0", "-vn", "-sn", "-dn",
      "-map_metadata", "-1", "-map_chapters", "-1",
      "-c:a", "copy", "-fflags", "+bitexact", "-flags:a", "+bitexact",
      ...muxerArgs,
      outputPath,
    ], {
      cwd: workspace.directory,
      timeoutMs: runtime.timeoutMs,
      maxStdoutBytes: DEFAULT_PROCESS_STDOUT_BYTES,
      maxStderrBytes: DEFAULT_PROCESS_STDERR_BYTES,
      signal: runtime.signal,
    });
    const sanitizedBytes = workspace.readPrivateFile(outputName, options.maxBytes);
    const validation = validateAudioBytes(sanitizedBytes, options.maxBytes);
    if (validation.format !== sourceValidation.format) throw new Error("Sanitized audio format changed unexpectedly");
    const probe = await probeAudioPath(outputPath, validation, runtime);
    if (Object.keys(probe.tags).length !== 0) throw new Error("Sanitized audio still contains metadata tags");
    return {
      format: validation.format,
      bytes: sanitizedBytes,
      byteLength: sanitizedBytes.length,
      sha256: createHash("sha256").update(sanitizedBytes).digest("hex"),
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      sourceValidation,
      validation,
      sourceProbe,
      probe,
      method: "ffmpeg-stream-copy" as const,
    };
  });
  return { ...result.value, cleanup: result.cleanup };
}
