import { EventEmitter } from "node:events";

export interface TranscriptInvalidationEvent {
  sessionId: string;
  catalogGeneration: number;
  reason: "canonical_mutation";
}

const events = new EventEmitter();
events.setMaxListeners(0);

export function publishTranscriptInvalidation(event: TranscriptInvalidationEvent): void {
  events.emit("invalidated", Object.freeze({ ...event }));
}

export function onTranscriptInvalidation(
  listener: (event: TranscriptInvalidationEvent) => void,
): () => void {
  events.on("invalidated", listener);
  return () => events.off("invalidated", listener);
}
