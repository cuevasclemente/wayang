import { useCallback, useEffect, useState, type RefObject } from "react";
import {
  fetchAppState,
  postAppEvent,
  updateAppState,
  type AppStateRecord,
  type RegisteredApp,
} from "../api/client";

interface UseAppBridgeOptions {
  app: RegisteredApp | null;
  sessionId: string | null;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  onEvent?: () => void;
}

interface PiAppMessage {
  source?: string;
  appId?: string;
  type?: string;
  event?: string;
  payload?: unknown;
  summary?: string;
  state?: unknown;
  sendToAgent?: boolean;
}

export function useAppBridge({ app, sessionId, iframeRef, onEvent }: UseAppBridgeOptions) {
  const [stateRecord, setStateRecord] = useState<AppStateRecord | null>(null);
  const [bridgeError, setBridgeError] = useState<string>("");

  const sendStateToFrame = useCallback(
    (state: unknown = stateRecord?.state ?? null) => {
      if (!app) return;
      iframeRef.current?.contentWindow?.postMessage(
        {
          source: "wayang",
          appId: app.id,
          type: "state:update",
          state,
        },
        window.location.origin,
      );
    },
    [app, iframeRef, stateRecord?.state],
  );

  const refreshState = useCallback(async () => {
    if (!app || !sessionId) return;
    try {
      const record = await fetchAppState(app.id, sessionId);
      setStateRecord(record);
      setBridgeError("");
      return record;
    } catch (err: any) {
      setBridgeError(err?.message || String(err));
      return null;
    }
  }, [app, sessionId]);

  const setState = useCallback(
    async (nextState: unknown) => {
      if (!app || !sessionId) return null;
      const record = await updateAppState(app.id, sessionId, nextState);
      setStateRecord(record);
      setBridgeError("");
      iframeRef.current?.contentWindow?.postMessage(
        { source: "wayang", appId: app.id, type: "state:update", state: record.state },
        window.location.origin,
      );
      return record;
    },
    [app, sessionId, iframeRef],
  );

  useEffect(() => {
    refreshState().then((record) => {
      if (record) {
        iframeRef.current?.contentWindow?.postMessage(
          { source: "wayang", appId: app?.id, type: "state:update", state: record.state },
          window.location.origin,
        );
      }
    });
  }, [app?.id, refreshState, iframeRef]);

  useEffect(() => {
    if (!app || !sessionId) return;
    const handler = (event: MessageEvent<PiAppMessage>) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow || event.origin !== window.location.origin) return;
      const message = event.data;
      if (!message || message.source !== "pi-app" || message.appId !== app.id) return;

      if (message.type === "event") {
        postAppEvent(app.id, sessionId, {
          event: message.event || "app.event",
          payload: message.payload,
          summary: message.summary,
          sendToAgent: message.sendToAgent === true,
        })
          .then(() => {
            setBridgeError("");
            onEvent?.();
          })
          .catch((err: any) => setBridgeError(err?.message || String(err)));
        return;
      }

      if (message.type === "state:set") {
        updateAppState(app.id, sessionId, message.state ?? message.payload ?? null)
          .then((record) => {
            setStateRecord(record);
            setBridgeError("");
          })
          .catch((err: any) => setBridgeError(err?.message || String(err)));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [app, sessionId, iframeRef, onEvent]);

  return { stateRecord, bridgeError, refreshState, setState, sendStateToFrame };
}
