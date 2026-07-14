/**
 * fs.ts — Sandboxed filesystem operations.
 *
 * All paths are resolved relative to the configured fsRoot (default: $HOME).
 * Symlinks outside the root are rejected.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { getConfig } from "./config.js";

export type FsEntryType = "file" | "dir" | "symlink";

export interface FsEntry {
  name: string;
  type: FsEntryType;
  size: number;
  mtime: number;
}

export interface FsTree {
  root: string;
  path: string;
  entries: FsEntry[];
}

export interface FsTextRead {
  text: string;
  size: number;
  sha256: string;
  name: string;
}

export interface FsBinaryRead {
  binary: true;
  data_b64: string;
  size: number;
  name: string;
}

export interface FsTooLarge {
  too_large: true;
  size: number;
  name: string;
}

export type FsRead = FsTextRead | FsBinaryRead | FsTooLarge;

function resolvePath(relativePath: string): string {
  const config = getConfig();
  const normalized = path.normalize(relativePath).replace(/^[/\\]+/, "");
  const resolved = path.resolve(config.fsRoot, normalized);

  // Must stay within root
  if (!resolved.startsWith(config.fsRoot + path.sep) && resolved !== config.fsRoot) {
    throw new Error(`Path traversal denied: ${relativePath}`);
  }

  return resolved;
}

function isBinary(buffer: Buffer): boolean {
  // Check first 8KB for null bytes
  const chunk = buffer.subarray(0, 8192);
  return chunk.includes(0);
}

export function tree(relativePath: string): FsTree {
  const resolved = resolvePath(relativePath);
  const config = getConfig();

  if (!fs.existsSync(resolved)) {
    throw new Error(`Path not found: ${relativePath}`);
  }

  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${relativePath}`);
  }

  const entries: FsEntry[] = [];
  const dirEntries = fs.readdirSync(resolved, { withFileTypes: true });

  for (const entry of dirEntries) {
    // Resolve and check symlink safety
    const entryPath = path.join(resolved, entry.name);
    let entryStat: fs.Stats;
    try {
      entryStat = fs.lstatSync(entryPath);
    } catch {
      continue;
    }

    // For symlinks, verify target is within root
    if (entryStat.isSymbolicLink()) {
      try {
        const realPath = fs.realpathSync(entryPath);
        if (
          !realPath.startsWith(config.fsRoot + path.sep) &&
          realPath !== config.fsRoot
        ) {
          continue; // Skip symlinks pointing outside root
        }
      } catch {
        continue; // Broken symlink
      }
    }

    const type: FsEntryType = entryStat.isDirectory()
      ? "dir"
      : entryStat.isSymbolicLink()
        ? "symlink"
        : "file";

    entries.push({
      name: entry.name,
      type,
      size: entryStat.size,
      mtime: entryStat.mtimeMs,
    });
  }

  entries.sort((a, b) => {
    // Directories first, then by name
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (a.type !== "dir" && b.type === "dir") return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    root: config.fsRoot,
    path: relativePath || ".",
    entries,
  };
}

export function read(relativePath: string): FsRead {
  const resolved = resolvePath(relativePath);
  const config = getConfig();

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${relativePath}`);
  }

  const stat = fs.lstatSync(resolved);
  if (stat.isDirectory()) {
    throw new Error(`Is a directory: ${relativePath}`);
  }

  if (stat.size > config.maxReadSize) {
    return {
      too_large: true,
      size: stat.size,
      name: path.basename(resolved),
    };
  }

  const buffer = fs.readFileSync(resolved);

  if (isBinary(buffer)) {
    return {
      binary: true,
      data_b64: buffer.toString("base64"),
      size: stat.size,
      name: path.basename(resolved),
    };
  }

  const text = buffer.toString("utf-8");
  const sha256 = crypto.createHash("sha256").update(text).digest("hex");

  return {
    text,
    size: stat.size,
    sha256,
    name: path.basename(resolved),
  };
}

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

export interface DiscoveredProject {
  cwd: string;
  name: string;
  hasPiSessions: boolean;
  hasGit: boolean;
  hasPiConfig: boolean;
  hasPackageJson: boolean;
  lastModified: number;
}

/**
 * Scan filesystem directories for potential projects.
 * Looks in ~/src, ~/, and other common locations.
 * Sorts by signal strength (pi sessions > pi config > git > package.json > mtime).
 */
export function discoverProjects(): DiscoveredProject[] {
  const homedir = os.homedir();
  const scanDirs: string[] = [
    path.join(homedir, "src"),
    homedir,
  ];

  // Build set of cwds that have pi sessions
  const piSessionsDir = path.join(homedir, ".pi", "agent", "sessions");
  const hasPiSessions = new Set<string>();
  if (fs.existsSync(piSessionsDir)) {
    try {
      for (const entry of fs.readdirSync(piSessionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        // Pi session dir naming: / becomes -, wrapped with -- prefix/suffix
        // e.g. --home-example-src-project-- -> /home/example/src/project
        const inner = entry.name
          .replace(/^--/, "")
          .replace(/--$/, "");
        let cwd: string;
        if (inner === "~") {
          cwd = homedir;
        } else if (inner.startsWith("~-")) {
          // Legacy/bad session dirs created from a literal ~/src/foo cwd.
          // Decode them to the real home path so project discovery doesn't
          // offer invalid /~/src/foo or ~/src/foo projects.
          cwd = path.join(homedir, inner.slice(2).split("-").join("/"));
        } else {
          cwd = "/" + inner.split("-").join("/");
        }
        if (cwd && cwd !== "/") {
          hasPiSessions.add(cwd);
        }
      }
    } catch {
      // ignore errors reading sessions dir
    }
  }

  const projects: DiscoveredProject[] = [];
  const seen = new Set<string>();

  // Common home directories that are never interesting projects
  const skipDirs = new Set([
    "Desktop",
    "Documents",
    "Downloads",
    "Music",
    "Pictures",
    "Videos",
    "Templates",
    "Public",
    "snap",
    ".cache",
    ".config",
    ".local",
    ".npm",
    ".ssh",
    ".mozilla",
    ".vscode",
    ".docker",
    "go",
    "www",
    "Sync",
    "NextcloudSync",
    "__pycache__",
  ]);

  for (const scanDir of scanDirs) {
    if (!fs.existsSync(scanDir)) continue;
    try {
      const entries = fs.readdirSync(scanDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        if (skipDirs.has(entry.name)) continue;

        const cwd = path.join(scanDir, entry.name);
        if (seen.has(cwd)) continue;
        seen.add(cwd);

        const hasGit = fs.existsSync(path.join(cwd, ".git"));
        const hasPiConfig = fs.existsSync(path.join(cwd, ".pi"));
        const hasPackageJson = fs.existsSync(path.join(cwd, "package.json"));
        const hasPi = hasPiSessions.has(cwd);

        // Only include directories with at least one signal
        if (!hasGit && !hasPiConfig && !hasPackageJson && !hasPi) {
          continue;
        }

        const project: DiscoveredProject = {
          cwd,
          name: entry.name,
          hasPiSessions: hasPi,
          hasGit,
          hasPiConfig,
          hasPackageJson,
          lastModified: 0,
        };

        try {
          const stat = fs.statSync(cwd);
          project.lastModified = stat.mtimeMs;
        } catch {
          // ignore
        }

        projects.push(project);
      }
    } catch {
      // ignore errors scanning
    }
  }

  // Sort by signal strength, then mtime
  projects.sort((a, b) => {
    const scoreA = signalScore(a);
    const scoreB = signalScore(b);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return b.lastModified - a.lastModified;
  });

  return projects;
}

function signalScore(p: DiscoveredProject): number {
  let score = 0;
  if (p.hasPiSessions) score += 100;
  if (p.hasPiConfig) score += 50;
  if (p.hasGit) score += 30;
  if (p.hasPackageJson) score += 10;
  return score;
}

export function write(
  relativePath: string,
  content: string,
  expectedSha256?: string,
): { sha256: string; size: number } {
  const resolved = resolvePath(relativePath);
  const config = getConfig();

  // Refuse writes under .pi/ directories to protect pi config
  if (resolved.includes(path.sep + ".pi" + path.sep) || resolved.endsWith(path.sep + ".pi")) {
    throw new Error("Cannot write to .pi configuration directories");
  }

  // Refuse writes to pi agent dir
  const agentDir = path.join(config.fsRoot, ".pi", "agent");
  if (resolved.startsWith(agentDir + path.sep) || resolved === agentDir) {
    throw new Error("Cannot write to pi agent directory");
  }

  // Verify expected content hash if provided (optimistic concurrency)
  if (expectedSha256) {
    if (fs.existsSync(resolved)) {
      const existing = fs.readFileSync(resolved, "utf-8");
      const existingHash = crypto
        .createHash("sha256")
        .update(existing)
        .digest("hex");
      if (existingHash !== expectedSha256) {
        const err = new Error("File changed externally");
        (err as any).statusCode = 412;
        throw err;
      }
    }
  }

  const newSha256 = crypto.createHash("sha256").update(content).digest("hex");

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, "utf-8");

  return { sha256: newSha256, size: Buffer.byteLength(content, "utf-8") };
}
