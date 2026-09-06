import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { synthesizeTts, type TtsChunkManifest, type TtsJobManifest } from "../api/client";
import { initialTtsPlayback, ttsPlaybackReducer, ttsPlaybackStage, type TtsPlaybackAction } from "./playbackController";

/** Request lifetime and browser media effects; queue decisions live in the pure controller. */
export function useTtsPlayback(sessionId: string | null | undefined, messageId: string | null, allowed: boolean) {
  const [state, setState] = useState(initialTtsPlayback);
  const current = useRef(state);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const events = useRef<EventSource | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const detachedAudio = useRef<HTMLAudioElement | null>(null);
  const attempted = useRef("");
  const apply = useCallback((action: TtsPlaybackAction) => {
    current.current = ttsPlaybackReducer(current.current, action);
    setState(current.current);
  }, []);
  const closeEvents = useCallback(() => {
    const source = events.current;
    events.current = null;
    source?.close();
  }, []);
  const attachAudio = useCallback((element: HTMLAudioElement | null) => {
    const previous = audio.current ?? detachedAudio.current;
    audio.current = element;
    if (element) {
      detachedAudio.current = null;
      // A genuine source replacement stops the old element before the new
      // source's play effect. StrictMode's same-element reattachment does not.
      if (previous && previous !== element) previous.pause();
    } else if (previous) {
      detachedAudio.current = previous;
      // React 19 replays callback refs (node -> null -> same node) in development.
      // Null alone is not disposal: pausing here would interrupt the one allowed
      // play command, and its queued pause event could erase playback intent.
      queueMicrotask(() => {
        if (detachedAudio.current !== previous || audio.current === previous) return;
        detachedAudio.current = null;
        previous.pause();
      });
    }
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    current.current = initialTtsPlayback();
    setState(current.current);
    return () => {
      mounted.current = false;
      epoch.current += 1;
      closeEvents();
      const previous = audio.current ?? detachedAudio.current;
      audio.current = null;
      detachedAudio.current = null;
      previous?.pause();
    };
  }, [sessionId, messageId, allowed, closeEvents]);

  useEffect(() => {
    const element = audio.current;
    if (!element || !state.source || state.ended || state.intent !== "play" || state.generation === "error") return;
    const requestEpoch = epoch.current;
    const command = state.playCommand;
    const token = `${requestEpoch}:${command}`;
    if (attempted.current === token) return;
    attempted.current = token;
    const rejected = () => {
      if (!mounted.current || epoch.current !== requestEpoch || audio.current !== element
        || current.current.playCommand !== command || current.current.intent !== "play"
        || current.current.ended || current.current.generation === "error") return;
      apply({ type: "blocked", command });
    };
    try { void element.play().catch(rejected); } catch { rejected(); }
  }, [state.source, state.playCommand, state.ended, state.intent, state.generation, apply]);

  const readAloud = useCallback(async () => {
    if (!mounted.current || !allowed || !sessionId || !messageId) return;
    const requestEpoch = ++epoch.current;
    closeEvents();
    audio.current?.pause();
    apply({ type: "start" });
    const live = () => mounted.current && epoch.current === requestEpoch;
    try {
      const result = await synthesizeTts(sessionId, messageId);
      if (!live()) return;
      if (!("eventsUrl" in result)) {
        apply({ type: "direct", url: result.url });
        return;
      }
      apply({ type: "generation", status: result.status === "queued" ? "queued" : "generating" });
      const source = new EventSource(result.eventsUrl, { withCredentials: true });
      events.current = source;
      const subscribed = () => live() && events.current === source;
      const fail = (error: string) => {
        apply({ type: "error", error });
        closeEvents();
      };
      const manifest = (payload: Partial<TtsJobManifest>) => {
        apply({ type: "manifest", manifest: payload });
        if (payload.status === "failed" || payload.status === "cancelled") fail(`TTS job ${payload.status}`);
        else if (payload.status === "completed") closeEvents();
      };
      const listen = <T extends object>(name: string, handler: (payload: T) => void) => {
        source.addEventListener(name, (event) => {
          if (!subscribed()) return;
          try {
            const payload = JSON.parse((event as MessageEvent).data);
            if (payload && typeof payload === "object") handler(payload);
          } catch {
            // Ignore malformed progress frames, never treat them as playback intent.
          }
        });
      };
      listen("manifest", manifest);
      listen("chunk_split", manifest);
      listen<Partial<TtsJobManifest>>("job_started", (payload) => {
        apply({ type: "generation", status: "generating" });
        manifest(payload);
      });
      listen<TtsChunkManifest>("chunk_completed", (payload) => apply({ type: "chunk", chunk: payload }));
      listen<Partial<TtsJobManifest>>("job_completed", (payload) => manifest({ ...payload, status: "completed" }));
      listen("job_failed", () => fail("TTS job failed"));
      source.onerror = () => { if (subscribed()) fail("Lost connection to TTS progress stream"); };
    } catch (error) {
      if (live()) apply({ type: "error", error: error instanceof Error ? error.message : "TTS failed" });
    }
  }, [allowed, sessionId, messageId, apply, closeEvents]);

  const onEnded = useCallback((element: HTMLAudioElement) => {
    if (audio.current === element && current.current.source) apply({ type: "ended", sourceId: current.current.source.id });
  }, [apply]);
  const onPause = useCallback((element: HTMLAudioElement) => {
    // Browsers emit pause at natural EOF as well as for user pauses.
    if (audio.current === element && element.paused && !element.ended && !current.current.ended) apply({ type: "pause" });
  }, [apply]);
  const onPlay = useCallback((element: HTMLAudioElement) => {
    if (audio.current !== element || element.paused) return;
    if (current.current.ended && current.current.source?.index !== null) {
      // Native controls on an ended segment must resume the queue, not repeat it.
      element.pause();
      apply({ type: "resume" });
    } else apply({ type: "native_play" });
  }, [apply]);
  const pause = useCallback(() => {
    apply({ type: "pause" });
    audio.current?.pause();
  }, [apply]);
  const resume = useCallback(() => apply({ type: "resume" }), [apply]);
  const replay = useCallback(() => apply({ type: "replay" }), [apply]);

  return {
    state, stage: ttsPlaybackStage(state), readAloud, attachAudio,
    onEnded, onPause, onPlay, pause, resume, replay,
    audioKey: `${epoch.current}:${state.source?.id ?? 0}`,
  };
}
