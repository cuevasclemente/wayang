import { expect, type Page } from "@playwright/test";

interface SyntheticTtsSource extends EventTarget { closed: boolean }
declare global {
  interface Window {
    __tts: {
      sources: SyntheticTtsSource[];
      plays: string[];
      pauses: string[];
      rejectNext: boolean;
      holdNext: boolean;
      pending: Array<(error: Error) => void>;
    };
  }
}

export async function installTtsFixture(page: Page, nativeMedia = false) {
  await page.addInitScript(({ nativeMedia }) => {
    window.__tts = { sources: [], plays: [], pauses: [], rejectNext: false, holdNext: false, pending: [] };
    class TtsEvents extends EventTarget {
      onerror = null;
      closed = false;
      constructor(url: string) {
        super();
        if (url.startsWith("/api/tts/")) window.__tts.sources.push(this);
      }
      close() { this.closed = true; }
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: TtsEvents });
    const originalPlay = HTMLMediaElement.prototype.play;
    const originalPause = HTMLMediaElement.prototype.pause;
    const states = new WeakMap<HTMLMediaElement, { paused: boolean; ended: boolean }>();
    const mediaState = (media: HTMLMediaElement) => {
      let state = states.get(media);
      if (!state) {
        state = { paused: true, ended: false };
        states.set(media, state);
        media.addEventListener("ended", () => { state!.paused = true; state!.ended = true; });
      }
      return state;
    };
    if (!nativeMedia) {
      Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get() { return mediaState(this).paused; } });
      Object.defineProperty(HTMLMediaElement.prototype, "ended", { configurable: true, get() { return mediaState(this).ended; } });
    }
    HTMLMediaElement.prototype.play = function () {
      window.__tts.plays.push(this.getAttribute("src") ?? "");
      if (window.__tts.rejectNext) {
        window.__tts.rejectNext = false;
        return Promise.reject(new DOMException("Synthetic autoplay rejection", "NotAllowedError"));
      }
      if (window.__tts.holdNext) {
        window.__tts.holdNext = false;
        return new Promise<void>((_resolve, reject) => { window.__tts.pending.push(reject); });
      }
      if (nativeMedia) return originalPlay.call(this);
      mediaState(this).paused = false;
      mediaState(this).ended = false;
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      window.__tts.pauses.push(this.getAttribute("src") ?? "");
      if (nativeMedia) return originalPause.call(this);
      if (mediaState(this).paused) return;
      mediaState(this).paused = true;
      this.dispatchEvent(new Event("pause"));
    };
    class Socket {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSED = 3;
      readyState = 0;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose = null;
      onerror = null;
      constructor(url: string) {
        const params = new URL(url, location.href).searchParams;
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
          this.select(params.get("session_id"), params.get("selection_id"));
        }, 0);
      }
      close() { this.readyState = 3; }
      send(raw: string) {
        const value = JSON.parse(raw);
        if (value.type === "switch_session") this.select(value.session_id, value.selection_id);
      }
      select(sessionId: string | null, selectionId: string | null) {
        const emit = (payload: object) => this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ ...payload, session_id: sessionId, selection_id: selectionId }) }));
        emit({ type: "session_ready" });
        emit({ type: "history", messages: [
          { type: "user", id: "user", message: { role: "user", content: "Synthetic TTS request" } },
          { type: "assistant", id: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Synthetic TTS response" }] } },
        ] });
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: Socket });
  }, { nativeMedia });
  const sessions = ["tts-a", "tts-b"].map((id) => ({
    id, title: id, cwd: "/synthetic/tts", pi_session_file: null,
    provider: "synthetic", model: "synthetic", agent_profile_id: null,
    created_at: 1, last_active: 1, archived: 0, goal: null, goal_status: null,
    scheduled_job_id: null, scheduled_run_id: null, error: null,
    runtime_status: "stopped", runtime_is_streaming: false, runtime_subscriber_count: 0,
    runtime_last_activity_at: null, bash_mode: "unavailable", pending_agent_switch: null,
  }));
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/status") return route.fulfill({ json: { enabled: false, authenticated: true } });
    if (path === "/api/sessions") return route.fulfill({ json: sessions });
    if (path === "/api/models") return route.fulfill({ json: { models: [], defaultModel: null } });
    if (path === "/api/agent-profiles" || path === "/api/projects" || path.endsWith("/discover-projects")) return route.fulfill({ json: [] });
    if (path === "/api/scheduled-agent-jobs") return route.fulfill({ json: { jobs: [] } });
    if (path === "/api/tts/synthesize") return route.fulfill({ json: { jobId: "test", status: "queued", eventsUrl: "/api/tts/jobs/test/events", manifestUrl: "/api/tts/jobs/test" } });
    if (path.startsWith("/api/tts/jobs/test/chunks/") || path === "/api/tts/jobs/test/final") return route.fulfill({ status: 204 });
    const session = sessions.find((item) => path === `/api/sessions/${item.id}`);
    return route.fulfill({ json: session ?? {} });
  });
}

export const chunk = (index: number) => ({ index, status: "completed", url: `/api/tts/jobs/test/chunks/${index}` });
export const completed = (indices: number[]) => ({ status: "completed", chunks: indices.map(chunk), chunks_total: indices.length, chunks_completed: indices.length, final_audio_url: "/api/tts/jobs/test/final" });
export async function emit(page: Page, name: string, payload: object, sourceIndex = -1) {
  await page.evaluate(({ name, payload, sourceIndex }) => {
    window.__tts.sources.at(sourceIndex)!.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(payload) }));
  }, { name, payload, sourceIndex });
}
export async function flushTts(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
export async function expectPlays(page: Page, sources: Array<number | "final">) {
  await flushTts(page);
  expect(await page.evaluate(() => window.__tts.plays)).toEqual(sources.map((source) => source === "final" ? "/api/tts/jobs/test/final" : chunk(source).url));
}
export async function startTts(page: Page) {
  await page.goto("/sessions/tts-a");
  await page.getByRole("button", { name: /Read aloud/ }).click();
  await expect.poll(() => page.evaluate(() => window.__tts.sources.length)).toBe(1);
}
