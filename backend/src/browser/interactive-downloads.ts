import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ManagedChromiumDownloadProgress,
  ManagedChromiumDownloadWillBegin,
} from "./manager.js";

export const MAX_INTERACTIVE_BROWSER_DOWNLOADS = 32;
export const MAX_INTERACTIVE_BROWSER_DOWNLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_INTERACTIVE_BROWSER_PUBLISHED_BYTES = 64 * 1024 * 1024;

export interface InteractiveBrowserDownloadState {
  status: "downloading" | "completed" | "canceled";
  suggestedFilename: string;
  relativePath?: string;
  bytes?: number;
  reason?: "count_quota" | "file_quota" | "aggregate_quota" | "unsafe_source" | "publication_failed";
  updatedAt: number;
}

interface DownloadRecord {
  guid: string;
  suggestedFilename: string;
  receivedBytes: number;
  state: "downloading" | "publishing";
}

function downloadError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function safeGuid(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function httpsDownloadUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") return Boolean(parsed.hostname) && !parsed.username && !parsed.password;
    if (parsed.protocol !== "blob:") return false;
    const embedded = new URL(value.slice("blob:".length));
    return embedded.protocol === "https:" && Boolean(embedded.hostname) && !embedded.username && !embedded.password;
  } catch {
    return false;
  }
}

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw downloadError("Interactive browser download directory is unsafe");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw downloadError("Interactive browser download directory has the wrong owner");
  }
  fs.chmodSync(directory, 0o700);
}

function fsyncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch { /* best-effort durability on filesystems that do not fsync directories */ }
}

function sanitizeFilename(value: string): string {
  const basename = path.basename(String(value || "download.bin").normalize("NFC"))
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim();
  const candidate = basename && basename !== "." && basename !== ".." ? basename : "download.bin";
  let output = "";
  for (const scalar of candidate) {
    if (Buffer.byteLength(output + scalar, "utf8") > 220) break;
    output += scalar;
  }
  return output || "download.bin";
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function publicationUsage(directory: string, projectRoot: string): { count: number; bytes: number; dev: number; ino: number } {
  privateDirectory(path.dirname(directory));
  privateDirectory(directory);
  const canonical = fs.realpathSync.native(directory);
  if (!pathWithin(projectRoot, canonical)) throw downloadError("Interactive browser download publication escaped the Project");
  const directoryMetadata = fs.lstatSync(directory);
  let count = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(directory)) {
    const target = path.join(directory, name);
    const metadata = fs.lstatSync(target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw downloadError("Interactive browser download publication contains an unsafe entry");
    }
    count += 1;
    bytes += metadata.size;
    if (count > MAX_INTERACTIVE_BROWSER_DOWNLOADS || bytes > MAX_INTERACTIVE_BROWSER_PUBLISHED_BYTES) {
      throw downloadError("Interactive browser download publication quota is already exceeded");
    }
  }
  return { count, bytes, dev: directoryMetadata.dev, ino: directoryMetadata.ino };
}

function collisionName(directory: string, suggested: string): string {
  const extension = path.extname(suggested);
  const stem = suggested.slice(0, suggested.length - extension.length) || "download";
  for (let index = 0; index <= 9_999; index += 1) {
    const suffix = index === 0 ? "" : `-${index}`;
    let boundedStem = "";
    for (const scalar of stem) {
      if (Buffer.byteLength(`${boundedStem}${scalar}${suffix}${extension}`, "utf8") > 250) break;
      boundedStem += scalar;
    }
    const name = `${boundedStem || "download"}${suffix}${extension}`;
    if (!fs.existsSync(path.join(directory, name))) return name;
  }
  throw downloadError("Interactive browser download name collision limit exceeded");
}

/** One exact interactive browser lease. Chromium writes GUID-named files into
 * private staging; only completed bounded regular files are copied into the
 * Project's ordinary .wayang/browser-downloads directory. */
export class InteractiveBrowserDownloadPublisher {
  private readonly records = new Map<string, DownloadRecord>();
  private readonly observedGuids = new Set<string>();
  private readonly projectRoot: string;
  private readonly publicationDir: string;
  private observedCount: number;
  private revoked = false;
  private latestState: InteractiveBrowserDownloadState | undefined;

  constructor(
    private readonly stagingDir: string,
    projectCwd: string,
    options: { cleanStaging?: boolean } = {},
  ) {
    this.projectRoot = fs.realpathSync.native(projectCwd);
    this.publicationDir = path.join(this.projectRoot, ".wayang", "browser-downloads");
    this.observedCount = fs.existsSync(this.publicationDir)
      ? publicationUsage(this.publicationDir, this.projectRoot).count
      : 0;
    privateDirectory(stagingDir);
    if (options.cleanStaging === false) return;
    for (const name of fs.readdirSync(stagingDir)) {
      if (!safeGuid(name)) throw downloadError("Interactive browser download staging contains an unsafe entry");
      const target = path.join(stagingDir, name);
      const metadata = fs.lstatSync(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw downloadError("Interactive browser download staging contains an unsafe entry");
      }
      fs.unlinkSync(target);
    }
  }

  get latest(): InteractiveBrowserDownloadState | undefined {
    return this.latestState ? { ...this.latestState } : undefined;
  }

  begin(event: ManagedChromiumDownloadWillBegin): { accepted: true } | { accepted: false; reason: InteractiveBrowserDownloadState["reason"] } {
    const suggestedFilename = sanitizeFilename(event.suggestedFilename);
    if (this.revoked || !safeGuid(event.guid) || this.observedGuids.has(event.guid)) {
      this.latestState = { status: "canceled", suggestedFilename, reason: "unsafe_source", updatedAt: Date.now() };
      return { accepted: false, reason: "unsafe_source" };
    }
    if (this.observedCount >= MAX_INTERACTIVE_BROWSER_DOWNLOADS) {
      this.latestState = { status: "canceled", suggestedFilename, reason: "count_quota", updatedAt: Date.now() };
      return { accepted: false, reason: "count_quota" };
    }
    this.observedCount += 1;
    this.observedGuids.add(event.guid);
    if (!httpsDownloadUrl(event.url)) {
      this.latestState = { status: "canceled", suggestedFilename, reason: "unsafe_source", updatedAt: Date.now() };
      return { accepted: false, reason: "unsafe_source" };
    }
    this.records.set(event.guid, { guid: event.guid, suggestedFilename, receivedBytes: 0, state: "downloading" });
    this.latestState = { status: "downloading", suggestedFilename, bytes: 0, updatedAt: Date.now() };
    return { accepted: true };
  }

  private discard(guid: string): void {
    this.records.delete(guid);
    if (!safeGuid(guid)) return;
    try { fs.unlinkSync(path.join(this.stagingDir, guid)); } catch { /* absent or still locked by Chromium */ }
  }

  private aggregateReceivedBytes(): number {
    let total = fs.existsSync(this.publicationDir)
      ? publicationUsage(this.publicationDir, this.projectRoot).bytes
      : 0;
    for (const record of this.records.values()) total += record.receivedBytes;
    return total;
  }

  pendingGuids(): string[] {
    return this.revoked ? [] : [...this.records.keys()];
  }

  cancelPending(): void {
    for (const record of this.records.values()) {
      try { fs.unlinkSync(path.join(this.stagingDir, record.guid)); } catch { /* absent or locked */ }
    }
    this.records.clear();
  }

  async progress(
    event: ManagedChromiumDownloadProgress,
    assertAuthorized: () => Promise<void>,
  ): Promise<{ cancel: boolean; state?: InteractiveBrowserDownloadState }> {
    if (this.revoked || !safeGuid(event.guid)) return { cancel: false, state: this.latest };
    const record = this.records.get(event.guid);
    if (!record) return { cancel: true, state: this.latest };
    if (event.state === "canceled") {
      this.discard(event.guid);
      this.latestState = { status: "canceled", suggestedFilename: record.suggestedFilename, updatedAt: Date.now() };
      return { cancel: false, state: this.latest };
    }
    if (!Number.isSafeInteger(event.receivedBytes) || event.receivedBytes < 0
      || !Number.isSafeInteger(event.totalBytes) || event.totalBytes < 0
      || event.receivedBytes > MAX_INTERACTIVE_BROWSER_DOWNLOAD_BYTES
      || event.totalBytes > MAX_INTERACTIVE_BROWSER_DOWNLOAD_BYTES) {
      this.discard(event.guid);
      this.latestState = { status: "canceled", suggestedFilename: record.suggestedFilename, bytes: Math.max(0, Number(event.receivedBytes) || 0), reason: "file_quota", updatedAt: Date.now() };
      return { cancel: true, state: this.latest };
    }
    record.receivedBytes = event.receivedBytes;
    if (event.state === "completed" && event.totalBytes !== event.receivedBytes) {
      this.discard(event.guid);
      this.latestState = { status: "canceled", suggestedFilename: record.suggestedFilename, bytes: event.receivedBytes, reason: "publication_failed", updatedAt: Date.now() };
      return { cancel: true, state: this.latest };
    }
    if (this.aggregateReceivedBytes() > MAX_INTERACTIVE_BROWSER_PUBLISHED_BYTES) {
      this.discard(event.guid);
      this.latestState = { status: "canceled", suggestedFilename: record.suggestedFilename, bytes: event.receivedBytes, reason: "aggregate_quota", updatedAt: Date.now() };
      return { cancel: true, state: this.latest };
    }
    this.latestState = { status: "downloading", suggestedFilename: record.suggestedFilename, bytes: event.receivedBytes, updatedAt: Date.now() };
    if (event.state !== "completed") return { cancel: false, state: this.latest };
    record.state = "publishing";
    try {
      await assertAuthorized();
      const published = this.publish(record);
      this.latestState = published;
      return { cancel: false, state: this.latest };
    } catch (error) {
      this.discard(event.guid);
      this.latestState = { status: "canceled", suggestedFilename: record.suggestedFilename, bytes: event.receivedBytes, reason: "publication_failed", updatedAt: Date.now() };
      throw error;
    }
  }

  private publish(record: DownloadRecord): InteractiveBrowserDownloadState {
    const sourcePath = path.join(this.stagingDir, record.guid);
    const usage = publicationUsage(this.publicationDir, this.projectRoot);
    if (usage.count >= MAX_INTERACTIVE_BROWSER_DOWNLOADS) {
      throw downloadError("Interactive browser download publication count quota is exceeded");
    }
    const name = collisionName(this.publicationDir, record.suggestedFilename);
    const destinationPath = path.join(this.publicationDir, name);
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    let source = -1;
    let destination = -1;
    let destinationCreated = false;
    let committed = false;
    let copied = 0;
    try {
      source = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow);
      const metadata = fs.fstatSync(source);
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== record.receivedBytes
        || metadata.size > MAX_INTERACTIVE_BROWSER_DOWNLOAD_BYTES
        || usage.bytes + metadata.size > MAX_INTERACTIVE_BROWSER_PUBLISHED_BYTES) {
        throw downloadError("Interactive browser download source is unsafe or exceeds its quota");
      }
      const beforeOpen = fs.lstatSync(this.publicationDir);
      if (beforeOpen.isSymbolicLink() || !beforeOpen.isDirectory() || beforeOpen.dev !== usage.dev || beforeOpen.ino !== usage.ino) {
        throw downloadError("Interactive browser download publication directory changed before commit");
      }
      destination = fs.openSync(destinationPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
      destinationCreated = true;
      const destinationMetadata = fs.fstatSync(destination);
      const afterOpen = fs.lstatSync(this.publicationDir);
      if (!destinationMetadata.isFile() || destinationMetadata.nlink !== 1 || afterOpen.isSymbolicLink()
        || !afterOpen.isDirectory() || afterOpen.dev !== usage.dev || afterOpen.ino !== usage.ino
        || !pathWithin(this.projectRoot, fs.realpathSync.native(destinationPath))) {
        throw downloadError("Interactive browser download publication directory changed during commit");
      }
      const buffer = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        const count = fs.readSync(source, buffer, 0, buffer.length, null);
        if (count === 0) break;
        copied += count;
        if (copied > MAX_INTERACTIVE_BROWSER_DOWNLOAD_BYTES) throw downloadError("Interactive browser download changed while publishing");
        let offset = 0;
        while (offset < count) offset += fs.writeSync(destination, buffer, offset, count - offset);
      }
      if (copied !== metadata.size) throw downloadError("Interactive browser download changed while publishing");
      fs.fsyncSync(destination);
      fs.closeSync(destination); destination = -1;
      fs.closeSync(source); source = -1;
      fsyncDirectory(this.publicationDir);
      fs.unlinkSync(sourcePath);
      fsyncDirectory(this.stagingDir);
      this.records.delete(record.guid);
      committed = true;
      return {
        status: "completed",
        suggestedFilename: record.suggestedFilename,
        relativePath: path.posix.join(".wayang", "browser-downloads", name),
        bytes: copied,
        updatedAt: Date.now(),
      };
    } finally {
      if (source >= 0) fs.closeSync(source);
      if (destination >= 0) fs.closeSync(destination);
      if (!committed && destinationCreated) {
        try { fs.unlinkSync(destinationPath); } catch { /* never expose a partial publication */ }
      }
    }
  }

  revoke(): void {
    if (this.revoked) return;
    this.revoked = true;
    this.cancelPending();
  }
}
