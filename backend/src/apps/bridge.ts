import { randomUUID } from "node:crypto";
import { flush, getStore, type AppEventRow, type AppStateRow } from "../db.js";
import { sendMessage } from "../pi-bridge.js";
import { getSessionById } from "../sessions.js";
import type { AppEvent, AppStateRecord, RegisteredApp } from "./types.js";

const MAX_EVENTS_PER_APP = 200;

function eventMatches(app: RegisteredApp, event: AppEventRow): boolean {
  return event.appId === app.id && event.projectCwd === app.projectCwd;
}

function stateMatches(app: RegisteredApp, state: AppStateRow): boolean {
  return state.app_id === app.id && state.project_cwd === app.projectCwd;
}

export function getAppState(app: RegisteredApp): AppStateRecord {
  const existing = getStore().appStates.find((row) => stateMatches(app, row));
  return {
    appId: app.id,
    sessionId: existing?.session_id ?? app.sessionId,
    projectCwd: app.projectCwd,
    state: existing?.state ?? null,
    updatedAt: existing?.updated_at ?? 0,
  };
}

export function setAppState(app: RegisteredApp, state: unknown): AppStateRecord {
  const store = getStore();
  const now = Date.now();
  let row = store.appStates.find((candidate) => stateMatches(app, candidate));
  if (!row) {
    row = {
      app_id: app.id,
      session_id: app.sessionId ?? null,
      project_cwd: app.projectCwd,
      state,
      updated_at: now,
    };
    store.appStates.push(row);
  } else {
    row.session_id = app.sessionId ?? row.session_id;
    row.state = state;
    row.updated_at = now;
  }
  flush();
  return getAppState(app);
}

export function listAppEvents(app: RegisteredApp): AppEvent[] {
  return getStore().appEvents
    .filter((event) => eventMatches(app, event))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_EVENTS_PER_APP);
}

export async function addAppEvent(
  app: RegisteredApp,
  input: { event: string; payload?: unknown; summary?: string; sessionId?: string; sendToAgent?: boolean },
): Promise<AppEvent> {
  if (!input.event || typeof input.event !== "string") {
    throw new Error("event is required");
  }
  const sessionId = input.sessionId ?? app.sessionId;
  const event: AppEventRow = {
    id: randomUUID(),
    appId: app.id,
    sessionId,
    projectCwd: app.projectCwd,
    type: "app_event",
    event: input.event,
    payload: input.payload,
    summary: typeof input.summary === "string" ? input.summary : undefined,
    createdAt: Date.now(),
  };

  const store = getStore();
  store.appEvents.push(event);
  const eventsForApp = store.appEvents.filter((candidate) => eventMatches(app, candidate));
  if (eventsForApp.length > MAX_EVENTS_PER_APP) {
    const keep = new Set(eventsForApp.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_EVENTS_PER_APP).map((candidate) => candidate.id));
    store.appEvents = store.appEvents.filter((candidate) => !eventMatches(app, candidate) || keep.has(candidate.id));
  }
  flush();

  if (input.sendToAgent && sessionId && getSessionById(sessionId)) {
    const summary = event.summary || event.event;
    const payloadText = event.payload === undefined ? "" : `\n\nPayload:\n\`\`\`json\n${JSON.stringify(event.payload, null, 2)}\n\`\`\``;
    await sendMessage(
      sessionId,
      `[App event from ${app.manifest.name} (${app.id})]\n${summary}${payloadText}`,
    );
  }

  return event;
}
