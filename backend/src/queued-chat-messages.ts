import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Queue cancellation compatibility seam for the exact pinned pi SDK.
 *
 * pi 0.80.6 exposes whole-queue clearing but not removal of one queued item.
 * Wayang captures the exact AgentMessage object added by one browser steering
 * send, then removes only that object if it is still pending. Every shape is
 * checked before mutation so an upstream SDK layout change fails closed rather
 * than clearing or rebuilding unrelated queued work.
 */
export interface QueuedChatMessageCapture {
  readonly session: AgentSession;
  readonly text: string;
  readonly message: object;
}

export interface QueuedChatMessageSnapshot {
  readonly trackedTexts: readonly string[];
  readonly messageRefs: ReadonlySet<unknown>;
}

type QueueInternals = {
  _steeringMessages?: unknown;
  _emitQueueUpdate?: unknown;
  agent?: {
    steeringQueue?: {
      messages?: unknown;
    };
  };
};

function internals(session: AgentSession): {
  trackedTexts: string[];
  messages: unknown[];
  replace: (trackedTexts: string[], messages: unknown[]) => boolean;
  emitQueueUpdate: () => void;
} | undefined {
  try {
    const candidate = session as unknown as QueueInternals;
    const steeringQueue = candidate.agent?.steeringQueue;
    const trackedTexts = candidate._steeringMessages;
    const messages = steeringQueue?.messages;
    const emitQueueUpdate = candidate._emitQueueUpdate;
    const trackedDescriptor = Object.getOwnPropertyDescriptor(candidate, "_steeringMessages");
    const messagesDescriptor = steeringQueue && Object.getOwnPropertyDescriptor(steeringQueue, "messages");
    if (
      !Array.isArray(trackedTexts)
      || !trackedTexts.every((value) => typeof value === "string")
      || !Array.isArray(messages)
      || typeof emitQueueUpdate !== "function"
      || trackedDescriptor?.writable !== true
      || messagesDescriptor?.writable !== true
      || !steeringQueue
    ) return undefined;
    return {
      trackedTexts,
      messages,
      replace(nextTrackedTexts, nextMessages) {
        let replacedTracked = false;
        let replacedMessages = false;
        try {
          candidate._steeringMessages = nextTrackedTexts;
          replacedTracked = true;
          steeringQueue.messages = nextMessages;
          replacedMessages = true;
          return true;
        } catch {
          try { if (replacedTracked) candidate._steeringMessages = trackedTexts; } catch { /* preflight rejects ordinary non-writable layouts */ }
          try { if (replacedMessages) steeringQueue.messages = messages; } catch { /* preflight rejects ordinary non-writable layouts */ }
          return false;
        }
      },
      emitQueueUpdate: emitQueueUpdate.bind(session),
    };
  } catch {
    return undefined;
  }
}

function userMessageText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as { role?: unknown; content?: unknown };
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .map((part) => (
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? String((part as { text: string }).text)
        : ""
    ))
    .join("");
}

export function snapshotQueuedChatMessages(session: AgentSession): QueuedChatMessageSnapshot | undefined {
  const queue = internals(session);
  if (!queue) return undefined;
  return {
    trackedTexts: [...queue.trackedTexts],
    messageRefs: new Set(queue.messages),
  };
}

export function captureQueuedChatMessage(
  session: AgentSession,
  before: QueuedChatMessageSnapshot | undefined,
): QueuedChatMessageCapture | undefined {
  if (!before) return undefined;
  const queue = internals(session);
  if (!queue || queue.trackedTexts.length !== before.trackedTexts.length + 1) return undefined;
  if (!before.trackedTexts.every((text, index) => queue.trackedTexts[index] === text)) return undefined;

  const text = queue.trackedTexts[queue.trackedTexts.length - 1];
  const added = queue.messages.filter((message) => !before.messageRefs.has(message));
  const exact = added.filter((message) => userMessageText(message) === text);
  if (exact.length !== 1 || !exact[0] || typeof exact[0] !== "object") return undefined;
  return { session, text, message: exact[0] as object };
}

export type QueuedChatMessageState = "pending" | "claimed" | "incompatible";

export function queuedChatMessageState(capture: QueuedChatMessageCapture): QueuedChatMessageState {
  const queue = internals(capture.session);
  if (!queue) return "incompatible";
  const hasMessage = queue.messages.includes(capture.message);
  if (!hasMessage) return "claimed";
  return queue.trackedTexts.includes(capture.text) ? "pending" : "incompatible";
}

export function isQueuedChatMessagePending(capture: QueuedChatMessageCapture): boolean {
  return queuedChatMessageState(capture) === "pending";
}

export function cancelCapturedQueuedChatMessage(capture: QueuedChatMessageCapture): boolean {
  const queue = internals(capture.session);
  if (!queue) return false;
  const messageIndex = queue.messages.indexOf(capture.message);
  const trackedIndex = queue.trackedTexts.indexOf(capture.text);
  if (
    messageIndex === -1
    || trackedIndex === -1
    || userMessageText(queue.messages[messageIndex]) !== capture.text
  ) return false;

  const nextMessages = [...queue.messages.slice(0, messageIndex), ...queue.messages.slice(messageIndex + 1)];
  const nextTrackedTexts = [...queue.trackedTexts.slice(0, trackedIndex), ...queue.trackedTexts.slice(trackedIndex + 1)];
  if (!queue.replace(nextTrackedTexts, nextMessages)) return false;
  try {
    queue.emitQueueUpdate();
  } catch {
    // The queue mutation has already completed. A failing UI listener must not
    // turn an exact cancellation into a misleading rejection or queue replay.
  }
  return true;
}
