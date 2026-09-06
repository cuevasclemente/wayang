import type { TtsChunkManifest, TtsJobManifest } from "../api/client";

export type TtsStage = "idle" | "submitting" | "queued" | "generating" | "playing" | "buffering_next_chunk" | "ready_final" | "paused" | "blocked" | "error";

export interface TtsPlaybackState {
  generation: "idle" | "submitting" | "queued" | "generating" | "completed" | "error";
  chunks: Record<number, string>;
  progress: { completed: number; total: number };
  finalUrl: string | null;
  nextIndex: number;
  source: { id: number; index: number | null; url: string } | null;
  ended: boolean;
  intent: "play" | "pause" | "blocked";
  // A command changes only for a new source or an explicit user resume/replay.
  playCommand: number;
  error: string;
}

export const initialTtsPlayback = (): TtsPlaybackState => ({
  generation: "idle", chunks: {}, progress: { completed: 0, total: 0 }, finalUrl: null,
  nextIndex: 1, source: null, ended: false, intent: "play", playCommand: 0, error: "",
});

export function normalizeTtsPlaybackUrl(url: string | null | undefined): string {
  return typeof url === "string" ? url.replace(/^\/v1\/tts\//, "/api/tts/") : "";
}

export type TtsPlaybackAction =
  | { type: "start" }
  | { type: "generation"; status: "queued" | "generating" }
  | { type: "manifest"; manifest: Partial<TtsJobManifest> }
  | { type: "chunk"; chunk: TtsChunkManifest }
  | { type: "direct"; url: string }
  | { type: "error"; error: string }
  | { type: "ended"; sourceId: number }
  | { type: "blocked"; command: number }
  | { type: "pause" | "resume" | "native_play" | "replay" };

function selectSource(state: TtsPlaybackState, url: string, index: number | null): TtsPlaybackState {
  const playCommand = state.playCommand + 1;
  return { ...state, source: { id: playCommand, url, index }, ended: false, playCommand };
}

function advance(state: TtsPlaybackState): TtsPlaybackState {
  if (state.generation === "idle" || state.generation === "error" || state.intent !== "play") return state;
  if (state.source && (!state.ended || state.source.index === null)) return state;
  const url = state.chunks[state.nextIndex];
  return url ? selectSource(state, url, state.nextIndex) : state;
}

function addChunk(state: TtsPlaybackState, chunk: TtsChunkManifest): TtsPlaybackState {
  if (!Number.isSafeInteger(chunk.index) || chunk.index < 1 || chunk.status !== "completed" || !chunk.url) return state;
  // Completed prefix identities are immutable, including across stale snapshots.
  if (state.chunks[chunk.index]) return state;
  return {
    ...state,
    chunks: { ...state.chunks, [chunk.index]: normalizeTtsPlaybackUrl(chunk.url) },
    progress: { completed: Math.max(state.progress.completed, Object.keys(state.chunks).length + 1), total: Math.max(state.progress.total, chunk.index) },
  };
}

export function ttsPlaybackReducer(state: TtsPlaybackState, action: TtsPlaybackAction): TtsPlaybackState {
  switch (action.type) {
    case "start": return { ...initialTtsPlayback(), generation: "submitting" };
    case "generation":
      return state.generation === "completed" || state.generation === "error" ? state : { ...state, generation: action.status };
    case "chunk": return advance(addChunk(state, action.chunk));
    case "manifest": {
      const manifest = action.manifest;
      let next = state;
      for (const chunk of manifest.chunks ?? []) next = addChunk(next, chunk);
      next = {
        ...next,
        progress: {
          completed: Math.max(next.progress.completed, manifest.chunks_completed ?? 0),
          total: Math.max(next.progress.total, manifest.chunks_total ?? 0),
        },
        finalUrl: normalizeTtsPlaybackUrl(manifest.final_audio_url) || next.finalUrl,
      };
      if (manifest.status === "completed") next = { ...next, generation: "completed" };
      return advance(next);
    }
    case "direct": return selectSource({ ...state, generation: "completed", finalUrl: normalizeTtsPlaybackUrl(action.url) }, normalizeTtsPlaybackUrl(action.url), null);
    case "error": return { ...state, generation: "error", error: action.error };
    case "ended":
      if (!state.source || state.source.id !== action.sourceId || state.ended) return state;
      return advance({ ...state, ended: true, nextIndex: state.source.index === null ? state.nextIndex : state.source.index + 1 });
    case "pause": return { ...state, intent: "pause" };
    case "blocked": return action.command === state.playCommand ? { ...state, intent: "blocked" } : state;
    case "native_play": return { ...state, intent: "play", ended: state.source?.index === null ? false : state.ended };
    case "resume":
      return advance({ ...state, intent: "play", playCommand: state.source && !state.ended ? state.playCommand + 1 : state.playCommand });
    case "replay":
      return state.finalUrl ? selectSource({ ...state, intent: "play" }, state.finalUrl, null) : state;
  }
}

export function ttsPlaybackStage(state: TtsPlaybackState): TtsStage {
  if (state.generation === "idle" || state.generation === "error") return state.generation;
  if (state.intent === "blocked") return "blocked";
  if (state.intent === "pause") return "paused";
  if (state.source && !state.ended) return "playing";
  if (state.generation === "completed" && (state.source?.index === null || state.nextIndex > state.progress.total)) return "ready_final";
  if (state.source || Object.keys(state.chunks).length || state.generation === "completed") return "buffering_next_chunk";
  return state.generation;
}
