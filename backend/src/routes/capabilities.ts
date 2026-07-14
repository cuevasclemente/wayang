import { Router, type Request, type Response } from "express";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export const router = Router();

const execFileAsync = promisify(execFile);

interface CapabilityPath {
  label: string;
  path: string;
  exists: boolean;
}

interface Capability {
  id: string;
  title: string;
  category: "agents" | "workflow" | "providers" | "security" | "automation" | "configuration";
  status: "available" | "partial" | "planned" | "external";
  summary: string;
  ui: string[];
  tools?: string[];
  commands?: string[];
  paths?: CapabilityPath[];
}

interface ScheduledJob {
  id: string;
  name: string;
  backend: "systemd-user" | "cron";
  enabled: boolean | null;
  schedule: string;
  command: string;
  status: string;
  nextRun: string | null;
  lastRun: string | null;
}

function pathInfo(label: string, path: string): CapabilityPath {
  return { label, path, exists: existsSync(path) };
}

function listDirNames(path: string): string[] {
  try {
    return readdirSync(path)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

function safeProjectCwd(req: Request): string | null {
  const value = req.query.cwd;
  if (typeof value !== "string" || value.trim() === "") return null;
  return resolve(value);
}

function extensionExists(name: string, cwd: string | null): boolean {
  const home = homedir();
  const candidates = [
    join(home, ".pi/agent/extensions", name),
    join(home, ".pi/agent/extensions", `${name}.ts`),
  ];
  if (cwd) {
    candidates.push(join(cwd, ".pi/extensions", name));
    candidates.push(join(cwd, ".pi/extensions", `${name}.ts`));
  }
  return candidates.some((p) => existsSync(p));
}

function computeCapabilities(cwd: string | null): Capability[] {
  const home = homedir();
  const globalExt = join(home, ".pi/agent/extensions");
  const globalSkills = join(home, ".pi/agent/skills");
  const globalAgents = join(home, ".pi/agent/agents");
  const globalTeams = join(home, ".pi/agent/teams");
  const projectPi = cwd ? join(cwd, ".pi") : null;

  return [
    {
      id: "agent-teams",
      title: "Agent teams, subagents, and goals",
      category: "agents",
      status: extensionExists("agent-teams", cwd) ? "available" : "planned",
      summary: "Design/spawn long-lived subagents, dispatch one-shot teams, and track shared goals.",
      ui: ["Dedicated capability card", "Session goal chip/input", "Future live subagent tree and goal tree"],
      tools: ["subagent_spawn", "subagent_send", "subagent_poll", "subagent_stop", "subagent_dispatch", "goals_*"],
      commands: ["/subagents", "/goals", "/goals:add", "/goals:done"],
      paths: [
        pathInfo("global extension", join(globalExt, "agent-teams")),
        ...(projectPi ? [pathInfo("project .pi", projectPi)] : []),
      ],
    },
    {
      id: "todo",
      title: "Persistent TODOs",
      category: "workflow",
      status: extensionExists("todo", cwd) ? "available" : "planned",
      summary: "Expose agent-managed task lists that survive session restarts and branching.",
      ui: ["Workflow capability card", "Future task list/editor panel", "Future custom tool-result rendering"],
      tools: ["todo"],
      commands: ["/todos", "/todos-full", "/todos-reevaluate"],
      paths: [pathInfo("global extension", join(globalExt, "todo"))],
    },
    {
      id: "interview-questionnaire",
      title: "Interview and questionnaire forms",
      category: "workflow",
      status: extensionExists("interview", cwd) || extensionExists("questionnaire", cwd) ? "available" : "partial",
      summary: "Render structured agent questions as web forms when compatible companion tools are installed.",
      ui: ["Inline chat form", "Multiple-choice tabs", "Free-text answers"],
      tools: ["interview", "questionnaire"],
      paths: [pathInfo("web bridge", join(process.cwd(), "backend/src/interview-bridge.ts"))],
    },
    {
      id: "providers-models",
      title: "Providers and models",
      category: "providers",
      status: "available",
      summary: "Use pi's provider registry, OAuth/API-key authentication, and model selection without exposing credential values.",
      ui: ["Selected provider/model", "Model picker"],
      tools: ["provider-backed model selection"],
      paths: [pathInfo("pi auth storage", join(home, ".pi/agent/auth.json"))],
    },
    {
      id: "hooks-monitors",
      title: "Hooks and monitors",
      category: "workflow",
      status: extensionExists("hooks", cwd) || extensionExists("agent-monitor", cwd) ? "available" : "planned",
      summary: "Surface lifecycle hook activity, monitor reminders, and journaling prompts in the web session.",
      ui: ["Capability card", "Custom hook messages render in chat history", "Future hook activity feed", "Future enable/disable controls"],
      tools: ["agent-monitor", "hooks"],
      paths: [pathInfo("hooks config", join(home, ".pi/agent/hooks.json"))],
    },
    {
      id: "skills-agents-teams",
      title: "Skills, agents, and team templates",
      category: "configuration",
      status: "partial",
      summary: "Browse and eventually edit reusable skills plus local/global agent and team definitions.",
      ui: [
        `Global skills: ${listDirNames(globalSkills).join(", ") || "none detected"}`,
        `Global agents: ${listDirNames(globalAgents).join(", ") || "none detected"}`,
        `Global teams: ${listDirNames(globalTeams).join(", ") || "none detected"}`,
      ],
      paths: [
        pathInfo("global skills", globalSkills),
        pathInfo("global agents", globalAgents),
        pathInfo("global teams", globalTeams),
        ...(projectPi ? [pathInfo("project .pi", projectPi)] : []),
      ],
    },
    {
      id: "scheduled-jobs",
      title: "Scheduled pi jobs",
      category: "automation",
      status: "partial",
      summary: "Expose systemd user timers and crontab entries that run pi-related automation.",
      ui: ["Scheduled jobs list", "Future create/edit/enable/disable/run-now controls"],
      tools: ["systemd user timers", "cron"],
      paths: [pathInfo("systemd user dir", join(home, ".config/systemd/user"))],
    },
  ];
}

async function listSystemdTimers(): Promise<ScheduledJob[]> {
  try {
    const { stdout } = await execFileAsync("systemctl", [
      "--user",
      "list-timers",
      "--all",
      "--no-pager",
      "--no-legend",
    ], { timeout: 3000, maxBuffer: 1024 * 1024 });

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const timerMatch = line.match(/([^\s]+\.timer)\s+([^\s]+\.service)\s*$/);
        const name = timerMatch?.[1] ?? line.split(/\s+/).find((part) => part.endsWith(".timer")) ?? "";
        const service = timerMatch?.[2] ?? "";
        const piRelated = /(^|[-_.])(pi|mypi)([-_.]|$)/i.test(name) || /(^|[-_.])(pi|mypi)([-_.]|$)/i.test(service);
        if (!piRelated || !name) return [];
        return [{
          id: `systemd-user:${name}`,
          name,
          backend: "systemd-user" as const,
          enabled: null,
          schedule: "systemd timer",
          command: service,
          status: "pi-related",
          nextRun: null,
          lastRun: null,
        }];
      });
  } catch {
    return [];
  }
}

async function listCronJobs(): Promise<ScheduledJob[]> {
  try {
    const { stdout } = await execFileAsync("crontab", ["-l"], { timeout: 3000, maxBuffer: 1024 * 1024 });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .flatMap((line, index) => {
        const parts = line.split(/\s+/);
        const schedule = parts.slice(0, 5).join(" ");
        const command = parts.slice(5).join(" ");
        if (!/\b(pi|mypi)\b/i.test(command)) return [];
        return [{
          id: `cron:${index}`,
          name: `pi-related crontab entry #${index + 1}`,
          backend: "cron" as const,
          enabled: true,
          schedule,
          command: "details hidden",
          status: "pi-related",
          nextRun: null,
          lastRun: null,
        }];
      });
  } catch {
    return [];
  }
}

router.get("/capabilities", (req: Request, res: Response) => {
  const cwd = safeProjectCwd(req);
  res.json({ cwd, capabilities: computeCapabilities(cwd) });
});

router.get("/scheduled-jobs", async (_req: Request, res: Response) => {
  try {
    const [systemd, cron] = await Promise.all([listSystemdTimers(), listCronJobs()]);
    const jobs = [...systemd, ...cron];
    res.json({ jobs });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});
