import { constants, promises as fs } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalJson, ensurePrivateDirectory, fsyncDirectory } from "./fs-state.mjs";

export class LockHeldError extends Error {
  constructor(message = "maintenance run lock is already held") {
    super(message);
    this.name = "LockHeldError";
    this.code = "LOCK_HELD";
  }
}

async function sameFile(path, expected) {
  try {
    const current = await fs.lstat(path);
    return current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && expected.nlink === 1 && current.dev === expected.dev && current.ino === expected.ino;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function acquireRunLock(path, { now = () => new Date(), pid = process.pid } = {}) {
  if (!isAbsolute(path)) throw new TypeError("run lock path must be absolute");
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  let handle;
  try {
    handle = await fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new LockHeldError();
    throw error;
  }
  let acquired;
  try {
    acquired = await handle.stat();
    const nonce = randomBytes(16).toString("hex");
    const record = canonicalJson({ schema: "wayang-maintenance-lock/v1", pid, startedAt: now().toISOString(), nonce });
    if (Buffer.byteLength(record) > 1024) throw new Error("lock record unexpectedly large");
    await handle.writeFile(record, "utf8");
    await handle.sync();
    await fsyncDirectory(parent);
    let unlinked = false;
    let directorySynced = false;
    let closed = false;
    let released = false;
    return Object.freeze({
      nonce,
      async release() {
        if (released) return;
        if (!unlinked) {
          if (!await sameFile(path, acquired)) {
            if (!closed) {
              await handle.close();
              closed = true;
            }
            throw new Error("run lock path changed while held; refusing to unlink replacement");
          }
          await fs.unlink(path);
          unlinked = true;
        }
        if (!directorySynced) {
          await fsyncDirectory(parent);
          directorySynced = true;
        }
        if (!closed) {
          await handle.close();
          closed = true;
        }
        released = unlinked && directorySynced && closed;
      },
    });
  } catch (error) {
    try {
      if (acquired && await sameFile(path, acquired)) {
        await fs.unlink(path);
        await fsyncDirectory(parent);
      }
    } finally {
      await handle.close().catch(() => {});
    }
    throw error;
  }
}
