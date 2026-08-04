import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ManagedChromiumDownloadProgress,
  ManagedChromiumDownloadWillBegin,
} from "../browser/manager.js";
import {
  MAX_PROTECTED_AUTOMATION_INCOMING_BYTES,
  MAX_PROTECTED_AUTOMATION_INCOMING_FILES,
} from "./types.js";

export const MAX_PROTECTED_AUTOMATION_DOWNLOADS = 32;
export const MAX_PROTECTED_AUTOMATION_DOWNLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_PROTECTED_AUTOMATION_DOWNLOAD_HANDLES = 64;

interface DownloadRecord {
  guid: string;
  sourceUrl: string;
  suggestedFilename: string;
  totalBytes: number;
  receivedBytes: number;
  status: "pending" | "completed";
}

interface DownloadHandle {
  token: string;
  guid: string;
  runId: string;
  generation: string;
}

export interface ProtectedAutomationCompletedDownload {
  handle: string;
  suggestedFilename: string;
  sizeBytes: number;
  sourceOrigin: string;
}

export interface ProtectedAutomationMaterializedDownload {
  name: string;
  sizeBytes: number;
  sha256: string;
}

function downloadError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function exactHttpsOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function safeGuid(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function safeOutputName(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= 255
    && value !== "." && value !== ".." && path.basename(value) === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function fallbackName(value: string): string {
  const normalized = value.normalize("NFC");
  return safeOutputName(normalized) ? normalized : "download.bin";
}

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw downloadError("Download destination is unsafe");
  fs.chmodSync(directory, 0o700);
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function incomingUsage(directory: string): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(directory)) {
    const metadata = fs.lstatSync(path.join(directory, name));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw downloadError("Incoming materialization directory contains an unsafe entry");
    }
    count += 1;
    bytes += metadata.size;
    if (count > MAX_PROTECTED_AUTOMATION_INCOMING_FILES || bytes > MAX_PROTECTED_AUTOMATION_INCOMING_BYTES) {
      throw downloadError("Incoming materialization quota exceeded");
    }
  }
  return { count, bytes };
}

/**
 * Browser-event-owned registry. Files remain opaque until a one-use handle is
 * materialized into the exact run's incoming directory.
 */
export class ProtectedAutomationDownloadRegistry {
  private readonly records = new Map<string, DownloadRecord>();
  private readonly handles = new Map<string, DownloadHandle>();
  private revoked = false;

  constructor(
    private readonly downloadsDir: string,
    private readonly allowedOrigins: ReadonlySet<string>,
    private readonly runId: string | null,
    private readonly generation: string,
  ) {
    privateDirectory(downloadsDir);
    // The realm is exclusively leased and Chromium is stopped here. Remove
    // crash-left staging files before a new lease can consume disk or mint a
    // handle for bytes not observed by this generation.
    for (const name of fs.readdirSync(downloadsDir)) {
      if (!safeGuid(name)) throw downloadError("Download staging contains an unsafe entry");
      const target = path.join(downloadsDir, name);
      const metadata = fs.lstatSync(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw downloadError("Download staging contains an unsafe entry");
      }
      fs.unlinkSync(target);
    }
  }

  begin(event: ManagedChromiumDownloadWillBegin): boolean {
    if (this.revoked || !safeGuid(event.guid) || this.records.size >= MAX_PROTECTED_AUTOMATION_DOWNLOADS) return false;
    const origin = exactHttpsOrigin(event.url);
    if (!origin || !this.allowedOrigins.has(origin) || this.records.has(event.guid)) return false;
    this.records.set(event.guid, {
      guid: event.guid,
      sourceUrl: event.url,
      suggestedFilename: fallbackName(String(event.suggestedFilename || "download.bin")),
      totalBytes: 0,
      receivedBytes: 0,
      status: "pending",
    });
    return true;
  }

  private discard(guid: string): void {
    this.records.delete(guid);
    if (!safeGuid(guid)) return;
    try { fs.unlinkSync(path.join(this.downloadsDir, guid)); } catch { /* absent/locked staging file */ }
  }

  /** Return true when Chromium must be cancelled to enforce the storage bound. */
  progress(event: ManagedChromiumDownloadProgress): boolean {
    if (this.revoked || !safeGuid(event.guid)) return false;
    const record = this.records.get(event.guid);
    if (!record) return false;
    if (event.state === "canceled") {
      this.discard(event.guid);
      return false;
    }
    if (!Number.isSafeInteger(event.receivedBytes) || event.receivedBytes < 0
      || !Number.isSafeInteger(event.totalBytes) || event.totalBytes < 0
      || event.receivedBytes > MAX_PROTECTED_AUTOMATION_DOWNLOAD_BYTES
      || event.totalBytes > MAX_PROTECTED_AUTOMATION_DOWNLOAD_BYTES) {
      this.discard(event.guid);
      return true;
    }
    record.receivedBytes = event.receivedBytes;
    record.totalBytes = event.totalBytes;
    if (event.state === "completed") record.status = "completed";
    return false;
  }

  pendingGuids(): string[] {
    return this.revoked ? [] : [...this.records.values()].filter((record) => record.status === "pending").map((record) => record.guid);
  }

  listCompleted(): ProtectedAutomationCompletedDownload[] {
    if (this.revoked || !this.runId) return [];
    const activeByGuid = new Map([...this.handles.values()].map((handle) => [handle.guid, handle]));
    const result: ProtectedAutomationCompletedDownload[] = [];
    for (const record of this.records.values()) {
      if (record.status !== "completed") continue;
      const source = path.join(this.downloadsDir, record.guid);
      let metadata: fs.Stats;
      try { metadata = fs.lstatSync(source); } catch { continue; }
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || metadata.size > MAX_PROTECTED_AUTOMATION_DOWNLOAD_BYTES || metadata.size !== record.receivedBytes) continue;
      let handle = activeByGuid.get(record.guid);
      if (!handle) {
        if (this.handles.size >= MAX_PROTECTED_AUTOMATION_DOWNLOAD_HANDLES) break;
        handle = {
          token: randomBytes(24).toString("base64url"),
          guid: record.guid,
          runId: this.runId,
          generation: this.generation,
        };
        this.handles.set(handle.token, handle);
      }
      result.push({
        handle: handle.token,
        suggestedFilename: record.suggestedFilename,
        sizeBytes: metadata.size,
        sourceOrigin: new URL(record.sourceUrl).origin,
      });
    }
    return result;
  }

  materialize(handleToken: string, requestedName: string | undefined, runRoot: string): ProtectedAutomationMaterializedDownload {
    if (this.revoked || !this.runId) throw downloadError("Download handle is unavailable");
    const handle = this.handles.get(handleToken);
    // Consumption happens before any filesystem operation: success and failure
    // both exhaust the bearer handle.
    if (handle) this.handles.delete(handleToken);
    if (!handle || handle.runId !== this.runId || handle.generation !== this.generation) {
      throw downloadError("Download handle is unavailable");
    }
    const record = this.records.get(handle.guid);
    if (!record || record.status !== "completed") throw downloadError("Download is incomplete");
    const name = requestedName === undefined ? record.suggestedFilename : requestedName.normalize("NFC");
    if (!safeOutputName(name)) throw downloadError("Download destination name is invalid");

    const incoming = path.join(runRoot, "incoming");
    privateDirectory(incoming);
    const usage = incomingUsage(incoming);
    if (usage.count >= MAX_PROTECTED_AUTOMATION_INCOMING_FILES) throw downloadError("Incoming materialization count quota exceeded");
    const sourcePath = path.join(this.downloadsDir, handle.guid);
    const destinationPath = path.join(incoming, name);
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    let source = -1;
    let destination = -1;
    let destinationCreated = false;
    let committed = false;
    const digest = createHash("sha256");
    let copied = 0;
    try {
      source = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow);
      const sourceMetadata = fs.fstatSync(source);
      if (!sourceMetadata.isFile() || sourceMetadata.nlink !== 1 || sourceMetadata.size > MAX_PROTECTED_AUTOMATION_DOWNLOAD_BYTES) {
        throw downloadError("Download source is unsafe or oversized");
      }
      if (usage.bytes + sourceMetadata.size > MAX_PROTECTED_AUTOMATION_INCOMING_BYTES) {
        throw downloadError("Incoming materialization byte quota exceeded");
      }
      destination = fs.openSync(
        destinationPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      );
      destinationCreated = true;
      const buffer = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        const count = fs.readSync(source, buffer, 0, buffer.length, null);
        if (count === 0) break;
        copied += count;
        if (copied > MAX_PROTECTED_AUTOMATION_DOWNLOAD_BYTES) throw downloadError("Download exceeded its materialization bound");
        digest.update(buffer.subarray(0, count));
        let offset = 0;
        while (offset < count) offset += fs.writeSync(destination, buffer, offset, count - offset);
      }
      if (copied !== sourceMetadata.size) throw downloadError("Download changed during materialization");
      fs.fsyncSync(destination);
      fs.closeSync(destination); destination = -1;
      fs.closeSync(source); source = -1;
      fsyncDirectory(incoming);
      fs.unlinkSync(sourcePath);
      fsyncDirectory(this.downloadsDir);
      this.records.delete(handle.guid);
      for (const [token, candidate] of this.handles) if (candidate.guid === handle.guid) this.handles.delete(token);
      committed = true;
      return { name, sizeBytes: copied, sha256: digest.digest("hex") };
    } finally {
      if (source >= 0) fs.closeSync(source);
      if (destination >= 0) fs.closeSync(destination);
      if (!committed && destinationCreated) {
        try { fs.unlinkSync(destinationPath); } catch { /* no partial publication */ }
      }
    }
  }

  revoke(): void {
    if (this.revoked) return;
    this.revoked = true;
    this.handles.clear();
    for (const record of this.records.values()) {
      if (!safeGuid(record.guid)) continue;
      try { fs.unlinkSync(path.join(this.downloadsDir, record.guid)); } catch { /* absent/locked staging file */ }
    }
    this.records.clear();
  }
}
