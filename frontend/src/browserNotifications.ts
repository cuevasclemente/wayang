import { sessionPath } from "./routing/sessionRoute";
import type { HumanAttention } from "./humanAttention";

const NOTIFICATIONS_ENABLED_KEY = "wayang:human-attention:browser-notifications-enabled";
const SEEN_SOURCE_IDS_KEY = "wayang:human-attention:seen-source-ids";
const MAX_SEEN_SOURCE_IDS = 4096;

export type BrowserNotificationState =
  | { kind: "unsupported" }
  | { kind: "off"; permission: "default" | "granted" }
  | { kind: "granted" }
  | { kind: "denied" }
  | { kind: "error"; message: string };

export interface AttentionSessionSummary {
  id: string;
  humanAttention: HumanAttention[];
}

let seenSourceIds: Set<string> | null = null;
let seenSourceIdOrder: string[] | null = null;

function safeStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage failure must not impair persistent in-app attention.
  }
}

function notificationsEnabled(): boolean {
  return safeStorageGet(NOTIFICATIONS_ENABLED_KEY) === "1";
}

function loadSeenSourceIds(): { ids: Set<string>; order: string[] } {
  if (seenSourceIds && seenSourceIdOrder) return { ids: seenSourceIds, order: seenSourceIdOrder };
  let stored: unknown = [];
  try {
    stored = JSON.parse(safeStorageGet(SEEN_SOURCE_IDS_KEY) ?? "[]");
  } catch {
    stored = [];
  }
  const order = Array.isArray(stored)
    ? stored.filter((value): value is string => typeof value === "string" && value.length > 0).slice(-MAX_SEEN_SOURCE_IDS)
    : [];
  seenSourceIdOrder = [...new Set(order)];
  seenSourceIds = new Set(seenSourceIdOrder);
  return { ids: seenSourceIds, order: seenSourceIdOrder };
}

function rememberSourceIds(sourceIds: string[]): void {
  const { ids, order } = loadSeenSourceIds();
  let changed = false;
  for (const sourceId of sourceIds) {
    if (ids.has(sourceId)) continue;
    ids.add(sourceId);
    order.push(sourceId);
    changed = true;
  }
  if (!changed) return;
  while (order.length > MAX_SEEN_SOURCE_IDS) order.shift();
  safeStorageSet(SEEN_SOURCE_IDS_KEY, JSON.stringify(order));
}

export function getBrowserNotificationState(): BrowserNotificationState {
  if (typeof window === "undefined" || !("Notification" in window)) return { kind: "unsupported" };
  if (window.Notification.permission === "denied") return { kind: "denied" };
  if (window.Notification.permission === "granted" && notificationsEnabled()) return { kind: "granted" };
  return { kind: "off", permission: window.Notification.permission === "granted" ? "granted" : "default" };
}

/** This is the only code path that may request Web Notification permission. */
export async function enableBrowserNotifications(): Promise<BrowserNotificationState> {
  if (!("Notification" in window)) return { kind: "unsupported" };
  try {
    const permission = window.Notification.permission === "granted"
      ? "granted"
      : await window.Notification.requestPermission();
    if (permission === "granted") {
      safeStorageSet(NOTIFICATIONS_ENABLED_KEY, "1");
      return { kind: "granted" };
    }
    safeStorageSet(NOTIFICATIONS_ENABLED_KEY, "0");
    return permission === "denied" ? { kind: "denied" } : { kind: "off", permission: "default" };
  } catch (error) {
    safeStorageSet(NOTIFICATIONS_ENABLED_KEY, "0");
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export function disableBrowserNotifications(): BrowserNotificationState {
  safeStorageSet(NOTIFICATIONS_ENABLED_KEY, "0");
  return getBrowserNotificationState();
}

/**
 * Record every observed source ID, even while notifications are off. Enabling
 * notifications therefore never emits old gates that were already visible in
 * Wayang. Reconnects and catalog replay are deduplicated by opaque source ID.
 */
export function observeHumanAttention(sessions: AttentionSessionSummary[]): void {
  if (typeof window === "undefined") return;
  const { ids } = loadSeenSourceIds();
  const batchSourceIds = new Set<string>();
  const newlyObserved: Array<{ sessionId: string; sourceId: string }> = [];

  for (const session of sessions) {
    for (const attention of session.humanAttention) {
      if (!ids.has(attention.sourceId) && !batchSourceIds.has(attention.sourceId)) {
        batchSourceIds.add(attention.sourceId);
        newlyObserved.push({ sessionId: session.id, sourceId: attention.sourceId });
      }
    }
  }
  rememberSourceIds(newlyObserved.map(({ sourceId }) => sourceId));

  if (getBrowserNotificationState().kind !== "granted") return;
  for (const { sessionId } of newlyObserved) {
    try {
      const notification = new window.Notification("Wayang needs your input", {
        body: "Question waiting in Wayang",
      });
      notification.onclick = () => {
        window.focus();
        window.location.assign(sessionPath(sessionId));
        notification.close();
      };
    } catch {
      // OS/browser delivery failures never remove or block in-app attention.
    }
  }
}

