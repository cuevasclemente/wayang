import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface DiscoveredProject {
  cwd: string;
  name: string;
  hasPiSessions: boolean;
  hasGit: boolean;
  hasPiConfig: boolean;
  hasPackageJson: boolean;
  lastModified: number;
}

/** Discover likely project roots without exposing a general filesystem API. */
export function discoverProjects(): DiscoveredProject[] {
  const homedir = os.homedir();
  const scanDirs = [path.join(homedir, "src"), homedir];
  const piSessionsDir = path.join(homedir, ".pi", "agent", "sessions");
  const hasPiSessions = new Set<string>();
  if (fs.existsSync(piSessionsDir)) {
    try {
      for (const entry of fs.readdirSync(piSessionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const inner = entry.name.replace(/^--/, "").replace(/--$/, "");
        const cwd = inner === "~"
          ? homedir
          : inner.startsWith("~-")
            ? path.join(homedir, inner.slice(2).split("-").join("/"))
            : `/${inner.split("-").join("/")}`;
        if (cwd && cwd !== "/") hasPiSessions.add(cwd);
      }
    } catch { /* unavailable session catalog is not project discovery failure */ }
  }

  const projects: DiscoveredProject[] = [];
  const seen = new Set<string>();
  const skipDirs = new Set([
    "Desktop", "Documents", "Downloads", "Music", "Pictures", "Videos", "Templates", "Public",
    "snap", ".cache", ".config", ".local", ".npm", ".ssh", ".mozilla", ".vscode", ".docker",
    "go", "www", "Sync", "NextcloudSync", "__pycache__",
  ]);

  for (const scanDir of scanDirs) {
    if (!fs.existsSync(scanDir)) continue;
    try {
      for (const entry of fs.readdirSync(scanDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || skipDirs.has(entry.name)) continue;
        const cwd = path.join(scanDir, entry.name);
        if (seen.has(cwd)) continue;
        seen.add(cwd);
        const hasGit = fs.existsSync(path.join(cwd, ".git"));
        const hasPiConfig = fs.existsSync(path.join(cwd, ".pi"));
        const hasPackageJson = fs.existsSync(path.join(cwd, "package.json"));
        const hasPi = hasPiSessions.has(cwd);
        if (!hasGit && !hasPiConfig && !hasPackageJson && !hasPi) continue;
        let lastModified = 0;
        try { lastModified = fs.statSync(cwd).mtimeMs; } catch { /* keep zero */ }
        projects.push({ cwd, name: entry.name, hasPiSessions: hasPi, hasGit, hasPiConfig, hasPackageJson, lastModified });
      }
    } catch { /* skip unreadable discovery root */ }
  }

  return projects.sort((a, b) => {
    const score = (project: DiscoveredProject) => (project.hasPiSessions ? 100 : 0)
      + (project.hasPiConfig ? 50 : 0) + (project.hasGit ? 30 : 0) + (project.hasPackageJson ? 10 : 0);
    return score(b) - score(a) || b.lastModified - a.lastModified;
  });
}
