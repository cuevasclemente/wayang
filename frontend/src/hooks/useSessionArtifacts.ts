import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  fetchSessionArtifacts,
  type SessionArtifact,
} from "../api/client";

export interface ArtifactFocusIntent {
  artifactId: string | null;
  revision: number;
  requestKey: string;
}

function selectionKey(sessionId: string): string {
  return `wayang:artifact-selection:${sessionId}`;
}

function loadSelection(sessionId: string): string | null {
  try { return window.localStorage.getItem(selectionKey(sessionId)); }
  catch { return null; }
}

export function useSessionArtifacts(sessionId: string | null, focusIntent: ArtifactFocusIntent | null) {
  const [artifacts, setArtifacts] = useState<SessionArtifact[]>([]);
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestGeneration = useRef(0);
  const activeAbort = useRef<AbortController | null>(null);
  const focusArtifactId = focusIntent?.artifactId ?? null;
  const focusRequestKey = focusIntent?.requestKey ?? null;

  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id);
    if (!sessionId) return;
    try {
      if (id) window.localStorage.setItem(selectionKey(sessionId), id);
      else window.localStorage.removeItem(selectionKey(sessionId));
    } catch { /* unavailable storage */ }
  }, [sessionId]);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setArtifacts([]);
      setRevision(0);
      setSelectedIdState(null);
      setError("");
      return;
    }
    const generation = ++requestGeneration.current;
    activeAbort.current?.abort();
    const controller = new AbortController();
    activeAbort.current = controller;
    setLoading(true);
    try {
      const response = await fetchSessionArtifacts(sessionId, controller.signal);
      if (response?.session_id !== sessionId || !Number.isInteger(response.revision) || !Array.isArray(response.artifacts)) {
        throw new Error("Artifact catalog response is invalid");
      }
      if (generation !== requestGeneration.current) return;
      setArtifacts(response.artifacts);
      setRevision(response.revision);
      setError("");
      setSelectedIdState((current) => {
        const requested = current ?? loadSelection(sessionId);
        if (requested && response.artifacts.some((artifact) => artifact.id === requested)) return requested;
        return response.artifacts.find((artifact) => artifact.available)?.id ?? response.artifacts[0]?.id ?? null;
      });
    } catch (caught) {
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      if (generation === requestGeneration.current) {
        setLoading(false);
        if (activeAbort.current === controller) activeAbort.current = null;
      }
    }
  }, [sessionId]);

  useEffect(() => {
    setArtifacts([]);
    setRevision(0);
    setSelectedIdState(sessionId ? loadSelection(sessionId) : null);
    void refresh();
    return () => {
      requestGeneration.current += 1;
      activeAbort.current?.abort();
      activeAbort.current = null;
    };
  }, [sessionId, refresh]);

  useEffect(() => {
    if (!sessionId || !focusRequestKey) return;
    if (focusArtifactId) setSelectedId(focusArtifactId);
    void refresh();
  }, [sessionId, focusRequestKey, focusArtifactId, refresh, setSelectedId]);

  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? null;
  return { artifacts, revision, selected, selectedId, setSelectedId, loading, error, refresh };
}
