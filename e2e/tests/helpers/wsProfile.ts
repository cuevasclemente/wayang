import type { Page } from "@playwright/test";

export interface WsProfileEntry {
  event: string;
  at: number;
  wallTime: string | null;
  details: Record<string, unknown>;
}

export interface WsConnectionTiming {
  sessionId: string;
  connectStartMs: number | null;
  socketOpenMs: number | null;
  sessionReadyMs: number | null;
  openDurationMs: number | null;
  readyDurationMs: number | null;
  entries: WsProfileEntry[];
}

declare global {
  interface Window {
    __chatWsProfileEntries?: WsProfileEntry[];
  }
}

export async function installWsProfileCollector(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as Window & { __chatWsProfileEntries?: WsProfileEntry[] };
    win.__chatWsProfileEntries = [];

    const originalLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      const first = typeof args[0] === "string" ? args[0] : "";
      if (first.startsWith("[chat-ws-profile]")) {
        const wallTimeMatch = first.match(/^\[chat-ws-profile\]\s+(\S+)\s+event=([^\s]+)/);
        const event = wallTimeMatch?.[2] ?? "unknown";
        const detailsArg = args[1];
        const details = detailsArg && typeof detailsArg === "object"
          ? JSON.parse(JSON.stringify(detailsArg)) as Record<string, unknown>
          : {};
        win.__chatWsProfileEntries?.push({
          event,
          at: performance.now(),
          wallTime: wallTimeMatch?.[1] ?? null,
          details,
        });
      }
      originalLog(...args);
    };
  });
}

export async function getWsProfileEntries(page: Page): Promise<WsProfileEntry[]> {
  return page.evaluate(() => window.__chatWsProfileEntries ?? []);
}

export async function getWsConnectionTiming(page: Page, sessionId: string): Promise<WsConnectionTiming> {
  const entries = await getWsProfileEntries(page);
  const relevant = entries.filter((entry) => entry.details?.sessionId === sessionId || entry.details?.activeSessionId === sessionId);
  const connectStart = relevant.find((entry) => entry.event === "connect_start");
  const socketOpen = relevant.find((entry) => entry.event === "socket_open");
  const sessionReady = relevant.find((entry) => entry.event === "message_session_ready");

  return {
    sessionId,
    connectStartMs: connectStart?.at ?? null,
    socketOpenMs: socketOpen?.at ?? null,
    sessionReadyMs: sessionReady?.at ?? null,
    openDurationMs: typeof socketOpen?.details?.elapsedMs === "number" ? socketOpen.details.elapsedMs : null,
    readyDurationMs: typeof sessionReady?.details?.elapsedMs === "number" ? sessionReady.details.elapsedMs : null,
    entries,
  };
}

export function formatWsConnectionTiming(timing: WsConnectionTiming): string {
  const lines = [
    `sessionId=${timing.sessionId}`,
    `connectStartMs=${timing.connectStartMs ?? "missing"}`,
    `socketOpenMs=${timing.socketOpenMs ?? "missing"} openDurationMs=${timing.openDurationMs ?? "missing"}`,
    `sessionReadyMs=${timing.sessionReadyMs ?? "missing"} readyDurationMs=${timing.readyDurationMs ?? "missing"}`,
    "",
    "events:",
  ];

  for (const entry of timing.entries) {
    lines.push(`${entry.at.toFixed(1)} ${entry.event} ${JSON.stringify(entry.details)}`);
  }

  return lines.join("\n");
}
