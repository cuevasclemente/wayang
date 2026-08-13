import * as fs from "node:fs";
import * as path from "node:path";
import {
  browserProfileStorageIdentityDigest,
  browserProfileStorageRoot,
  type BrowserProfileRow,
} from "./profile-catalog-store.js";

export interface BrowserProfileStorageDescriptor {
  profileId: string;
  root: string;
  identityDigest: string;
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolve metadata only. No profile entry is opened or enumerated. */
export function resolveBrowserProfileStorageDescriptor(
  dataDir: string,
  profile: Readonly<BrowserProfileRow>,
): BrowserProfileStorageDescriptor {
  const base = fs.realpathSync.native(path.resolve(dataDir));
  const root = browserProfileStorageRoot(base, profile.storage_source);
  if (!pathWithin(base, root)) throw new Error("Browser Profile storage escaped WAYANG_DATA_DIR");
  const identityDigest = browserProfileStorageIdentityDigest(base, profile.storage_source);
  if (identityDigest !== profile.storage_identity_digest) {
    throw new Error("Browser Profile storage identity changed");
  }
  return { profileId: profile.id, root, identityDigest };
}

export interface BrowserStorageOpenerLease {
  readonly descriptor: Readonly<BrowserProfileStorageDescriptor>;
  readonly ownerId: string;
  release(): void;
}

interface OpenerRecord {
  profileId: string;
  ownerId: string;
  leases: number;
}

/**
 * Process-wide canonical storage opener witness. It is the authority that
 * prevents legacy/generic and named hosts from launching two Chromium
 * processes against one profile root. Chromium lock files remain secondary.
 */
export class BrowserStorageOwnershipRegistry {
  private readonly openers = new Map<string, OpenerRecord>();
  private closed = false;

  claim(descriptor: Readonly<BrowserProfileStorageDescriptor>, ownerId: string): BrowserStorageOpenerLease {
    if (this.closed) throw new Error("Browser storage registry is closed");
    if (!ownerId || ownerId.length > 256) throw new Error("Browser storage opener owner is invalid");
    const existing = this.openers.get(descriptor.identityDigest);
    if (existing && (existing.ownerId !== ownerId || existing.profileId !== descriptor.profileId)) {
      throw new Error("Browser Profile storage is already open by another host");
    }
    const record = existing ?? { profileId: descriptor.profileId, ownerId, leases: 0 };
    record.leases += 1;
    this.openers.set(descriptor.identityDigest, record);
    let released = false;
    return {
      descriptor: { ...descriptor },
      ownerId,
      release: () => {
        if (released) return;
        released = true;
        const current = this.openers.get(descriptor.identityDigest);
        if (!current || current !== record || current.ownerId !== ownerId) return;
        current.leases -= 1;
        if (current.leases === 0) this.openers.delete(descriptor.identityDigest);
      },
    };
  }

  isOpen(identityDigest: string): boolean {
    return this.openers.has(identityDigest);
  }

  activeCount(): number {
    return this.openers.size;
  }

  close(): void {
    this.closed = true;
    this.openers.clear();
  }
}

/** Validate only ancestor metadata that already exists; never inspect profile contents. */
export function assertBrowserStorageAncestorsSafe(dataDir: string, descriptor: Readonly<BrowserProfileStorageDescriptor>): void {
  const base = fs.realpathSync.native(path.resolve(dataDir));
  let cursor = descriptor.root;
  const existing: string[] = [];
  while (pathWithin(base, cursor) && cursor !== base) {
    try {
      const stat = fs.lstatSync(cursor);
      existing.push(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Browser Profile storage ancestor is unsafe");
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        throw new Error("Browser Profile storage ancestor has the wrong owner");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    cursor = path.dirname(cursor);
  }
  if (cursor !== base) throw new Error("Browser Profile storage escaped WAYANG_DATA_DIR");
  // Ensure an existing canonical base cannot be replaced through a symlink.
  const baseStat = fs.lstatSync(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error("WAYANG_DATA_DIR is unsafe for Browser Profiles");
  void existing;
}
