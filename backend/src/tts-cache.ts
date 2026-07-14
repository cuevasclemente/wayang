/**
 * tts-cache.ts — Ephemeral audio cache for TTS output.
 *
 * Writes generated audio files to WAYANG_DATA_DIR/tts/{uuid}.{fmt} and cleans up
 * files older than 24 hours or when the total cache exceeds 200 MB.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfig } from "./config.js";

export function getTtsCacheDir(): string {
  return path.join(getConfig().dataDir, "tts");
}

function ensureCacheDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function cacheFilePath(filename: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(filename) || path.basename(filename) !== filename) return null;
  return path.join(getTtsCacheDir(), filename);
}

/**
 * Write audio buffer to cache. Returns the filename (without path).
 */
export async function writeAudio(
  audio: Buffer,
  format: string,
): Promise<string> {
  const dir = getTtsCacheDir();
  ensureCacheDir(dir);
  if (!/^[A-Za-z0-9]{1,12}$/.test(format)) throw new Error("Invalid TTS audio format");

  const id = randomUUID();
  const filename = `${id}.${format}`;
  const filePath = path.join(dir, filename);

  await fs.promises.writeFile(filePath, audio, { mode: 0o600 });
  return filename;
}

/**
 * Read an audio file from cache. Returns undefined if not found.
 */
export async function readAudio(
  filename: string,
): Promise<{ data: Buffer; size: number; mtime: Date } | undefined> {
  const filePath = cacheFilePath(filename);
  if (!filePath) return undefined;

  try {
    const stat = await fs.promises.stat(filePath);
    const data = await fs.promises.readFile(filePath);
    return { data, size: stat.size, mtime: stat.mtime };
  } catch {
    return undefined;
  }
}

/**
 * Remove an audio file from cache.
 */
export async function deleteAudio(filename: string): Promise<boolean> {
  const filePath = cacheFilePath(filename);
  if (!filePath) return false;

  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run cache cleanup: remove files older than maxAgeMs, and if the total
 * cache exceeds maxTotalBytes, remove oldest files until under the limit.
 */
export async function cleanupCache(options?: {
  maxAgeMs?: number;
  maxTotalBytes?: number;
}): Promise<{ deleted: number; freedBytes: number }> {
  const maxAgeMs = options?.maxAgeMs ?? 24 * 60 * 60 * 1000; // 24 hours
  const maxTotalBytes = options?.maxTotalBytes ?? 200 * 1024 * 1024; // 200 MB
  const dir = getTtsCacheDir();
  const now = Date.now();

  let deleted = 0;
  let freedBytes = 0;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return { deleted, freedBytes };
  }

  // Collect files with stats
  const files: Array<{
    name: string;
    path: string;
    size: number;
    mtime: number;
  }> = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const stat = await fs.promises.stat(filePath);
      files.push({
        name: entry.name,
        path: filePath,
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    } catch {
      // File disappeared, skip
    }
  }

  // Sort by mtime ascending (oldest first)
  files.sort((a, b) => a.mtime - b.mtime);

  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  for (const file of files) {
    const isOld = now - file.mtime > maxAgeMs;
    const isOverLimit = totalBytes > maxTotalBytes;

    if (!isOld && !isOverLimit) break;

    try {
      await fs.promises.unlink(file.path);
      deleted += 1;
      freedBytes += file.size;
      totalBytes -= file.size;
    } catch {
      // Couldn't delete, skip
    }
  }

  return { deleted, freedBytes };
}
