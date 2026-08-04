import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  canRetryAuthenticatedTransport,
  chatWsUrl,
  fetchAgentProfiles,
  fetchModels,
  fetchProjects,
  fetchSlashCommands,
  previewSessionAgentSwitch,
  refreshSessionTitle,
  switchSessionAgent,
  synthesizeTts,
  updateSessionGoal,
  updateSessionModel as updateSessionModelRequest,
  type AgentProfileSummary,
  type BashMode,
  type DefaultModelOption,
  type ModelOption,
  type Session,
  type SessionAgentSwitchPreview,
  type SlashArgumentSuggestion,
  type SlashCommandOption,
  type TtsChunkManifest,
  type WorkspaceProject,
} from "../api/client";
import {
  InterviewForm,
  type InterviewQuestion,
  type InterviewAnswer,
  type InterviewSubmissionState,
} from "../components/InterviewForm";
import { BashModeStatus } from "../components/BashModeStatus";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatPanelProps {
  activeSession: Session | null;
  onSessionChange?: () => void;
  onSessionUpdate?: (session: Session) => void;
  /**
   * When set, ChatPanel scrolls the transcript to the message with this pi
   * message id and briefly highlights it. Cleared by calling
   * `onScrollToMessageHandled` after the scroll is performed.
   */
  scrollToMessageId?: string | null;
  onScrollToMessageHandled?: () => void;
}

interface ChatMessage {
  type: string;
  [key: string]: any;
}

interface LocalPendingUserMessage extends ChatMessage {
  type: "user";
  __localPending: true;
  __localId: string;
}

interface ToolActivityUseItem {
  kind: "use";
  name: string;
  input: unknown;
}

interface ToolActivityResultItem {
  kind: "result";
  name?: string;
  content: unknown;
  isError?: boolean;
}

type ToolActivityItem = ToolActivityUseItem | ToolActivityResultItem;

type StreamingContentBlock =
  | { type: "thinking"; thinking: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id?: string; name: string; input: unknown }
  | { type: "tool_result"; id?: string; name?: string; content: unknown; is_error?: boolean };

interface StreamingBlocks {
  content: StreamingContentBlock[];
}

interface QueuedAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  previewUrl?: string;
}

interface QueuedUserMessage {
  id: string;
  content: string;
  attachments?: PendingAttachment[];
}

interface PendingAttachment extends QueuedAttachment {
  data: string;
}

interface TodoItem {
  id: number;
  text: string;
  status: string;
  priority?: string;
  assignee?: string;
  notes?: string;
}

interface TodoState {
  todos: TodoItem[];
  source?: string;
}

type CommandGuardMode = "off" | "audit" | "balanced" | "strict";
type TtsStage = "idle" | "preparing" | "submitting" | "queued" | "generating" | "playing" | "buffering_next_chunk" | "ready_final" | "ready" | "error";

interface CommandGuardState {
  available: boolean;
  mode: CommandGuardMode | "unknown";
  source?: string;
  modelRoute?: string[];
  error?: string;
  pinRequired?: boolean;
  pinConfigured?: boolean;
}

interface RuntimeErrorState {
  message: string;
  timestamp: number;
}

type WsStatus = "connecting" | "connected" | "disconnected";

function isBashMode(value: unknown): value is BashMode {
  return value === "host" || value === "sandboxed" || value === "sandboxed-wren" || value === "unavailable";
}

type InterviewSubmission = {
  answers: InterviewAnswer[];
  submittedAt: number;
  lastSentAt?: number;
  state: InterviewSubmissionState;
  message?: string;
};

interface QueuedInterview {
  requestId: string;
  sessionId: string;
  questions: InterviewQuestion[];
  createdAt: number;
  submission?: InterviewSubmission;
}

interface StoredInterviewSubmission {
  requestId: string;
  sessionId: string;
  questions: InterviewQuestion[];
  answers: InterviewAnswer[];
  submittedAt: number;
}

interface InterviewResponseAck extends ChatMessage {
  type: "interview_response_ack";
  requestId?: unknown;
  sessionId?: unknown;
  status?: unknown;
  errorCode?: unknown;
  error?: unknown;
  message?: unknown;
}

const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 3000, 5000];
const BOTTOM_SCROLL_TOLERANCE_PX = 8;
const MAX_ATTACHMENTS = 40;
// Keep the final inline image payload under provider limits. Larger raster images
// are downscaled/compressed in-browser when possible before they are sent.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Non-image files are saved on the backend and referenced from the prompt.
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const IMAGE_COMPRESSION_MAX_DIMENSION = 2000;
const IMAGE_COMPRESSION_QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5];
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const COMPRESSIBLE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const EXTENSION_MIME_HINTS = new Map([
  [".eml", "message/rfc822"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain"],
]);

const FALLBACK_SLASH_COMMANDS: SlashCommandOption[] = [
  { name: "model", description: "Switch models", argumentHint: "<provider/model>", source: "builtin" },
  { name: "name", description: "Set session display name", argumentHint: "<name>", source: "builtin" },
  { name: "session", description: "Show session info and stats", source: "builtin" },
  { name: "compact", description: "Manually compact context", argumentHint: "[instructions]", source: "builtin" },
  { name: "export", description: "Export session to HTML/JSONL", argumentHint: "[file]", source: "builtin" },
  { name: "reload", description: "Reload extensions, skills, prompts, and context files", source: "builtin" },
];

const CHAT_DRAFT_STORAGE_PREFIX = "wayang:chat-draft:";
const INTERVIEW_SUBMISSION_STORAGE_PREFIX = "wayang:interview-submission:";
const INTERVIEW_ACK_TIMEOUT_MS = 10_000;
const INITIAL_TRANSCRIPT_TAIL_ROWS = 200;
const TRANSCRIPT_HYDRATION_CHUNK_ROWS = 200;

function createSelectionId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `selection-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function chatDraftStorageKey(sessionId: string): string {
  return `${CHAT_DRAFT_STORAGE_PREFIX}${sessionId}`;
}

function interviewDraftStorageKey(requestId: string): string {
  return `wayang-interview-draft:${requestId}`;
}

function interviewSubmissionStorageKey(sessionId: string): string {
  return `${INTERVIEW_SUBMISSION_STORAGE_PREFIX}${sessionId}`;
}

function isInterviewAnswer(value: unknown): value is InterviewAnswer {
  if (!value || typeof value !== "object") return false;
  const answer = value as Partial<InterviewAnswer>;
  return typeof answer.id === "string"
    && typeof answer.value === "string"
    && typeof answer.label === "string"
    && typeof answer.wasCustom === "boolean"
    && (answer.index === undefined || typeof answer.index === "number");
}

function isInterviewQuestion(value: unknown): value is InterviewQuestion {
  if (!value || typeof value !== "object") return false;
  const question = value as Partial<InterviewQuestion>;
  return typeof question.id === "string"
    && typeof question.label === "string"
    && typeof question.prompt === "string"
    && Array.isArray(question.options)
    && typeof question.allowOther === "boolean";
}

function loadStoredInterviewSubmissions(sessionId: string): QueuedInterview[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(interviewSubmissionStorageKey(sessionId)) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): QueuedInterview[] => {
      if (!item || typeof item !== "object") return [];
      const stored = item as Partial<StoredInterviewSubmission>;
      if (
        stored.sessionId !== sessionId
        || typeof stored.requestId !== "string"
        || !Array.isArray(stored.questions)
        || !stored.questions.every(isInterviewQuestion)
        || !Array.isArray(stored.answers)
        || !stored.answers.every(isInterviewAnswer)
        || typeof stored.submittedAt !== "number"
      ) return [];
      return [{
        requestId: stored.requestId,
        sessionId,
        questions: stored.questions,
        createdAt: stored.submittedAt,
        submission: {
          answers: stored.answers,
          submittedAt: stored.submittedAt,
          state: "retry",
          message: "Restored after this page was reloaded; it will be resent when the session is ready.",
        },
      }];
    });
  } catch {
    return [];
  }
}

function persistInterviewSubmission(interview: QueuedInterview): void {
  if (typeof window === "undefined" || !interview.submission) return;
  try {
    const key = interviewSubmissionStorageKey(interview.sessionId);
    const previous = loadStoredInterviewSubmissions(interview.sessionId)
      .map((item): StoredInterviewSubmission => ({
        requestId: item.requestId,
        sessionId: item.sessionId,
        questions: item.questions,
        answers: item.submission!.answers,
        submittedAt: item.submission!.submittedAt,
      }));
    const next: StoredInterviewSubmission = {
      requestId: interview.requestId,
      sessionId: interview.sessionId,
      questions: interview.questions,
      answers: interview.submission.answers,
      submittedAt: interview.submission.submittedAt,
    };
    const index = previous.findIndex((item) => item.requestId === next.requestId);
    if (index === -1) previous.push(next);
    else previous[index] = next;
    window.sessionStorage.setItem(key, JSON.stringify(previous));
  } catch {
    // This cache improves browser resilience only. The durable server record is
    // authoritative once the response acknowledgement arrives.
  }
}

function clearStoredInterviewSubmission(sessionId: string, requestId: string): void {
  if (typeof window === "undefined") return;
  try {
    const remaining = loadStoredInterviewSubmissions(sessionId)
      .filter((item) => item.requestId !== requestId)
      .map((item): StoredInterviewSubmission => ({
        requestId: item.requestId,
        sessionId: item.sessionId,
        questions: item.questions,
        answers: item.submission!.answers,
        submittedAt: item.submission!.submittedAt,
      }));
    const key = interviewSubmissionStorageKey(sessionId);
    if (remaining.length > 0) window.sessionStorage.setItem(key, JSON.stringify(remaining));
    else window.sessionStorage.removeItem(key);
    window.sessionStorage.removeItem(interviewDraftStorageKey(requestId));
  } catch {
    // Ignore unavailable browser storage.
  }
}

function mergeInterviewQueue(current: QueuedInterview[], incoming: QueuedInterview[]): QueuedInterview[] {
  const merged = [...current];
  for (const item of incoming) {
    const index = merged.findIndex((existing) => existing.requestId === item.requestId && existing.sessionId === item.sessionId);
    if (index === -1) {
      merged.push(item);
    } else {
      // A durable request replay refreshes immutable question data but never
      // replaces an unacknowledged answer retained in this browser.
      merged[index] = {
        ...item,
        createdAt: Math.min(merged[index].createdAt, item.createdAt),
        submission: merged[index].submission,
      };
    }
  }
  return merged.sort((a, b) => a.createdAt - b.createdAt);
}

function interviewAckError(msg: InterviewResponseAck): string | undefined {
  const error = msg.error;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  if (typeof msg.message === "string" && msg.message) return msg.message;
  if (typeof msg.errorCode === "string" && msg.errorCode) return `Server rejected this response (${msg.errorCode}).`;
  return undefined;
}

function isAcceptedInterviewAck(msg: InterviewResponseAck): boolean {
  // The durable protocol's acknowledgement boundary is the server's flushed
  // submitted/delivered record. Do not clear local answers for an ambiguous
  // or legacy response that lacks one of these explicit statuses.
  return !interviewAckError(msg) && (msg.status === "submitted" || msg.status === "delivered");
}

function loadChatDraft(sessionId: string | null): string {
  if (!sessionId || typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(chatDraftStorageKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

function persistChatDraft(sessionId: string | null, draft: string) {
  if (!sessionId || typeof window === "undefined") return;
  try {
    const key = chatDraftStorageKey(sessionId);
    if (draft) window.localStorage.setItem(key, draft);
    else window.localStorage.removeItem(key);
  } catch {
    // Ignore unavailable storage (private mode, quota, etc.).
  }
}

function chatWsProfile(event: string, details: Record<string, unknown> = {}) {
  // Detailed per-selection events are development/benchmark opt-in. Production
  // defaults avoid the previous high-volume console stream.
  const viteEnv = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env;
  if (viteEnv?.DEV || viteEnv?.VITE_WAYANG_LATENCY_PROFILE === "1") {
    console.log(`[chat-ws-profile] ${new Date().toISOString()} event=${event}`, details);
  }
}

function getScrollDistanceFromBottom(container: HTMLElement): number {
  return container.scrollHeight - container.scrollTop - container.clientHeight;
}

function isScrolledToBottom(container: HTMLElement): boolean {
  return getScrollDistanceFromBottom(container) <= BOTTOM_SCROLL_TOLERANCE_PX;
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read attachment"));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Failed to read attachment"));
    };
    reader.readAsDataURL(blob);
  });
}

function inferMimeType(file: File): string {
  if (file.type) return file.type;
  const lowerName = file.name.toLowerCase();
  for (const [extension, mimeType] of EXTENSION_MIME_HINTS) {
    if (lowerName.endsWith(extension)) return mimeType;
  }
  return "application/octet-stream";
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Failed to compress image"));
      },
      type,
      quality,
    );
  });
}

function compressedFileName(name: string): string {
  const baseName = (name || "pasted-image").replace(/\.[^.]+$/, "") || "image";
  return `${baseName}-compressed.jpg`;
}

async function compressImageForAttachment(file: File): Promise<{ dataUrl: string; fileName: string; mimeType: string; size: number }> {
  if (file.size <= MAX_IMAGE_BYTES) {
    return {
      dataUrl: await readBlobAsDataUrl(file),
      fileName: file.name || "pasted-image",
      mimeType: file.type || "image/png",
      size: file.size,
    };
  }

  if (!COMPRESSIBLE_IMAGE_MIME_TYPES.has(file.type)) {
    throw new Error(`${file.name || "Image"}: ${formatAttachmentBytes(file.size)} exceeds ${formatAttachmentBytes(MAX_IMAGE_BYTES)}.`);
  }

  const bitmap = await createImageBitmap(file);
  try {
    let width = bitmap.width;
    let height = bitmap.height;
    const initialScale = Math.min(1, IMAGE_COMPRESSION_MAX_DIMENSION / Math.max(width, height));
    width = Math.max(1, Math.round(width * initialScale));
    height = Math.max(1, Math.round(height * initialScale));

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Failed to compress image");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);

      for (const quality of IMAGE_COMPRESSION_QUALITIES) {
        const blob = await canvasToBlob(canvas, "image/jpeg", quality);
        if (blob.size <= MAX_IMAGE_BYTES) {
          return {
            dataUrl: await readBlobAsDataUrl(blob),
            fileName: compressedFileName(file.name),
            mimeType: "image/jpeg",
            size: blob.size,
          };
        }
      }

      width = Math.max(1, Math.round(width * 0.8));
      height = Math.max(1, Math.round(height * 0.8));
    }
  } finally {
    bitmap.close?.();
  }

  throw new Error(`${file.name || "Image"}: could not be compressed below ${formatAttachmentBytes(MAX_IMAGE_BYTES)}.`);
}

async function fileToPendingAttachment(file: File): Promise<PendingAttachment> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const mimeType = inferMimeType(file);

  if (SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    const image = await compressImageForAttachment(file);
    const commaIndex = image.dataUrl.indexOf(",");
    const data = commaIndex === -1 ? image.dataUrl : image.dataUrl.slice(commaIndex + 1);
    return {
      id,
      fileName: image.fileName,
      mimeType: image.mimeType,
      size: image.size,
      kind: "image",
      data,
      previewUrl: image.dataUrl,
    };
  }

  const dataUrl = await readBlobAsDataUrl(file);
  const commaIndex = dataUrl.indexOf(",");
  const data = commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
  return {
    id,
    fileName: file.name || "attachment",
    mimeType,
    size: file.size,
    kind: "file",
    data,
  };
}

function modelSelectValue(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

function sessionModelSelectValue(session: Session | null): string {
  return session?.provider && session.model
    ? modelSelectValue(session.provider, session.model)
    : "";
}

function parseModelSelectValue(value: string): { provider: string; model: string } | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { provider: parsed[0], model: parsed[1] };
    }
  } catch {
    // Ignore invalid select values.
  }
  return null;
}

function findModelOption(models: ModelOption[], value: string): ModelOption | undefined {
  const parsed = parseModelSelectValue(value);
  if (!parsed) return undefined;
  return models.find(
    (model) => model.provider === parsed.provider && model.id === parsed.model,
  );
}

function modelDisplayLabel(
  models: ModelOption[],
  value: string,
  defaultModel: DefaultModelOption | null,
): string {
  const selected = findModelOption(models, value);
  if (selected) return selected.name || selected.id;
  const parsed = parseModelSelectValue(value);
  if (parsed) return `${parsed.provider}/${parsed.model}`;
  if (defaultModel) return `default (${defaultModel.name || defaultModel.id})`;
  return "default";
}

function modelMatchesQuery(model: ModelOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [model.provider, model.id, model.name, `${model.provider}/${model.id}`]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

function fuzzyIncludes(value: string, query: string): boolean {
  const haystack = value.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (haystack.includes(needle)) return true;
  let index = 0;
  for (const char of needle) {
    index = haystack.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}

function mergeSlashCommands(commands: SlashCommandOption[]): SlashCommandOption[] {
  const byName = new Map<string, SlashCommandOption>();
  for (const command of [...FALLBACK_SLASH_COMMANDS, ...commands]) {
    if (!command?.name) continue;
    byName.set(command.name, command);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function modelArgumentSuggestions(models: ModelOption[]): SlashArgumentSuggestion[] {
  return models
    .filter((model) => model.available)
    .map((model) => ({
      value: `${model.provider}/${model.id}`,
      label: model.name || model.id,
      description: model.provider,
    }));
}

function parseSlashAutocomplete(text: string):
  | { mode: "command"; prefix: string }
  | { mode: "argument"; commandName: string; argumentPrefix: string; argumentStart: number }
  | null {
  if (!text.startsWith("/") || text.startsWith("//") || text.includes("\n")) return null;
  const firstSpace = text.indexOf(" ");
  if (firstSpace === -1) return { mode: "command", prefix: text.slice(1) };
  const commandName = text.slice(1, firstSpace);
  if (!commandName) return { mode: "command", prefix: "" };
  const lastSpace = text.lastIndexOf(" ");
  return {
    mode: "argument",
    commandName,
    argumentPrefix: text.slice(lastSpace + 1),
    argumentStart: lastSpace + 1,
  };
}

function parseCommandGuardModeFromText(text: string): CommandGuardMode | null {
  const match = text.match(/Command guard mode(?: set to)?:\s*(off|audit|balanced|strict)/i);
  return match ? (match[1].toLowerCase() as CommandGuardMode) : null;
}

function textFromCustomMessage(message: any): string {
  const content = message?.content;
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("\n")
      : "";
}

function commandGuardStateFromMessages(messages: ChatMessage[]): CommandGuardState | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]?.message;
    if (!message || message.customType !== "command-guard-status") continue;
    const mode = parseCommandGuardModeFromText(textFromCustomMessage(message));
    if (mode) return { available: true, mode, source: "history" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

function renderTextBlock(text: string, key?: number) {
  return (
    <div key={key} className="prose prose-invert prose-sm max-w-none break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border border-neutral-800 rounded my-1">
      <button
        type="button"
        className="w-full text-left px-3 py-1.5 text-xs font-mono text-neutral-400 hover:bg-neutral-800/50 flex items-center gap-1"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-neutral-600">{open ? "▼" : "▶"}</span>
        {title}
      </button>
      {open && (
        <div className="px-3 py-2 border-t border-neutral-800 text-sm">
          {children}
        </div>
      )}
    </div>
  );
}

function renderThinkingBlock(thinking: string, key?: number) {
  return (
    <CollapsibleSection key={key} title="Thinking...">
      <pre className="whitespace-pre-wrap text-neutral-400 font-mono text-xs leading-relaxed">
        {thinking}
      </pre>
    </CollapsibleSection>
  );
}

function formatToolPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolActivityFromBlock(block: any): ToolActivityItem | null {
  if (!block || typeof block !== "object") return null;

  switch (block.type) {
    case "toolCall":
      return {
        kind: "use",
        name: typeof block.name === "string" ? block.name : "unknown",
        input: block.arguments ?? block.input ?? {},
      };
    case "tool_use":
      return {
        kind: "use",
        name: typeof block.name === "string" ? block.name : "unknown",
        input: block.input ?? block.arguments ?? {},
      };
    case "tool_result":
    case "toolResult":
      return {
        kind: "result",
        name: typeof block.name === "string" ? block.name : typeof block.toolName === "string" ? block.toolName : undefined,
        content: block.content ?? block.result ?? block.text ?? "",
        isError: Boolean(block.isError ?? block.is_error),
      };
    default:
      return null;
  }
}

function toolActivityTitle(items: ToolActivityItem[]): string {
  const callCount = items.filter((item) => item.kind === "use").length;
  const resultCount = items.filter((item) => item.kind === "result").length;
  const toolNames = items
    .map((item) => item.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  const uniqueToolNames = [...new Set(toolNames)];
  const visibleToolNames = uniqueToolNames.slice(0, 3).join(", ");
  const overflowCount = uniqueToolNames.length - 3;
  const nameSuffix = uniqueToolNames.length > 0
    ? ` (${visibleToolNames}${overflowCount > 0 ? ` +${overflowCount}` : ""})`
    : "";
  const countParts = [
    callCount > 0 ? `${callCount} tool ${callCount === 1 ? "call" : "calls"}` : null,
    resultCount > 0 ? `${resultCount} ${resultCount === 1 ? "result" : "results"}` : null,
  ].filter(Boolean).join(", ");

  return `Tool activity${countParts ? `: ${countParts}` : ""}${nameSuffix}`;
}

function renderToolActivityGroup(items: ToolActivityItem[], key?: number) {
  return (
    <CollapsibleSection key={key} title={toolActivityTitle(items)}>
      <div className="space-y-3">
        {items.map((item, index) => {
          const isCall = item.kind === "use";
          const title = isCall ? "Tool call" : item.isError ? "Tool error" : "Tool result";
          const payload = isCall ? item.input : item.content;

          return (
            <div key={index} className="rounded border border-neutral-800 bg-neutral-950/60 overflow-hidden">
              <div className="px-2 py-1.5 text-[11px] font-mono text-neutral-400 bg-neutral-900/80 flex items-center gap-2">
                <span className="text-neutral-600">#{index + 1}</span>
                <span className={item.kind === "result" && item.isError ? "text-red-300" : ""}>{title}</span>
                {item.name && <span className="text-neutral-500">{item.name}</span>}
              </div>
              <pre className="whitespace-pre-wrap p-2 text-xs font-mono text-neutral-300 overflow-x-auto max-h-60 overflow-y-auto">
                {formatToolPayload(payload)}
              </pre>
            </div>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}

function renderAssistantContentBlocks(content: any[]): React.ReactNode[] {
  const rendered: React.ReactNode[] = [];
  let toolActivityBuffer: ToolActivityItem[] = [];

  const flushToolActivity = () => {
    if (toolActivityBuffer.length === 0) return;
    rendered.push(renderToolActivityGroup(toolActivityBuffer, rendered.length));
    toolActivityBuffer = [];
  };

  content.forEach((block: any) => {
    const toolActivity = toolActivityFromBlock(block);
    if (toolActivity) {
      toolActivityBuffer.push(toolActivity);
      return;
    }

    flushToolActivity();

    if (typeof block === "string") {
      rendered.push(renderTextBlock(block, rendered.length));
      return;
    }

    switch (block?.type) {
      case "text":
        rendered.push(renderTextBlock(block.text, rendered.length));
        break;
      case "thinking":
        rendered.push(renderThinkingBlock(block.thinking, rendered.length));
        break;
      default:
        break;
    }
  });

  flushToolActivity();
  return rendered;
}

function messageContentAsBlocks(content: unknown): any[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string" && content.length > 0) return [{ type: "text", text: content }];
  return [];
}

function normalizeToolBlockForDisplay(block: any): any | null {
  const activity = toolActivityFromBlock(block);
  if (!activity) return null;
  if (activity.kind === "use") {
    return {
      type: "tool_use",
      id: typeof block?.id === "string" ? block.id : undefined,
      name: activity.name,
      input: activity.input,
    };
  }
  return {
    type: "tool_result",
    id: typeof block?.id === "string" ? block.id : undefined,
    name: activity.name,
    content: activity.content,
    is_error: activity.isError,
  };
}

function toolResultMessageToBlock(message: any): any | null {
  if (!message || typeof message !== "object") return null;
  const result: Record<string, unknown> = { content: message.content ?? [] };
  if (message.details !== undefined) result.details = message.details;
  return {
    type: "tool_result",
    id: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
    name: typeof message.toolName === "string" ? message.toolName : undefined,
    content: result,
    is_error: Boolean(message.isError ?? message.is_error),
  };
}

function assistantErrorMessage(message: any): string | null {
  if (!message || typeof message !== "object") return null;
  if (typeof message.errorMessage === "string" && message.errorMessage.trim()) {
    return message.errorMessage.trim();
  }
  if (message.stopReason === "error") return "Assistant turn ended with an error";
  return null;
}

function agentEndErrorMessage(msg: ChatMessage): string | null {
  if (!Array.isArray(msg.messages)) return null;
  for (const message of [...msg.messages].reverse()) {
    if (message?.role !== "assistant") continue;
    const error = assistantErrorMessage(message);
    if (error) return error;
  }
  return null;
}

function assistantPartTextLength(part: ChatMessage): number {
  let length = 0;
  for (const block of messageContentAsBlocks(part.message?.content)) {
    if (typeof block === "string") {
      length += block.trim().length;
    } else if (block?.type === "text" && typeof block.text === "string") {
      length += block.text.trim().length;
    }
  }
  return length;
}

function buildDisplayAssistantMessage(parts: ChatMessage[]): ChatMessage | null {
  const assistantParts = parts.filter((part) => part.type === "assistant" && part.message);
  const template = assistantParts.length > 0 ? assistantParts[assistantParts.length - 1].message : { role: "assistant" };
  const assistantError = [...assistantParts]
    .reverse()
    .map((part) => assistantErrorMessage(part.message))
    .find((error): error is string => Boolean(error));
  const content: any[] = [];

  for (const part of parts) {
    if (part.type === "assistant") {
      for (const block of messageContentAsBlocks(part.message?.content)) {
        if (typeof block === "string") {
          content.push({ type: "text", text: block });
          continue;
        }
        const toolBlock = normalizeToolBlockForDisplay(block);
        if (toolBlock) {
          content.push(toolBlock);
          continue;
        }
        if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
          content.push({ type: "thinking", thinking: block.thinking });
          continue;
        }
        if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          content.push({ type: "text", text: block.text });
        }
      }
      continue;
    }

    const toolResultBlock = toolResultMessageToBlock(part.message);
    if (toolResultBlock) content.push(toolResultBlock);
  }

  if (content.length === 0) {
    if (assistantError) return { type: "error", error: assistantError };
    return null;
  }
  // Preserve an original assistant message id for TTS lookup. Prefer the most
  // recent assistant fragment that actually contains text; tool/thinking-only
  // fragments are not speakable and cause the backend to return 400.
  const textAssistantPart = [...assistantParts]
    .reverse()
    .find((part) => assistantPartTextLength(part) > 0);
  const assistantId = textAssistantPart?.id ?? (assistantParts.length > 0 ? assistantParts[0].id : undefined);
  return {
    id: assistantId,
    type: "assistant",
    message: {
      ...template,
      role: "assistant",
      content,
    },
  };
}

function normalizeMessagesForDisplay(messages: ChatMessage[]): ChatMessage[] {
  const normalized: ChatMessage[] = [];
  let assistantBuffer: ChatMessage[] = [];

  const flushAssistantBuffer = () => {
    if (assistantBuffer.length === 0) return;
    const message = buildDisplayAssistantMessage(assistantBuffer);
    if (message) normalized.push(message);
    assistantBuffer = [];
  };

  for (const msg of messages) {
    if (msg.type === "assistant" || msg.type === "toolResult" || msg.type === "tool_result") {
      assistantBuffer.push(msg);
      continue;
    }
    flushAssistantBuffer();
    normalized.push(msg);
  }

  flushAssistantBuffer();
  return normalized;
}

// ---------------------------------------------------------------------------
// Message renderers
// ---------------------------------------------------------------------------

function messageTimestampDate(msg: ChatMessage): Date | null {
  const raw = msg.message?.timestamp ?? msg.timestamp;
  if (raw == null) return null;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Pi message timestamps are normally milliseconds, but accept Unix seconds
    // so older/imported transcript entries still display sensibly.
    const millis = raw < 10_000_000_000 ? raw * 1000 : raw;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof raw === "string" && raw.trim()) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function MessageTimestamp({ msg, className = "" }: { msg: ChatMessage; className?: string }) {
  const date = messageTimestampDate(msg);
  if (!date) return null;

  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })}
      className={`shrink-0 text-[10px] normal-case tracking-normal text-neutral-600 font-normal ${className}`}
    >
      {date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
    </time>
  );
}

function normalizeTtsPlaybackUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (url.startsWith("/v1/tts/")) return url.replace(/^\/v1\/tts/, "/api/tts");
  return url;
}

function AssistantMessage({
  msg,
  sessionId,
  ttsAllowed = true,
}: {
  msg: ChatMessage;
  sessionId?: string | null;
  ttsAllowed?: boolean;
}) {
  const message = msg.message;
  const messageId = typeof msg.id === "string" ? msg.id : null;
  const [ttsStage, setTtsStage] = useState<TtsStage>("idle");
  const [ttsChunks, setTtsChunks] = useState<TtsChunkManifest[]>([]);
  const [ttsProgress, setTtsProgress] = useState({ completed: 0, total: 0 });
  const [ttsFinalUrl, setTtsFinalUrl] = useState<string | null>(null);
  const [currentChunkIndex, setCurrentChunkIndex] = useState<number | null>(null);
  const [ttsError, setTtsError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const ttsLoading = ["preparing", "submitting", "queued", "generating"].includes(ttsStage);

  const sortedChunks = useMemo(
    () => [...ttsChunks].filter((chunk) => chunk.status === "completed" && chunk.url).sort((a, b) => a.index - b.index),
    [ttsChunks],
  );
  const currentChunk = sortedChunks.find((chunk) => chunk.index === currentChunkIndex) ?? null;
  const currentAudioUrl = normalizeTtsPlaybackUrl(
    currentChunk?.url ?? (ttsFinalUrl && currentChunkIndex == null ? ttsFinalUrl : null),
  );

  const upsertChunk = useCallback((chunk: TtsChunkManifest) => {
    setTtsChunks((prev) => {
      const next = new Map(prev.map((item) => [item.index, item]));
      next.set(chunk.index, { ...next.get(chunk.index), ...chunk });
      return [...next.values()].sort((a, b) => a.index - b.index);
    });
  }, []);

  const closeTtsEvents = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  useEffect(() => closeTtsEvents, [closeTtsEvents]);

  useEffect(() => {
    if (ttsAllowed) return;
    closeTtsEvents();
    audioRef.current?.pause();
    setTtsStage("idle");
    setTtsChunks([]);
    setTtsFinalUrl(null);
    setCurrentChunkIndex(null);
    setTtsError("");
  }, [closeTtsEvents, ttsAllowed]);

  useEffect(() => {
    if (!currentAudioUrl || !["playing", "buffering_next_chunk", "ready"].includes(ttsStage)) return;
    audioRef.current?.play().catch(() => {
      // Browser autoplay policies may require a second user gesture; controls remain visible.
    });
  }, [currentAudioUrl, ttsStage]);

  const handleAudioEnded = useCallback(() => {
    const currentPosition = currentChunkIndex ?? 0;
    const nextChunk = sortedChunks.find((chunk) => chunk.index > currentPosition);
    if (nextChunk) {
      setCurrentChunkIndex(nextChunk.index);
      setTtsStage("playing");
      return;
    }
    if (ttsFinalUrl) {
      // We just finished the last streamed chunk. Do not swap the player over
      // to the concatenated final audio automatically, because that makes the
      // message appear to repeat from the beginning after successful chunk
      // playback. Keep the final URL for seeking/replay metadata instead.
      setTtsStage("ready_final");
      return;
    }
    setTtsStage("buffering_next_chunk");
  }, [currentChunkIndex, sortedChunks, ttsFinalUrl]);

  const subscribeToTtsJob = useCallback((eventsUrl: string) => {
    closeTtsEvents();
    const source = new EventSource(eventsUrl, { withCredentials: true });
    eventSourceRef.current = source;

    const handleManifest = (payload: any) => {
      if (typeof payload?.chunks_completed === "number" || typeof payload?.chunks_total === "number") {
        setTtsProgress({ completed: payload.chunks_completed ?? 0, total: payload.chunks_total ?? 0 });
      }
      if (Array.isArray(payload?.chunks)) {
        setTtsChunks(
          payload.chunks
            .filter((chunk: any) => typeof chunk?.index === "number")
            .map((chunk: any) => ({ ...chunk, url: normalizeTtsPlaybackUrl(chunk.url) })),
        );
      }
      if (payload?.final_audio_url) setTtsFinalUrl(normalizeTtsPlaybackUrl(payload.final_audio_url));
      if (payload?.status === "failed" || payload?.status === "cancelled") {
        setTtsError(payload?.errors?.length ? JSON.stringify(payload.errors.slice(-1)[0]) : `TTS job ${payload.status}`);
        setTtsStage("error");
        closeTtsEvents();
      }
    };

    const parseEvent = (event: MessageEvent) => {
      try {
        return JSON.parse(event.data);
      } catch {
        return null;
      }
    };

    source.addEventListener("manifest", (event) => handleManifest(parseEvent(event as MessageEvent)));
    source.addEventListener("job_started", (event) => {
      handleManifest(parseEvent(event as MessageEvent));
      setTtsStage("generating");
    });
    source.addEventListener("chunk_split", (event) => handleManifest(parseEvent(event as MessageEvent)));
    source.addEventListener("chunk_completed", (event) => {
      const chunk = parseEvent(event as MessageEvent);
      if (!chunk || typeof chunk.index !== "number") return;
      const normalizedChunk = { ...chunk, url: normalizeTtsPlaybackUrl(chunk.url) } as TtsChunkManifest;
      upsertChunk(normalizedChunk);
      setTtsProgress((prev) => ({ completed: Math.max(prev.completed, chunk.index), total: Math.max(prev.total, chunk.index) }));
      setCurrentChunkIndex((current) => {
        if (current == null) {
          setTtsStage("playing");
          return normalizedChunk.index;
        }
        if (ttsStage === "buffering_next_chunk" && normalizedChunk.index > current) {
          setTtsStage("playing");
          return normalizedChunk.index;
        }
        return current;
      });
    });
    source.addEventListener("job_completed", (event) => {
      const manifest = parseEvent(event as MessageEvent);
      handleManifest(manifest);
      if (manifest?.final_audio_url) setTtsFinalUrl(normalizeTtsPlaybackUrl(manifest.final_audio_url));
      setTtsStage((stage) => (stage === "playing" ? stage : "ready_final"));
      closeTtsEvents();
    });
    source.addEventListener("job_failed", (event) => {
      const manifest = parseEvent(event as MessageEvent);
      handleManifest(manifest);
      setTtsError(manifest?.errors?.length ? JSON.stringify(manifest.errors.slice(-1)[0]) : "TTS job failed");
      setTtsStage("error");
      closeTtsEvents();
    });
    source.onerror = () => {
      setTtsError("Lost connection to TTS progress stream");
      setTtsStage("error");
      closeTtsEvents();
    };
  }, [closeTtsEvents, ttsStage, upsertChunk]);

  const handleReadAloud = useCallback(async () => {
    if (!ttsAllowed || !sessionId || !messageId || ttsLoading) return;
    closeTtsEvents();
    setTtsChunks([]);
    setTtsProgress({ completed: 0, total: 0 });
    setTtsFinalUrl(null);
    setCurrentChunkIndex(null);
    setTtsError("");
    setTtsStage("preparing");
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      setTtsStage("submitting");
      const result = await synthesizeTts(sessionId, messageId);
      if ("eventsUrl" in result) {
        setTtsStage(result.status === "queued" ? "queued" : "generating");
        subscribeToTtsJob(result.eventsUrl);
      } else {
        setTtsFinalUrl(result.url);
        setTtsStage("ready");
      }
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : "TTS failed");
      setTtsStage("error");
    }
  }, [closeTtsEvents, sessionId, messageId, subscribeToTtsJob, ttsAllowed, ttsLoading]);
  if (!message) return null;

  const content = Array.isArray(message.content) ? message.content : [];
  const model = message.model;
  const stopReason = message.stopReason;

  return (
    <div data-testid="chat-message" data-role="assistant" className="px-4 py-3 bg-neutral-900 rounded-lg">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
          Assistant
          {model && (
            <span className="ml-2 text-neutral-600 normal-case font-normal">
              {model}
            </span>
          )}
          {stopReason && stopReason !== "end_turn" && (
            <span className="ml-2 text-neutral-600 normal-case font-normal">
              [{stopReason}]
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {ttsAllowed && sessionId && messageId && ttsStage === "idle" && (
            <button
              type="button"
              onClick={handleReadAloud}
              disabled={ttsLoading}
              title="Read this message aloud"
              className="rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              🔊 Read aloud
            </button>
          )}
          <MessageTimestamp msg={msg} />
        </div>
      </div>
      <div className="space-y-2">
        {renderAssistantContentBlocks(content)}
      </div>
      {ttsStage !== "idle" && (
        <div className="mt-3 rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
              Read aloud
            </div>
            {ttsLoading && <div className="text-[10px] text-blue-300">Working…</div>}
            {ttsStage === "playing" && <div className="text-[10px] text-green-300">Playing chunk {currentChunkIndex}</div>}
            {ttsStage === "buffering_next_chunk" && <div className="text-[10px] text-blue-300">Buffering next chunk…</div>}
            {(ttsStage === "ready" || ttsStage === "ready_final") && <div className="text-[10px] text-green-300">Audio ready</div>}
            {ttsStage === "error" && <div className="text-[10px] text-amber-300">Needs attention</div>}
          </div>
          <div className="mb-3 grid gap-1 text-xs text-neutral-400 sm:grid-cols-5">
            {[
              ["preparing", "Creating request"],
              ["submitting", "Submitting text"],
              ["queued", "Queued"],
              ["generating", "Generating chunks"],
              ["playing", "Playing"],
            ].map(([stage, label]) => {
              const stageOrder: TtsStage[] = ["preparing", "submitting", "queued", "generating", "playing", "ready_final"];
              const effectiveStage: TtsStage = ttsStage === "ready" ? "ready_final" : ttsStage === "buffering_next_chunk" ? "playing" : ttsStage === "error" ? "generating" : ttsStage;
              const currentIndex = stageOrder.indexOf(effectiveStage);
              const stageIndex = stageOrder.indexOf(stage as TtsStage);
              const complete = currentIndex > stageIndex || ttsStage === "ready" || ttsStage === "ready_final";
              const active = ttsStage === stage;
              return (
                <div
                  key={stage}
                  className={`rounded border px-2 py-1 ${
                    active
                      ? "border-blue-700 bg-blue-950/40 text-blue-100"
                      : complete
                        ? "border-green-800/60 bg-green-950/20 text-green-200"
                        : "border-neutral-800 bg-neutral-900/40 text-neutral-500"
                  }`}
                >
                  <span className="mr-1">{complete ? "✓" : active ? "●" : "○"}</span>
                  {label}
                </div>
              );
            })}
          </div>
          {ttsProgress.total > 0 && (
            <div className="mb-2 text-[11px] text-neutral-400">
              Generated {ttsProgress.completed}/{ttsProgress.total} chunks
              {ttsFinalUrl ? " · full audio ready" : ""}
            </div>
          )}
          {currentAudioUrl && (
            <audio
              ref={audioRef}
              controls
              src={currentAudioUrl}
              onEnded={handleAudioEnded}
              className="w-full max-w-xl h-9"
              preload="auto"
            />
          )}
          {ttsError && (
            <div className="text-[11px] text-amber-300">
              {ttsError}
              <button
                type="button"
                onClick={handleReadAloud}
                className="ml-2 underline decoration-dotted hover:text-amber-100"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function getUserMessageText(message: any): string {
  return typeof message?.content === "string"
    ? message.content
    : Array.isArray(message?.content)
      ? message.content
          .map((b: any) =>
            typeof b === "string" ? b : b.text ?? ""
          )
          .join("")
      : "";
}

function getUserMessageImages(message: any): Array<{ src: string; mimeType: string }> {
  if (!Array.isArray(message?.content)) return [];
  return message.content
    .filter((block: any) => block?.type === "image" && typeof block.data === "string")
    .map((block: any) => {
      const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image/png";
      return { mimeType, src: `data:${mimeType};base64,${block.data}` };
    });
}

function isLocalPendingUserMessage(msg: ChatMessage): msg is LocalPendingUserMessage {
  return msg.type === "user" && msg.__localPending === true;
}

function userContentMatches(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (left === right) return true;
  if (left !== "" && right.startsWith(left)) return true;
  if (right !== "" && left.startsWith(right)) return true;
  // Attachments are persisted with backend-added <file> notes, while the
  // optimistic local echo only knows the user's typed text and attachment blocks.
  if ((left === "" || right === "" || left === "[File attachment]" || right === "[File attachment]")
    && (left.includes("<file name=") || right.includes("<file name="))) return true;
  return false;
}

function userMessagesMatch(a: ChatMessage, b: ChatMessage): boolean {
  if (a.type !== "user" || b.type !== "user") return false;
  const aText = getUserMessageText(a.message);
  const bText = getUserMessageText(b.message);
  const aHasImages = getUserMessageImages(a.message).length > 0;
  const bHasImages = getUserMessageImages(b.message).length > 0 || bText.includes("<file name=");
  if (userContentMatches(aText, bText)) return true;
  return aHasImages && bHasImages && (aText === "" || bText === "" || userContentMatches(aText, bText));
}

function appendStreamingDelta(
  blocks: StreamingBlocks,
  type: "thinking" | "text",
  delta: string,
): StreamingBlocks {
  if (!delta) return blocks;
  const last = blocks.content[blocks.content.length - 1];
  if (type === "thinking" && last?.type === "thinking") {
    return {
      content: [
        ...blocks.content.slice(0, -1),
        { ...last, thinking: last.thinking + delta },
      ],
    };
  }
  if (type === "text" && last?.type === "text") {
    return {
      content: [
        ...blocks.content.slice(0, -1),
        { ...last, text: last.text + delta },
      ],
    };
  }
  return {
    content: [
      ...blocks.content,
      type === "thinking" ? { type, thinking: delta } : { type, text: delta },
    ],
  };
}

function appendStreamingBlock(
  blocks: StreamingBlocks,
  block: StreamingContentBlock,
): StreamingBlocks {
  return { content: [...blocks.content, block] };
}

function streamingBlocksToAssistantMessage(blocks: StreamingBlocks): ChatMessage | null {
  if (blocks.content.length === 0) return null;
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [...blocks.content],
    },
  };
}

function makeLocalPendingUserMessage(
  id: string,
  content: string,
  attachments: PendingAttachment[],
): LocalPendingUserMessage {
  const blocks: any[] = [];
  if (content) blocks.push({ type: "text", text: content });
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      blocks.push({ type: "image", mimeType: attachment.mimeType, data: attachment.data });
    }
  }
  if (!content && attachments.some((attachment) => attachment.kind !== "image")) {
    blocks.push({ type: "text", text: "[File attachment]" });
  }
  return {
    type: "user",
    __localPending: true,
    __localId: id,
    message: {
      role: "user",
      content: blocks.length > 0 ? blocks : content,
      timestamp: Date.now(),
    },
  };
}

function upsertUserMessage(messages: ChatMessage[], userMessage: ChatMessage): ChatMessage[] {
  const pendingIndex = messages.findIndex((existing) => isLocalPendingUserMessage(existing) && userMessagesMatch(existing, userMessage));
  if (pendingIndex !== -1) {
    return messages.map((existing, index) => index === pendingIndex ? userMessage : existing);
  }
  if (messages.some((existing) => !isLocalPendingUserMessage(existing) && userMessagesMatch(existing, userMessage))) {
    return messages;
  }
  return [...messages, userMessage];
}

function mergeHistoryWithLocalPending(historyMessages: ChatMessage[], currentMessages: ChatMessage[]): ChatMessage[] {
  const localPending = currentMessages.filter(
    (message) => isLocalPendingUserMessage(message) && !historyMessages.some((historyMessage) => userMessagesMatch(message, historyMessage)),
  );
  return localPending.length > 0 ? [...historyMessages, ...localPending] : historyMessages;
}

function UserMessage({
  msg,
  canResend = false,
  isResending = false,
  onResend,
}: {
  msg: ChatMessage;
  canResend?: boolean;
  isResending?: boolean;
  onResend?: (msg: ChatMessage) => void;
}) {
  const message = msg.message;
  if (!message) return null;

  const text = getUserMessageText(message);
  const images = getUserMessageImages(message);
  const canShowResend = typeof msg.id === "string" && !isLocalPendingUserMessage(msg) && Boolean(onResend);

  return (
    <div data-testid="chat-message" data-role="user" className="group px-4 py-3 bg-blue-950/50 rounded-lg">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="text-[10px] uppercase tracking-wider text-blue-400/70 font-semibold">
            You
          </div>
          <MessageTimestamp msg={msg} className="text-blue-400/40" />
        </div>
        {canShowResend && (
          <button
            type="button"
            data-testid="chat-resend-button"
            disabled={!canResend || isResending}
            onClick={(event) => {
              event.stopPropagation();
              onResend?.(msg);
            }}
            title={canResend ? "Rewind to this message and send it again" : "Resend is available when the agent is idle and connected"}
            className="rounded border border-blue-800/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-200 opacity-0 transition group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 hover:bg-blue-900/50"
          >
            {isResending ? "Resending…" : "Resend"}
          </button>
        )}
      </div>
      {text && <div className="text-sm text-neutral-200 whitespace-pre-wrap">{text}</div>}
      {images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {images.map((image, index) => (
            <a
              key={`${image.mimeType}-${index}`}
              href={image.src}
              target="_blank"
              rel="noreferrer"
              className="block overflow-hidden rounded border border-blue-800/50 bg-neutral-950/60"
              title={image.mimeType}
            >
              <img
                src={image.src}
                alt={`Attached image ${index + 1}`}
                className="h-28 w-28 object-cover"
              />
            </a>
          ))}
        </div>
      )}
      {!text && images.length === 0 && <div className="text-sm text-neutral-400">(empty)</div>}
    </div>
  );
}

function QueuedUserMessages({ messages }: { messages: QueuedUserMessage[] }) {
  if (messages.length === 0) return null;

  return (
    <div className="border-t border-neutral-800 bg-neutral-950/95 px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-amber-300">
        <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
        Queued for the next turn
      </div>
      <div className="space-y-1">
        {messages.map((message, index) => (
          <div
            key={message.id}
            data-testid="chat-queued-user-message"
            data-role="user"
            className="rounded border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs text-neutral-300"
          >
            <div>
              <span className="mr-2 font-mono text-amber-400/80">#{index + 1}</span>
              <span className="whitespace-pre-wrap break-words">
                {message.content || (message.attachments?.length ? "[File attachment]" : "")}
              </span>
            </div>
            {message.attachments && message.attachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {message.attachments.map((attachment) => attachment.kind === "image" && attachment.previewUrl ? (
                  <img
                    key={attachment.id}
                    src={attachment.previewUrl}
                    alt={attachment.fileName}
                    title={`${attachment.fileName} (${formatAttachmentBytes(attachment.size)})`}
                    className="h-12 w-12 rounded border border-amber-800/50 object-cover"
                  />
                ) : (
                  <div
                    key={attachment.id}
                    title={`${attachment.fileName} (${formatAttachmentBytes(attachment.size)})`}
                    className="max-w-[14rem] truncate rounded border border-amber-800/50 bg-neutral-950/70 px-2 py-1 text-[11px] text-neutral-300"
                  >
                    📄 {attachment.fileName}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-neutral-500">
        These messages stay out of the transcript until pi accepts them, keeping chat order stable during long tool runs.
      </p>
    </div>
  );
}

function ToolResultMessage({ msg }: { msg: ChatMessage }) {
  const message = msg.message;
  if (!message) return null;

  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((b: any) =>
              typeof b === "string" ? b : b.text ?? JSON.stringify(b)
            )
            .join("\n")
        : JSON.stringify(content);

  return (
    <div data-testid="chat-message" data-role="custom" className="px-4 py-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
          Tool Result
        </div>
        <MessageTimestamp msg={msg} />
      </div>
      <pre className="text-xs text-neutral-400 font-mono whitespace-pre-wrap bg-neutral-900 rounded p-2 max-h-40 overflow-y-auto">
        {text}
      </pre>
    </div>
  );
}

function ErrorMessage({ msg }: { msg: ChatMessage }) {
  return (
    <div data-testid="chat-message" data-role="error" className="px-4 py-2 text-sm text-red-400 bg-red-950/30 rounded-lg">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-red-300/80">Error</span>
        <MessageTimestamp msg={msg} className="text-red-300/50" />
      </div>
      {msg.error ?? "Unknown error"}
    </div>
  );
}

function SystemMessage({ msg }: { msg: ChatMessage }) {
  const text = msg.data ?? msg.subtype ?? "";

  return (
    <div data-testid="chat-message" data-role="system" className="px-4 py-1 text-xs text-neutral-500 italic font-mono">
      [system] <MessageTimestamp msg={msg} className="mx-1 align-baseline text-neutral-600" /> {text}
    </div>
  );
}

function CustomMessage({ msg }: { msg: ChatMessage }) {
  const message = msg.message ?? msg;
  if (message.display === false) return null;

  const customType = message.customType || "custom";
  const isInterviewSubmission = customType === "wayang-interview-submission";
  const content = message.content;

  if (customType === "wayang-agent-change") {
    const details = message.details && typeof message.details === "object"
      ? message.details as { provider?: unknown; model?: unknown }
      : null;
    const provider = typeof details?.provider === "string" ? details.provider : null;
    const model = typeof details?.model === "string" ? details.model : null;
    return (
      <div
        data-testid="chat-message"
        data-role="custom"
        data-custom-type="wayang-agent-change"
        className="flex items-center gap-3 px-4 py-2 text-[11px] text-neutral-500"
      >
        <span className="h-px flex-1 bg-neutral-800" aria-hidden="true" />
        <span className="shrink-0 font-medium text-neutral-400">
          Agent changed{provider && model ? ` · ${provider}/${model}` : ""}
        </span>
        <MessageTimestamp msg={msg} className="shrink-0 text-neutral-600" />
        <span className="h-px flex-1 bg-neutral-800" aria-hidden="true" />
      </div>
    );
  }
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((b: any) => (typeof b === "string" ? b : b.text ?? "")).join("\n")
        : content != null
          ? JSON.stringify(content)
          : "";

  return (
    <div data-testid="chat-message" data-role="custom" className="px-4 py-2 border border-neutral-800 bg-neutral-900/70 rounded-lg">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className={`text-[10px] uppercase tracking-wider font-semibold ${isInterviewSubmission ? "text-blue-300" : "text-neutral-500"}`}>
          {isInterviewSubmission ? "Interview submitted" : customType}
        </div>
        <MessageTimestamp msg={msg} />
      </div>
      <div className="text-sm text-neutral-300 whitespace-pre-wrap">{text}</div>
    </div>
  );
}

function GoalUpdateMessage({ msg }: { msg: ChatMessage }) {
  const { goal, status } = msg;
  const statusColors: Record<string, string> = {
    pending: "text-yellow-400",
    in_progress: "text-blue-400",
    completed: "text-green-400",
    failed: "text-red-400",
  };

  return (
    <div data-testid="chat-message" data-role="custom" className="px-4 py-2 border border-blue-900/50 bg-blue-950/20 rounded-lg">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className={`text-[10px] uppercase tracking-wider font-semibold ${statusColors[status] ?? "text-blue-400"}`}>
          Goal {status}
        </div>
        <MessageTimestamp msg={msg} className="text-blue-400/40" />
      </div>
      <div className="text-sm text-neutral-300">{goal}</div>
    </div>
  );
}

function TodoStatusPanel({
  todos,
  source,
  open,
  onToggle,
}: {
  todos: TodoItem[];
  source?: string;
  open: boolean;
  onToggle: () => void;
}) {
  const activeTodos = todos.filter((todo) => todo.status !== "done" && todo.status !== "cancelled");
  const completedCount = todos.length - activeTodos.length;
  if (todos.length === 0) return null;

  const statusColor = (status: string) => {
    switch (status) {
      case "in_progress":
        return "text-blue-300";
      case "blocked":
        return "text-red-300";
      case "done":
        return "text-green-400 line-through";
      case "cancelled":
        return "text-neutral-600 line-through";
      default:
        return "text-yellow-300";
    }
  };

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex max-w-full items-center gap-1 rounded border border-yellow-800/60 bg-yellow-950/20 px-2 py-0.5 text-[11px] text-yellow-200 hover:bg-yellow-950/40"
        title="Show session TODO checklist"
      >
        <span>TODOs</span>
        <span className="rounded bg-yellow-900/60 px-1 font-mono text-[10px]">
          {activeTodos.length} active
        </span>
        {completedCount > 0 && (
          <span className="text-[10px] text-neutral-500">{completedCount} done</span>
        )}
        <span className="text-yellow-500">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="absolute left-0 top-7 z-40 w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-neutral-700 bg-neutral-950 p-3 shadow-2xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-yellow-300">
              Session TODOs
            </div>
            {source && source !== "none" && (
              <div className="text-[10px] text-neutral-600">source: {source}</div>
            )}
          </div>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {todos.map((todo) => (
              <div key={todo.id} className="rounded border border-neutral-800 bg-neutral-900/70 p-2">
                <div className="flex items-start gap-2">
                  <span className={`mt-0.5 text-[10px] font-mono uppercase ${statusColor(todo.status)}`}>
                    {todo.status}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-neutral-200 break-words">{todo.text}</div>
                    {(todo.assignee || todo.priority || todo.notes) && (
                      <div className="mt-1 text-[10px] text-neutral-500">
                        {todo.assignee && <span>@{todo.assignee}</span>}
                        {todo.priority && <span className="ml-2">{todo.priority}</span>}
                        {todo.notes && <span className="ml-2">{todo.notes}</span>}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-neutral-500">
            Agents can update this list with the todo tool; the panel refreshes after turns.
          </p>
        </div>
      )}
    </div>
  );
}

function SudoPrompt({
  prompt,
  kind,
  command,
  executable,
  argv,
  cwd,
  timeoutMs,
  origin,
  onSubmit,
  onApprove,
  onCancel,
}: {
  prompt: string;
  kind: "password" | "approval";
  command?: string;
  executable?: string;
  argv?: string[];
  cwd?: string;
  timeoutMs?: number;
  origin?: { mode: "parent" | "long-lived" | "one-shot"; lineage: string[] };
  onSubmit: (password: string) => void;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const approvalOnly = kind === "approval";

  return (
    <form
      className="border border-amber-900/60 rounded-lg overflow-hidden bg-neutral-900"
      onSubmit={(e) => {
        e.preventDefault();
        if (approvalOnly) {
          onApprove();
        } else {
          onSubmit(password);
          setPassword("");
        }
      }}
    >
      <div className="px-4 py-3 border-b border-neutral-800">
        <div className="text-[10px] uppercase tracking-wider text-amber-400 mb-1 font-semibold">
          {approvalOnly ? "Sudo approval" : "Sudo authentication"}
        </div>
        <p className="text-sm text-neutral-200">{prompt}</p>
        {executable ? (
          <div className="mt-3 space-y-2 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs">
            <div>
              <span className="text-neutral-500">Executable:</span>{" "}
              <code className="break-all text-amber-100">{executable}</code>
            </div>
            <div>
              <div className="text-neutral-500">Arguments (exact argv):</div>
              <ol className="mt-1 max-h-40 list-decimal overflow-auto pl-6 text-amber-100">
                {(argv ?? []).map((arg, index) => (
                  <li key={index} className="whitespace-pre-wrap break-all font-mono">{arg}</li>
                ))}
              </ol>
            </div>
            {cwd && <div><span className="text-neutral-500">Working directory:</span> <code className="break-all">{cwd}</code></div>}
            {timeoutMs !== undefined && <div><span className="text-neutral-500">Timeout:</span> {timeoutMs} ms</div>}
            {origin && <div><span className="text-neutral-500">Origin:</span> {origin.mode}{origin.lineage.length ? ` · ${origin.lineage.join(" → ")}` : ""}</div>}
          </div>
        ) : command ? (
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1 font-semibold">
              Legacy command requesting sudo
            </div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-amber-100">
              {command}
            </pre>
          </div>
        ) : null}
        <p className="text-xs text-neutral-500 mt-2">
          {approvalOnly
            ? "Approve or deny this exact executable and argument vector. Approval is required for every privileged request."
            : "This request was already approved. The password is sent only to the local backend bridge, cached in the parent process for at most 5 minutes, and never sent to a subagent or stored in chat history."}
        </p>
      </div>
      <div className="p-4 flex items-center gap-2">
        {!approvalOnly && (
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setPassword("");
                onCancel();
              }
            }}
            className="flex-1 bg-neutral-800 text-sm text-neutral-100 rounded px-3 py-2 border border-neutral-700 focus:outline-none focus:border-amber-500"
            placeholder="Sudo password"
            autoComplete="off"
            autoFocus
          />
        )}
        <button
          type="submit"
          className="px-3 py-2 text-xs font-semibold rounded bg-amber-700 hover:bg-amber-600 text-white"
          autoFocus={approvalOnly}
        >
          {approvalOnly ? "Approve" : "Submit"}
        </button>
        <button
          type="button"
          onClick={() => {
            setPassword("");
            onCancel();
          }}
          className="px-3 py-2 text-xs rounded text-neutral-400 hover:text-red-300 hover:bg-neutral-800"
        >
          {approvalOnly ? "Deny" : "Cancel"}
        </button>
      </div>
    </form>
  );
}

function CommandGuardPinPrompt({
  prompt,
  command,
  reason,
  onSubmit,
  onCancel,
}: {
  prompt: string;
  command?: string;
  reason?: string;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState("");

  return (
    <form
      className="border border-red-900/60 rounded-lg overflow-hidden bg-neutral-900"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(pin);
        setPin("");
      }}
    >
      <div className="px-4 py-3 border-b border-neutral-800">
        <div className="text-[10px] uppercase tracking-wider text-red-400 mb-1 font-semibold">
          Command guard identity check
        </div>
        <p className="text-sm text-neutral-200">{prompt}</p>
        {reason && <p className="mt-2 text-xs text-neutral-400">{reason}</p>}
        {command && (
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1 font-semibold">
              Command under review
            </div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-red-100">
              {command}
            </pre>
          </div>
        )}
        <p className="text-xs text-neutral-500 mt-2">
          Enter the 8-digit identity PIN. This is separate from sudo and is not stored in chat history.
        </p>
      </div>
      <div className="p-4 flex items-center gap-2">
        <input
          type="password"
          inputMode="numeric"
          pattern="[0-9]{8}"
          maxLength={8}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setPin("");
              onCancel();
            }
          }}
          className="flex-1 bg-neutral-800 text-sm text-neutral-100 rounded px-3 py-2 border border-neutral-700 focus:outline-none focus:border-red-500"
          placeholder="8-digit PIN"
          autoComplete="off"
          autoFocus
        />
        <button type="submit" className="px-3 py-2 text-xs font-semibold rounded bg-red-700 hover:bg-red-600 text-white">
          Verify
        </button>
        <button
          type="button"
          onClick={() => {
            setPin("");
            onCancel();
          }}
          className="px-3 py-2 text-xs rounded text-neutral-400 hover:text-red-300 hover:bg-neutral-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function renderMessage(
  msg: ChatMessage,
  index: number,
  options: {
    canResendUserMessage?: boolean;
    resendingMessageId?: string | null;
    onResendUserMessage?: (msg: ChatMessage) => void;
    sessionId?: string | null;
    ttsAllowed?: boolean;
  } = {},
) {
  switch (msg.type) {
    case "assistant":
      return <AssistantMessage key={index} msg={msg} sessionId={options.sessionId} ttsAllowed={options.ttsAllowed} />;
    case "user":
      return (
        <UserMessage
          key={index}
          msg={msg}
          canResend={options.canResendUserMessage}
          isResending={typeof msg.id === "string" && msg.id === options.resendingMessageId}
          onResend={options.onResendUserMessage}
        />
      );
    case "toolResult":
    case "tool_result":
      return <ToolResultMessage key={index} msg={msg} />;
    case "error":
      return <ErrorMessage key={index} msg={msg} />;
    case "system":
      return <SystemMessage key={index} msg={msg} />;
    case "custom":
      return <CustomMessage key={index} msg={msg} />;
    case "goal_update":
      return <GoalUpdateMessage key={index} msg={msg} />;
    case "agent_start":
    case "agent_end":
    case "turn_start":
    case "turn_end":
    case "compaction_start":
    case "compaction_end":
      return null;
    default:
      return null;
  }
}

const MemoizedMessageRow = memo(function MemoizedMessageRow({
  msg,
  canResendUserMessage,
  resendingMessageId,
  onResendUserMessage,
  sessionId,
  ttsAllowed,
}: {
  msg: ChatMessage;
  canResendUserMessage: boolean;
  resendingMessageId: string | null;
  onResendUserMessage: (msg: ChatMessage) => void;
  sessionId: string | null;
  ttsAllowed: boolean;
}) {
  const messageId = typeof msg.id === "string" ? msg.id : null;
  return (
    <div {...(messageId ? { "data-message-id": messageId, id: `msg-${messageId}` } : {})}>
      {renderMessage(msg, 0, {
        canResendUserMessage,
        resendingMessageId,
        onResendUserMessage,
        sessionId,
        ttsAllowed,
      })}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Agent switch confirmation
// ---------------------------------------------------------------------------

interface AgentSwitchDialogState {
  sessionId: string;
  targetProfileId: string;
  targetName: string;
  preview: SessionAgentSwitchPreview | null;
  error: string;
}

function memoryAccessLabel(value: SessionAgentSwitchPreview["memory_access"]): string {
  if (value === "read_write") return "Read and write";
  if (value === "read") return "Read only";
  return "None";
}

function providerModelLabel(provider: string | null, model: string | null): string {
  return provider && model ? `${provider}/${model}` : "runtime default";
}

function AgentSwitchDialog({
  state,
  previewing,
  switching,
  onCancel,
  onConfirm,
}: {
  state: AgentSwitchDialogState;
  previewing: boolean;
  switching: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const preview = state.preview;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-switch-title"
      onClick={() => { if (!switching) onCancel(); }}
      onKeyDown={(event) => { if (event.key === "Escape" && !switching) onCancel(); }}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-neutral-800 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-400">Switch agent</div>
          <h2 id="agent-switch-title" className="mt-1 text-base font-semibold text-neutral-100">
            Switch to {preview?.to_agent_name ?? state.targetName}?
          </h2>
        </div>
        <div className="space-y-4 px-4 py-4">
          {previewing && (
            <div className="flex items-center gap-2 text-sm text-neutral-400">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-700 border-t-blue-400" />
              Resolving agent policy and model…
            </div>
          )}
          {state.error && (
            <div role="alert" className="rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-200">
              {state.error}
            </div>
          )}
          {preview && (
            <>
              <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 rounded border border-neutral-800 bg-neutral-900/40 px-3 py-3 text-xs">
                <dt className="text-neutral-500">Agent</dt>
                <dd className="text-neutral-200">{preview.from_agent_name ?? "Project default"} → {preview.to_agent_name}</dd>
                <dt className="text-neutral-500">Model</dt>
                <dd className="break-all font-mono text-neutral-200">{providerModelLabel(preview.current_provider, preview.current_model)} → {preview.target_provider}/{preview.target_model}</dd>
                <dt className="text-neutral-500">Memory</dt>
                <dd className="text-neutral-200">{memoryAccessLabel(preview.memory_access)}</dd>
              </dl>
              <div className="rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs leading-relaxed text-amber-100/85">
                {preview.warning}
              </div>
              {preview.transcript_retained && (
                <p className="text-xs leading-relaxed text-neutral-400">
                  Prior messages remain visible to the new agent. Your unsent composer draft stays in this browser.
                </p>
              )}
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-neutral-800 px-4 py-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={switching}
            className="rounded px-3 py-2 text-xs font-medium text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!preview || previewing || switching}
            className="inline-flex items-center gap-2 rounded bg-blue-700 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {switching && <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-300 border-t-white" />}
            {switching ? "Switching…" : "Switch agent"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatPanel
// ---------------------------------------------------------------------------

export function ChatPanel({
  activeSession,
  onSessionChange,
  onSessionUpdate,
  scrollToMessageId,
  onScrollToMessageHandled,
}: ChatPanelProps) {
  const activeSessionId = activeSession?.id ?? null;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesOwnerSessionId, setMessagesOwnerSessionId] = useState<string | null>(null);
  const [visibleMessageStart, setVisibleMessageStart] = useState(0);
  const [deferredUserMessages, setDeferredUserMessages] = useState<ChatMessage[]>([]);
  const [queuedUserMessages, setQueuedUserMessages] = useState<QueuedUserMessage[]>([]);
  const [streamingBlocks, setStreamingBlocks] = useState<StreamingBlocks>({ content: [] });
  const [inputText, setInputText] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [slashCommands, setSlashCommands] = useState<SlashCommandOption[]>(FALLBACK_SLASH_COMMANDS);
  const [slashAutocompleteOpen, setSlashAutocompleteOpen] = useState(false);
  const [slashAutocompleteIndex, setSlashAutocompleteIndex] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");
  const [bashMode, setBashMode] = useState<BashMode>("unavailable");
  const [isSessionHistoryLoading, setIsSessionHistoryLoading] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState<DefaultModelOption | null>(null);
  const [modelError, setModelError] = useState("");
  const [selectedModelValue, setSelectedModelValue] = useState("");
  const [isModelSaving, setIsModelSaving] = useState(false);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [agentProfiles, setAgentProfiles] = useState<AgentProfileSummary[]>([]);
  const [activeProject, setActiveProject] = useState<WorkspaceProject | null>(null);
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [agentSwitchDialog, setAgentSwitchDialog] = useState<AgentSwitchDialogState | null>(null);
  const [isAgentPreviewing, setIsAgentPreviewing] = useState(false);
  const [isAgentSwitching, setIsAgentSwitching] = useState(false);
  const [goalInput, setGoalInput] = useState("");
  const [showGoalInput, setShowGoalInput] = useState(false);
  const [interviewQueue, setInterviewQueue] = useState<QueuedInterview[]>([]);
  const [activeSudoPrompt, setActiveSudoPrompt] = useState<{
    requestId: string;
    sessionId: string;
    prompt: string;
    kind: "password" | "approval";
    command?: string;
    executable?: string;
    argv?: string[];
    cwd?: string;
    timeoutMs?: number;
    origin?: { mode: "parent" | "long-lived" | "one-shot"; lineage: string[] };
  } | null>(null);
  const [activeCommandGuardPinPrompt, setActiveCommandGuardPinPrompt] = useState<{
    requestId?: string;
    sessionId?: string;
    prompt: string;
    command?: string;
    reason?: string;
    requestedMode?: CommandGuardMode;
  } | null>(null);
  const [todoState, setTodoState] = useState<TodoState>({ todos: [], source: "none" });
  const [isTodoPanelOpen, setIsTodoPanelOpen] = useState(false);
  const [contextUsage, setContextUsage] = useState<{
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [commandGuardState, setCommandGuardState] = useState<CommandGuardState | null>(null);
  const [commandGuardSaving, setCommandGuardSaving] = useState(false);
  const [runtimeError, setRuntimeError] = useState<RuntimeErrorState | null>(null);
  const [resendingMessageId, setResendingMessageId] = useState<string | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [activeTurnScrollAnchorText, setActiveTurnScrollAnchorText] = useState<string | null>(null);

  const currentGoal = activeSession?.goal ?? null;
  const currentGoalStatus = activeSession?.goal_status ?? null;
  const effectiveAgentProfileId = activeSession?.agent_profile_id ?? activeProject?.default_agent_profile_id ?? null;
  const transcriptOwnedBySelection = Boolean(activeSessionId && messagesOwnerSessionId === activeSessionId);
  const normalizedOwnedMessages = useMemo(
    () => transcriptOwnedBySelection ? normalizeMessagesForDisplay(messages) : [],
    [messages, transcriptOwnedBySelection],
  );
  const displayMessages = useMemo(
    () => normalizedOwnedMessages.slice(visibleMessageStart),
    [normalizedOwnedMessages, visibleMessageStart],
  );
  const visibleInterviews = useMemo(
    () => activeSessionId ? interviewQueue.filter((item) => item.sessionId === activeSessionId) : [],
    [activeSessionId, interviewQueue],
  );
  const activeInterview = visibleInterviews[0] ?? null;

  const loadModelOptions = useCallback((options: { refresh?: boolean } = {}) => {
    let cancelled = false;
    fetchModels(options)
      .then(({ models, defaultModel, error }) => {
        if (cancelled) return;
        setModelOptions(models);
        setDefaultModel(defaultModel);
        setModelError(error ?? "");
      })
      .catch((err: unknown) => {
        if (!cancelled) setModelError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => loadModelOptions(), [loadModelOptions]);

  useEffect(() => {
    if (!isModelPickerOpen) return;
    return loadModelOptions({ refresh: true });
  }, [isModelPickerOpen, loadModelOptions]);

  useEffect(() => {
    setSelectedModelValue(sessionModelSelectValue(activeSession));
  }, [activeSession]);

  useEffect(() => {
    if (!activeSessionId || !activeSession?.cwd) {
      setActiveProject(null);
      setAgentSwitchDialog(null);
      setIsAgentPickerOpen(false);
      return;
    }
    let cancelled = false;
    setAgentError("");
    // Keep an already-resolved same-workspace context while refreshing the
    // agent picker. A different selected cwd cannot reuse it because the
    // owner-cwd check below keeps TTS hidden until the new join resolves.
    void Promise.all([fetchAgentProfiles(), fetchProjects()]).then(([profiles, projects]) => {
      if (cancelled) return;
      setAgentProfiles(profiles);
      const cwd = activeSession.cwd.replace(/\/+$/, "") || "/";
      setActiveProject(projects.find((project) => (project.cwd.replace(/\/+$/, "") || "/") === cwd) ?? null);
    }).catch((error: unknown) => {
      if (!cancelled) setAgentError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [activeSession?.cwd, activeSessionId, isAgentPickerOpen]);

  useEffect(() => {
    setAgentSwitchDialog(null);
    setIsAgentPickerOpen(false);
    setIsAgentPreviewing(false);
    setIsAgentSwitching(false);
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId) {
      setSlashCommands(FALLBACK_SLASH_COMMANDS);
      return;
    }
    let cancelled = false;
    setSlashCommands(FALLBACK_SLASH_COMMANDS);
    fetchSlashCommands(activeSessionId)
      .then(({ commands }) => {
        if (!cancelled) setSlashCommands(mergeSlashCommands(commands));
      })
      .catch(() => {
        if (!cancelled) setSlashCommands(FALLBACK_SLASH_COMMANDS);
      });
    const retry = window.setTimeout(() => {
      fetchSlashCommands(activeSessionId)
        .then(({ commands }) => {
          if (!cancelled) setSlashCommands(mergeSlashCommands(commands));
        })
        .catch(() => {});
    }, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, [activeSessionId]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const selectedSessionIdRef = useRef<string | null>(activeSessionId);
  const selectionIdRef = useRef<string | null>(null);
  const selectionGenerationRef = useRef(0);
  const selectionStartedAtRef = useRef(0);
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const activeTurnUserMessageRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const wsConnectedRef = useRef(false);
  const connectingSessionIdRef = useRef<string | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const wsAttemptIdRef = useRef(0);
  const transportGenerationRef = useRef(0);
  const activeSessionErrorRef = useRef<string | null>(null);
  const activeSessionRuntimeStreamingRef = useRef(false);
  const isStreamingRef = useRef(false);
  const pinActiveTurnScrollRef = useRef(false);
  const lastProgrammaticScrollAtRef = useRef(0);
  const queuedUserMessagesRef = useRef<QueuedUserMessage[]>([]);
  const deferredUserMessagesRef = useRef<ChatMessage[]>([]);
  const streamingBlocksRef = useRef<StreamingBlocks>({ content: [] });
  const interviewQueueRef = useRef<QueuedInterview[]>([]);
  const isRestoringDraftRef = useRef(false);
  activeSessionErrorRef.current = activeSession?.error ?? null;
  activeSessionRuntimeStreamingRef.current = Boolean(activeSession?.runtime_is_streaming);

  useLayoutEffect(() => {
    selectedSessionIdRef.current = activeSessionId;
    selectionGenerationRef.current += 1;
  }, [activeSessionId]);

  useEffect(() => {
    isRestoringDraftRef.current = true;
    setInputText(loadChatDraft(activeSessionId));
  }, [activeSessionId]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [inputText]);

  useEffect(() => {
    if (isRestoringDraftRef.current) {
      isRestoringDraftRef.current = false;
      return;
    }
    persistChatDraft(activeSessionId, inputText);
  }, [activeSessionId, inputText]);

  const setStreamingBlocksSynced = useCallback((updater: StreamingBlocks | ((prev: StreamingBlocks) => StreamingBlocks)) => {
    const next = typeof updater === "function"
      ? (updater as (prev: StreamingBlocks) => StreamingBlocks)(streamingBlocksRef.current)
      : updater;
    streamingBlocksRef.current = next;
    setStreamingBlocks(next);
  }, []);

  const setQueuedMessagesSynced = useCallback((updater: (prev: QueuedUserMessage[]) => QueuedUserMessage[]) => {
    const next = updater(queuedUserMessagesRef.current);
    queuedUserMessagesRef.current = next;
    setQueuedUserMessages(next);
  }, []);

  const setInterviewQueueSynced = useCallback((updater: (prev: QueuedInterview[]) => QueuedInterview[]) => {
    const next = updater(interviewQueueRef.current);
    interviewQueueRef.current = next;
    setInterviewQueue(next);
  }, []);

  const hasActiveAssistantOutput = useCallback(() => {
    const blocks = streamingBlocksRef.current;
    return isStreamingRef.current || blocks.content.length > 0;
  }, []);

  const insertAcceptedUsersAfterActiveStreaming = useCallback((userMessages: ChatMessage[]) => {
    if (userMessages.length === 0) return;
    const assistantMessage = streamingBlocksToAssistantMessage(streamingBlocksRef.current);
    setMessages((prev) => {
      let next = assistantMessage ? [...prev, assistantMessage] : prev;
      for (const userMessage of userMessages) {
        next = upsertUserMessage(next, userMessage);
      }
      return next;
    });
    // Keep the agent running flag intact, but start a fresh live accumulator so
    // post-steering thinking/text/tool deltas render below the accepted user
    // message instead of continuing the pre-message content above it.
    setStreamingBlocksSynced({ content: [] });
  }, [setStreamingBlocksSynced]);

  const appendRuntimeError = useCallback((message: string) => {
    const trimmed = message.trim() || "Unknown error";
    setRuntimeError({ message: trimmed, timestamp: Date.now() });
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.type === "error" && last.error === trimmed) return prev;
      return [...prev, { type: "error", error: trimmed }];
    });
    onSessionChange?.();
  }, [onSessionChange]);

  const clearRuntimeError = useCallback(() => {
    setRuntimeError(null);
  }, []);

  const clearQueuedAndDeferredUserMessages = useCallback(() => {
    queuedUserMessagesRef.current = [];
    deferredUserMessagesRef.current = [];
    setQueuedUserMessages([]);
    setDeferredUserMessages([]);
  }, []);

  const queuedMessageMatchesContent = useCallback((message: QueuedUserMessage, content: string) => (
    message.content === content ||
    (message.content.trim() !== "" && content.startsWith(message.content.trim())) ||
    ((message.attachments?.length ?? 0) > 0 && content.includes("<file name="))
  ), []);

  const takeMatchingQueuedMessage = useCallback((content: string) => {
    const matchesQueuedMessage = (message: QueuedUserMessage) => queuedMessageMatchesContent(message, content);

    const queuedIndex = queuedUserMessagesRef.current.findIndex(matchesQueuedMessage);
    if (queuedIndex === -1) return false;

    setQueuedMessagesSynced((prev) => {
      const index = prev.findIndex(matchesQueuedMessage);
      if (index === -1) return prev;
      return [...prev.slice(0, index), ...prev.slice(index + 1)];
    });
    return true;
  }, [queuedMessageMatchesContent, setQueuedMessagesSynced]);

  const restoreQueuedMessagesToComposer = useCallback(() => {
    const queued = queuedUserMessagesRef.current;
    if (queued.length === 0) return false;

    const queuedText = queued
      .map((message) => message.content)
      .filter((content) => content.trim().length > 0)
      .join("\n\n");
    const queuedAttachments = queued.flatMap((message) => message.attachments ?? []);

    if (queuedText) {
      setInputText((prev) => [queuedText, prev].filter((text) => text.trim().length > 0).join("\n\n"));
    }
    if (queuedAttachments.length > 0) {
      setPendingAttachments((prev) => [...queuedAttachments, ...prev]);
    }

    setQueuedMessagesSynced(() => []);
    return true;
  }, [setQueuedMessagesSynced]);

  // History receipt chooses a target-centered initial window, so search-anchor
  // scrolling no longer waits on blind 100ms DOM polling or full hydration.
  useEffect(() => {
    if (!scrollToMessageId || !transcriptOwnedBySelection) return;
    let cancelled = false;
    let frames = 0;
    const reveal = () => {
      if (cancelled) return;
      const target = scrollContainerRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(scrollToMessageId)}"]`,
      );
      if (!target && frames++ < 4) {
        requestAnimationFrame(reveal);
        return;
      }
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "auto" });
        target.classList.add("ring-2", "ring-amber-400", "ring-offset-2", "ring-offset-neutral-950", "rounded", "transition-shadow");
        window.setTimeout(() => target.classList.remove("ring-2", "ring-amber-400", "ring-offset-2", "ring-offset-neutral-950"), 1500);
      }
      onScrollToMessageHandled?.();
    };
    requestAnimationFrame(reveal);
    return () => { cancelled = true; };
  }, [scrollToMessageId, onScrollToMessageHandled, activeSessionId, transcriptOwnedBySelection, visibleMessageStart]);

  // Tail-first progressive hydration. Prepend bounded chunks during idle time
  // while preserving the viewport's visual anchor.
  useEffect(() => {
    if (!transcriptOwnedBySelection || visibleMessageStart <= 0 || scrollToMessageId) return;
    let cancelled = false;
    const hydrate = () => {
      if (cancelled) return;
      const container = scrollContainerRef.current;
      const previousHeight = container?.scrollHeight ?? 0;
      setVisibleMessageStart((start) => Math.max(0, start - TRANSCRIPT_HYDRATION_CHUNK_ROWS));
      requestAnimationFrame(() => {
        if (!container || cancelled) return;
        container.scrollTop += container.scrollHeight - previousHeight;
      });
    };
    const idleWindow = window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const id = idleWindow.requestIdleCallback
      ? idleWindow.requestIdleCallback(hydrate, { timeout: 100 })
      : window.setTimeout(hydrate, 16);
    return () => {
      cancelled = true;
      if (idleWindow.cancelIdleCallback) idleWindow.cancelIdleCallback(id);
      else window.clearTimeout(id);
    };
  }, [transcriptOwnedBySelection, visibleMessageStart, scrollToMessageId]);

  // Auto-scroll. During a freshly submitted turn, pin the accepted user prompt
  // to the top of the transcript while the assistant response grows below it.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (pinActiveTurnScrollRef.current && activeTurnUserMessageRef.current) {
      lastProgrammaticScrollAtRef.current = Date.now();
      activeTurnUserMessageRef.current.scrollIntoView({ block: "start" });
      const distance = getScrollDistanceFromBottom(container);
      setShowScrollToBottom(distance > BOTTOM_SCROLL_TOLERANCE_PX);
      return;
    }

    if (isScrolledToBottom(container)) {
      scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, deferredUserMessages, streamingBlocks, interviewQueue, activeSudoPrompt, activeCommandGuardPinPrompt, activeTurnScrollAnchorText]);

  // ------------------------------------------------------------------
  // WS connection
  // ------------------------------------------------------------------

  const sendWs = useCallback((payload: Record<string, unknown>): boolean => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  const sendQueuedInterviewSubmission = useCallback((requestId: string): boolean => {
    const sessionId = activeSessionIdRef.current;
    const interview = interviewQueueRef.current.find((item) => item.requestId === requestId && item.sessionId === sessionId);
    if (!interview?.submission || !sessionId) return false;

    const sent = sendWs({
      type: "interview_response",
      requestId: interview.requestId,
      answers: interview.submission.answers,
    });
    setInterviewQueueSynced((current) => current.map((item) => {
      if (item.requestId !== requestId || item.sessionId !== interview.sessionId || !item.submission) return item;
      return {
        ...item,
        submission: {
          ...item.submission,
          state: sent ? "submitting" : "retry",
          lastSentAt: sent ? Date.now() : item.submission.lastSentAt,
          message: sent ? undefined : "Waiting for the WebSocket to reconnect before retrying.",
        },
      };
    }));
    return sent;
  }, [sendWs, setInterviewQueueSynced]);

  const resendQueuedInterviewSubmissions = useCallback((sessionId: string) => {
    for (const interview of interviewQueueRef.current) {
      if (interview.sessionId === sessionId && interview.submission && interview.submission.state !== "rejected") {
        sendQueuedInterviewSubmission(interview.requestId);
      }
    }
  }, [sendQueuedInterviewSubmission]);

  useEffect(() => {
    const connect = () => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) {
        chatWsProfile("connect_skip_no_session");
        return;
      }
      if (wsRef.current) {
        chatWsProfile("connect_skip_existing_socket", {
          sessionId,
          readyState: wsRef.current.readyState,
        });
        return;
      }

      const attemptId = ++wsAttemptIdRef.current;
      const transportGeneration = ++transportGenerationRef.current;
      const connectStart = performance.now();
      chatWsProfile("connect_start", { sessionId, selectionId: selectionIdRef.current, attemptId });

      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      const url = chatWsUrl(sessionId, selectionIdRef.current);
      const ws = new WebSocket(url);
      chatWsProfile("socket_constructed", {
        sessionId,
        attemptId,
        selectionId: selectionIdRef.current,
        elapsedMs: Math.round(performance.now() - connectStart),
      });
      wsRef.current = ws;
      connectingSessionIdRef.current = sessionId;
      setWsStatus("connecting");

      ws.onopen = () => {
        chatWsProfile("socket_open", {
          sessionId,
          attemptId,
          elapsedMs: Math.round(performance.now() - connectStart),
        });
        reconnectAttemptRef.current = 0;
        wsConnectedRef.current = true;
        setWsStatus("connecting");

        // Handle session drift
        const current = activeSessionIdRef.current;
        if (current && current !== connectingSessionIdRef.current) {
          chatWsProfile("send_switch_after_open", {
            from: connectingSessionIdRef.current,
            to: current,
            attemptId,
            elapsedMs: Math.round(performance.now() - connectStart),
          });
          ws.send(
            JSON.stringify({
              type: "switch_session",
              session_id: current,
              selection_id: selectionIdRef.current,
            }),
          );
          connectingSessionIdRef.current = current;
        }
      };

      ws.onmessage = (ev) => {
        let msg: ChatMessage;
        try {
          msg = JSON.parse(ev.data as string);
        } catch {
          return;
        }

        if (msg.type === "session_runtime_state") {
          if (
            msg.session_id === selectedSessionIdRef.current
            && msg.session_id === activeSessionIdRef.current
            && msg.selection_id === selectionIdRef.current
            && ws === wsRef.current
            && transportGeneration === transportGenerationRef.current
          ) {
            setBashMode(isBashMode(msg.bash_mode) ? msg.bash_mode : "unavailable");
          }
          return;
        }

        if (msg.type === "session_loading") {
          chatWsProfile("message_session_loading", {
            sessionId: msg.session_id,
            attemptId,
            elapsedMs: Math.round(performance.now() - connectStart),
          });
          if (msg.session_id === activeSessionIdRef.current && msg.selection_id === selectionIdRef.current) {
            setBashMode("unavailable");
            setWsStatus("connecting");
            setIsSessionHistoryLoading(true);
          }
          return;
        }

        if (msg.type === "session_ready") {
          chatWsProfile("message_session_ready", {
            sessionId: msg.session_id,
            activeSessionId: activeSessionIdRef.current,
            attemptId,
            elapsedMs: Math.round(performance.now() - connectStart),
          });
          if (msg.session_id === activeSessionIdRef.current && msg.selection_id === selectionIdRef.current) {
            setWsStatus("connected");
            // The backend has rebound this durable socket to the selected
            // session. Resend only cached responses for that same session.
            // Identical retries are safe once the durable backend transition
            // is implemented, and no other session's request can leak here.
            if (activeSessionIdRef.current) {
              resendQueuedInterviewSubmissions(activeSessionIdRef.current);
            }
          }
          return;
        }

        if (msg.type === "session_error") {
          setResendingMessageId(null);
          chatWsProfile("message_session_error", {
            sessionId: msg.session_id,
            error: msg.error,
            attemptId,
            elapsedMs: Math.round(performance.now() - connectStart),
          });
          if (msg.session_id === activeSessionIdRef.current && msg.selection_id === selectionIdRef.current) {
            setBashMode("unavailable");
            setWsStatus("disconnected");
            setIsSessionHistoryLoading(false);
            appendRuntimeError(String(msg.error || "Failed to load session"));
          }
          return;
        }

        // Handle history (replace, don't append)
        if (msg.type === "history") {
          if (msg.session_id !== activeSessionIdRef.current || msg.selection_id !== selectionIdRef.current) {
            chatWsProfile("stale_history_ignored", { sessionId: msg.session_id, selectionId: msg.selection_id });
            return;
          }
          if (msg.reason === "agent_settled_reconciliation") {
            // Keep reconnect-era partial output visible until its authoritative
            // settled snapshot is actually available, then replace it atomically
            // with durable history rather than briefly rendering both copies.
            setStreamingBlocksSynced({ content: [] });
          }
          const historyMessages: ChatMessage[] = Array.isArray(msg.messages)
            ? msg.messages
            : [];
          chatWsProfile("message_history", {
            sessionId: msg.session_id,
            selectionId: msg.selection_id,
            count: historyMessages.length,
            attemptId,
            elapsedMs: Math.round(performance.now() - connectStart),
          });
          if (hasActiveAssistantOutput() && queuedUserMessagesRef.current.length > 0) {
            const remainingQueued = [...queuedUserMessagesRef.current];
            const acceptedNextTurnMessages: ChatMessage[] = [];
            const visibleHistoryMessages = historyMessages.filter((historyMessage) => {
              const message = historyMessage?.message;
              if (historyMessage?.type !== "user" || !message) return true;
              const content = getUserMessageText(message);
              const queuedIndex = remainingQueued.findIndex((queued) => queuedMessageMatchesContent(queued, content));
              if (queuedIndex === -1) return true;
              remainingQueued.splice(queuedIndex, 1);
              acceptedNextTurnMessages.push(historyMessage);
              return false;
            });

            setMessages((prev) => mergeHistoryWithLocalPending(visibleHistoryMessages, prev));
            setQueuedMessagesSynced(() => remainingQueued);
            if (acceptedNextTurnMessages.length > 0) {
              insertAcceptedUsersAfterActiveStreaming(acceptedNextTurnMessages);
            }
          } else {
            setMessages((prev) => mergeHistoryWithLocalPending(historyMessages, prev));
            clearQueuedAndDeferredUserMessages();
          }
          setMessagesOwnerSessionId(activeSessionIdRef.current);
          const normalizedHistory = normalizeMessagesForDisplay(historyMessages);
          const anchorIndex = scrollToMessageId
            ? normalizedHistory.findIndex((message) => message.id === scrollToMessageId)
            : -1;
          const desiredStart = anchorIndex >= 0
            ? Math.max(0, anchorIndex - Math.floor(INITIAL_TRANSCRIPT_TAIL_ROWS / 2))
            : Math.max(0, normalizedHistory.length - INITIAL_TRANSCRIPT_TAIL_ROWS);
          setVisibleMessageStart(desiredStart);
          setResendingMessageId(null);
          const historyGuardState = commandGuardStateFromMessages(historyMessages);
          if (historyGuardState) setCommandGuardState(historyGuardState);
          const acceptedSelectionId = selectionIdRef.current;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (selectionIdRef.current !== acceptedSelectionId) return;
            setIsSessionHistoryLoading(false);
            chatWsProfile("history_painted", {
              sessionId: activeSessionIdRef.current,
              selectionId: acceptedSelectionId,
              domRows: scrollContainerRef.current?.querySelectorAll("[data-message-id]").length ?? 0,
            });
            requestAnimationFrame(() => requestAnimationFrame(() => {
              if (selectionIdRef.current !== acceptedSelectionId) return;
              chatWsProfile("transcript_usable", {
                sessionId: activeSessionIdRef.current,
                selectionId: acceptedSelectionId,
                elapsedMs: Math.round(performance.now() - selectionStartedAtRef.current),
              });
            }));
            if (!scrollToMessageId) scrollAnchorRef.current?.scrollIntoView();
          }));
          return;
        }

        // Handle streaming deltas
        if (msg.type === "text_delta") {
          setStreamingBlocksSynced((prev) => appendStreamingDelta(prev, "text", msg.delta || ""));
          return;
        }

        if (msg.type === "thinking_delta") {
          setStreamingBlocksSynced((prev) => appendStreamingDelta(prev, "thinking", msg.delta || ""));
          return;
        }

        // Tool execution
        if (msg.type === "tool_execution_start") {
          setStreamingBlocksSynced((prev) => appendStreamingBlock(prev, {
            type: "tool_use",
            id: typeof msg.tool_call_id === "string" ? msg.tool_call_id : undefined,
            name: msg.tool_name || "unknown",
            input: msg.input || {},
          }));
          return;
        }

        if (msg.type === "tool_execution_end") {
          setStreamingBlocksSynced((prev) => appendStreamingBlock(prev, {
            type: "tool_result",
            id: typeof msg.tool_call_id === "string" ? msg.tool_call_id : undefined,
            name: typeof msg.tool_name === "string" ? msg.tool_name : undefined,
            content: msg.result,
            is_error: Boolean(msg.is_error),
          }));
          return;
        }

        // Agent lifecycle
        if (msg.type === "agent_start") {
          clearRuntimeError();
          setResendingMessageId(null);
          isStreamingRef.current = true;
          setIsStreaming(true);
          setStreamingBlocksSynced({ content: [] });
          return;
        }

        if (msg.type === "agent_end") {
          // Build content before clearing the live streaming panel. Keep
          // isStreamingRef true until the assistant flush completes so any
          // same-tick accepted user echo is still treated as next-turn content.
          const assistantMessage = streamingBlocksToAssistantMessage(streamingBlocksRef.current);
          const acceptedUserMessages = deferredUserMessagesRef.current;
          if (assistantMessage || acceptedUserMessages.length > 0) {
            setMessages((prev) => [
              ...prev,
              ...(assistantMessage ? [assistantMessage] : []),
              ...acceptedUserMessages,
            ]);
          }
          if (acceptedUserMessages.length > 0) {
            deferredUserMessagesRef.current = [];
            setDeferredUserMessages([]);
          }

          const turnError = agentEndErrorMessage(msg);
          if (turnError && !assistantMessage) {
            appendRuntimeError(turnError);
          } else if (turnError) {
            setRuntimeError({ message: turnError, timestamp: Date.now() });
          }

          setStreamingBlocksSynced({ content: [] });
          // Pi can retry or compact after agent_end. Keep the top-level run
          // active until agent_settled so a prompt sent in that interval stays
          // queued instead of being inserted ahead of continuation output.
          onSessionChange?.();
          return;
        }

        if (msg.type === "compaction_start") {
          setIsCompacting(true);
          return;
        }

        if (msg.type === "compaction_end") {
          setIsCompacting(false);
          if (typeof msg.error === "string" && msg.error.trim()) {
            appendRuntimeError(msg.error);
          }
          return;
        }

        if (msg.type === "agent_settled") {
          setIsCompacting(false);
          isStreamingRef.current = false;
          pinActiveTurnScrollRef.current = false;
          setActiveTurnScrollAnchorText(null);
          setIsStreaming(false);
          onSessionChange?.();
          return;
        }

        // Goal updates
        if (msg.type === "goal_update") {
          setMessages((prev) => [...prev, msg]);
          onSessionChange?.();
          return;
        }

        // TODO state updates
        if (msg.type === "todo_state") {
          if (msg.session_id && (msg.session_id !== activeSessionIdRef.current || msg.selection_id !== selectionIdRef.current)) return;
          setTodoState({
            todos: Array.isArray(msg.todos) ? msg.todos : [],
            source: typeof msg.source === "string" ? msg.source : "none",
          });
          return;
        }

        // Context usage updates
        if (msg.type === "context_usage") {
          setContextUsage({
            tokens: msg.tokens ?? null,
            contextWindow: msg.contextWindow ?? 0,
            percent: msg.percent ?? null,
          });
          return;
        }

        // Command guard status/control updates
        if (msg.type === "command_guard_state") {
          setCommandGuardState({
            available: Boolean(msg.available),
            mode: msg.mode || "unknown",
            source: msg.source,
            modelRoute: Array.isArray(msg.modelRoute) ? msg.modelRoute : [],
            error: msg.error,
            pinRequired: Boolean(msg.pinRequired),
            pinConfigured: typeof msg.pinConfigured === "boolean" ? msg.pinConfigured : undefined,
          });
          setCommandGuardSaving(false);
          if (msg.pinRequired) {
            setActiveCommandGuardPinPrompt({
              prompt: msg.error || "Identity PIN required to disable command guard",
              requestedMode: "off",
            });
          }
          return;
        }

        // Durable interview requests are session-scoped and queued in creation
        // order. A replay refreshes the question schema but cannot overwrite a
        // locally retained final response for the same immutable request id.
        if (msg.type === "interview_request") {
          const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
          const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : activeSessionIdRef.current;
          const questions = Array.isArray(msg.questions) && msg.questions.every(isInterviewQuestion)
            ? msg.questions
            : null;
          if (!requestId || !sessionId || !questions) return;
          const createdAt = typeof msg.createdAt === "number"
            ? msg.createdAt
            : typeof msg.created_at === "number"
              ? msg.created_at
              : Date.now();
          setInterviewQueueSynced((current) => mergeInterviewQueue(current, [{
            requestId,
            sessionId,
            questions,
            createdAt,
          }]));
          window.setTimeout(() => scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" }), 0);
          return;
        }

        if (msg.type === "interview_response_ack") {
          const ack = msg as InterviewResponseAck;
          const requestId = typeof ack.requestId === "string" ? ack.requestId : null;
          const sessionId = typeof ack.sessionId === "string" ? ack.sessionId : activeSessionIdRef.current;
          if (!requestId || !sessionId) return;
          const matching = interviewQueueRef.current.find((item) => item.requestId === requestId && item.sessionId === sessionId);
          if (!matching?.submission) return;

          if (isAcceptedInterviewAck(ack)) {
            clearStoredInterviewSubmission(sessionId, requestId);
            setInterviewQueueSynced((current) => current.filter((item) => !(item.requestId === requestId && item.sessionId === sessionId)));
          } else {
            const message = interviewAckError(ack) ?? "The server did not confirm durable receipt; retry when ready.";
            setInterviewQueueSynced((current) => current.map((item) => (
              item.requestId === requestId && item.sessionId === sessionId && item.submission
                ? { ...item, submission: { ...item.submission, state: "rejected", message } }
                : item
            )));
          }
          return;
        }

        // Command guard identity PIN requests
        if (msg.type === "command_guard_pin_request") {
          setActiveCommandGuardPinPrompt({
            requestId: msg.requestId,
            sessionId: msg.sessionId || activeSessionIdRef.current,
            prompt: msg.prompt || "Identity PIN required",
            command: typeof msg.command === "string" ? msg.command : undefined,
            reason: typeof msg.reason === "string" ? msg.reason : undefined,
          });
          window.setTimeout(() => scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" }), 0);
          return;
        }

        // Sudo password requests
        if (msg.type === "sudo_request") {
          setActiveSudoPrompt({
            requestId: msg.requestId,
            sessionId: msg.sessionId || activeSessionIdRef.current,
            prompt: msg.prompt || "Sudo password required",
            kind: msg.kind === "approval" ? "approval" : "password",
            command: typeof msg.command === "string" ? msg.command : undefined,
            executable: typeof msg.executable === "string" ? msg.executable : undefined,
            argv: Array.isArray(msg.argv) && msg.argv.every((arg: unknown) => typeof arg === "string") ? msg.argv : undefined,
            cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
            timeoutMs: typeof msg.timeoutMs === "number" ? msg.timeoutMs : undefined,
            origin: msg.origin && ["parent", "long-lived", "one-shot"].includes(msg.origin.mode) && Array.isArray(msg.origin.lineage)
              ? { mode: msg.origin.mode, lineage: msg.origin.lineage.filter((item: unknown) => typeof item === "string") }
              : undefined,
          });
          window.setTimeout(() => scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" }), 0);
          return;
        }

        // Regular messages
        if (
          msg.type === "message_start" ||
          msg.type === "message_end"
        ) {
          const message = msg.message;
          if (!message) return;

          // User messages arrive with full content (no streaming) — add on start, skip end.
          // The backend may emit agent_start before echoing the current turn's user message
          // in a new session. Only defer messages that were explicitly queued while an
          // assistant turn was already streaming; otherwise keep the accepted prompt above
          // the live assistant response.
          if (message.role === "user") {
            if (msg.type === "message_start") {
              const userMessage = { type: "user", message };
              const wasQueuedForNextTurn = takeMatchingQueuedMessage(getUserMessageText(message));
              if (hasActiveAssistantOutput() && wasQueuedForNextTurn) {
                insertAcceptedUsersAfterActiveStreaming([userMessage]);
              } else {
                setMessages((prev) => upsertUserMessage(prev, userMessage));
              }
            }
            return;
          }
          // Custom extension messages (for example startup hooks) arrive as
          // complete records. Add on end to avoid duplicates.
          if (message.role === "custom") {
            if (message.customType === "command-guard-status") {
              const mode = parseCommandGuardModeFromText(textFromCustomMessage(message));
              if (mode) setCommandGuardState((prev) => ({
                ...(prev ?? { available: true }),
                available: true,
                mode,
                source: "message",
                error: undefined,
              }));
            }
            if (msg.type === "message_end" && message.display !== false) {
              setMessages((prev) => [
                ...prev,
                { type: "custom", message },
              ]);
            }
            return;
          }
          // Assistant messages stream via deltas; agent_end flushes them. If the
          // provider failed before producing visible content (for example an
          // invalidated OAuth token), surface the assistant error immediately.
          if (message.role === "assistant" && msg.type === "message_end") {
            const error = assistantErrorMessage(message);
            if (error) appendRuntimeError(error);
          }
          return;
        }

        if (
          msg.type === "assistant" ||
          msg.type === "user" ||
          msg.type === "toolResult" ||
          msg.type === "error" ||
          msg.type === "system" ||
          msg.type === "custom"
        ) {
          if (msg.type === "user") {
            const wasQueuedForNextTurn = takeMatchingQueuedMessage(getUserMessageText(msg.message));
            if (hasActiveAssistantOutput() && wasQueuedForNextTurn) {
              insertAcceptedUsersAfterActiveStreaming([msg]);
              return;
            }
          }
          if (msg.type === "error") {
            setResendingMessageId(null);
            appendRuntimeError(String(msg.error || "Unknown error"));
            return;
          }
          setMessages((prev) => msg.type === "user" ? upsertUserMessage(prev, msg) : [...prev, msg]);
          return;
        }
      };

      ws.onclose = (ev) => {
        chatWsProfile("socket_close", {
          sessionId,
          attemptId,
          code: ev.code,
          reason: ev.reason,
          elapsedMs: Math.round(performance.now() - connectStart),
        });
        const closedCurrentTransport = wsRef.current === ws;
        wsRef.current = null;
        wsConnectedRef.current = false;
        connectingSessionIdRef.current = null;
        if (closedCurrentTransport) setBashMode("unavailable");
        setWsStatus("disconnected");
        setInterviewQueueSynced((current) => current.map((item) => (
          item.submission && item.submission.state === "submitting"
            ? { ...item, submission: { ...item.submission, state: "retry", message: "Connection closed before acknowledgement; this answer will be resent after reconnect." } }
            : item
        )));

        void canRetryAuthenticatedTransport().then((canRetry) => {
          if (!canRetry || ev.code === 1008 || !activeSessionIdRef.current || wsRef.current) return;
          const attempt = reconnectAttemptRef.current;
          const delay =
            RECONNECT_BACKOFF_MS[
              Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)
            ];
          reconnectAttemptRef.current = attempt + 1;
          reconnectTimerRef.current = window.setTimeout(connect, delay);
        });
      };

      ws.onerror = () => {
        if (wsRef.current === ws) setBashMode("unavailable");
        chatWsProfile("socket_error", {
          sessionId,
          attemptId,
          elapsedMs: Math.round(performance.now() - connectStart),
        });
      };
    };

    connectRef.current = connect;

    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectAttemptRef.current = 0;
      const ws = wsRef.current;
      wsRef.current = null;
      wsConnectedRef.current = false;
      connectingSessionIdRef.current = null;
      if (ws) {
        try {
          ws.onclose = null;
          ws.onmessage = null;
          ws.onopen = null;
          ws.onerror = null;
          ws.close();
        } catch {
          // ignore
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On session change
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    const selectionGeneration = selectionGenerationRef.current;
    const selectionId = activeSessionId ? createSelectionId() : null;
    selectionIdRef.current = selectionId;
    selectionStartedAtRef.current = performance.now();
    chatWsProfile("selection_started", { activeSessionId, selectionId, selectionGeneration });
    chatWsProfile("active_session_effect", {
      activeSessionId,
      hasSocket: Boolean(wsRef.current),
      socketReadyState: wsRef.current?.readyState,
      wsConnected: wsConnectedRef.current,
    });
    setBashMode("unavailable");
    if (!activeSessionId) {
      setMessagesOwnerSessionId(null);
      setMessages([]);
      setIsSessionHistoryLoading(false);
      return;
    }

    const existingSocket = wsRef.current;
    const hasOpenSocket = existingSocket?.readyState === WebSocket.OPEN;
    // The chat WebSocket is intentionally durable across session changes.
    // Keep the transport lamp green while we rebind the existing socket to a
    // different session; history/loading state is separate from connection
    // health. Initial connects and real reconnects still show yellow.
    setWsStatus(hasOpenSocket ? "connected" : "connecting");
    setIsSessionHistoryLoading(true);
    setMessagesOwnerSessionId(null);
    setVisibleMessageStart(0);
    setMessages([]);
    clearQueuedAndDeferredUserMessages();
    setPendingAttachments([]);
    setAttachmentError("");
    const sessionError = activeSessionErrorRef.current;
    setRuntimeError(sessionError ? { message: sessionError, timestamp: Date.now() } : null);
    setResendingMessageId(null);
    // Preserve a running-state hint when opening an already-live session. The
    // backend will also synthesize agent_start on attach if the turn is still
    // running, but this keeps Interrupt visible immediately after selection.
    const initialStreaming = activeSessionRuntimeStreamingRef.current;
    setIsStreaming(initialStreaming);
    isStreamingRef.current = initialStreaming;
    pinActiveTurnScrollRef.current = false;
    setActiveTurnScrollAnchorText(null);
    // Keep interview queue entries session-scoped rather than singleton UI
    // state. This preserves unacknowledged answers across session switches;
    // only entries for the selected session render, and durable request
    // replays merge without replacing them.
    setInterviewQueueSynced((current) => mergeInterviewQueue(current, loadStoredInterviewSubmissions(activeSessionId)));
    setActiveSudoPrompt(null);
    setActiveCommandGuardPinPrompt(null);
    setTodoState({ todos: [], source: "none" });
    setIsTodoPanelOpen(false);
    setContextUsage(null);
    setIsCompacting(false);
    setCommandGuardState(null);
    setCommandGuardSaving(false);
    setStreamingBlocksSynced({ content: [] });

    if (hasOpenSocket) {
      chatWsProfile("send_switch_session", {
        activeSessionId,
        selectionId,
        elapsedMs: Math.round(performance.now() - selectionStartedAtRef.current),
      });
      sendWs({ type: "switch_session", session_id: activeSessionId, selection_id: selectionId });
      return;
    }

    if (!wsRef.current) {
      chatWsProfile("invoke_connect", { activeSessionId });
      connectRef.current();
    }
  }, [activeSessionId, sendWs, clearQueuedAndDeferredUserMessages, setInterviewQueueSynced, setStreamingBlocksSynced]);

  // Mark a sent response retryable when a connected socket never returns the
  // required durable acknowledgement. This does not resend in a loop; the
  // next reconnect or explicit Retry uses the same immutable payload.
  useEffect(() => {
    const interval = window.setInterval(() => {
      const now = Date.now();
      setInterviewQueueSynced((current) => current.map((item) => (
        item.submission?.state === "submitting"
          && item.submission.lastSentAt
          && now - item.submission.lastSentAt >= INTERVIEW_ACK_TIMEOUT_MS
          ? {
              ...item,
              submission: {
                ...item.submission,
                state: "retry",
                message: "No durable acknowledgement arrived yet. Retry when ready.",
              },
            }
          : item
      )));
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [setInterviewQueueSynced]);

  // ------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------

  const handleModelSelect = useCallback(
    async (nextValue: string) => {
      const previousValue = selectedModelValue;
      if (nextValue === previousValue) {
        setIsModelPickerOpen(false);
        return;
      }

      const parsed = parseModelSelectValue(nextValue);
      if (!activeSessionId || (!parsed && nextValue !== "")) {
        setSelectedModelValue(previousValue);
        return;
      }

      setSelectedModelValue(nextValue);
      setIsModelSaving(true);
      setIsModelPickerOpen(false);
      setModelError("");
      try {
        const updated = await updateSessionModelRequest(
          activeSessionId,
          parsed?.provider ?? null,
          parsed?.model ?? null,
        );
        onSessionUpdate?.(updated);
        onSessionChange?.();
        if (wsConnectedRef.current) sendWs({ type: "command_guard" });
      } catch (err: unknown) {
        setSelectedModelValue(previousValue);
        setModelError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsModelSaving(false);
      }
    },
    [activeSessionId, onSessionChange, onSessionUpdate, selectedModelValue, sendWs],
  );

  const handleAgentPreview = useCallback(async (profile: AgentProfileSummary) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || profile.id === effectiveAgentProfileId) {
      setIsAgentPickerOpen(false);
      return;
    }
    setIsAgentPickerOpen(false);
    setIsModelPickerOpen(false);
    setAgentError("");
    setIsAgentPreviewing(true);
    setAgentSwitchDialog({
      sessionId,
      targetProfileId: profile.id,
      targetName: profile.name,
      preview: null,
      error: "",
    });
    try {
      const preview = await previewSessionAgentSwitch(sessionId, profile.id);
      if (activeSessionIdRef.current !== sessionId) return;
      setAgentSwitchDialog((current) => current?.sessionId === sessionId && current.targetProfileId === profile.id
        ? { ...current, preview, error: "" }
        : current);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAgentSwitchDialog((current) => current?.sessionId === sessionId && current.targetProfileId === profile.id
        ? { ...current, error: message }
        : current);
    } finally {
      if (activeSessionIdRef.current === sessionId) setIsAgentPreviewing(false);
    }
  }, [effectiveAgentProfileId]);

  const handleAgentSwitchConfirm = useCallback(async () => {
    const pending = agentSwitchDialog;
    if (!pending?.preview || isAgentSwitching) return;
    setIsAgentSwitching(true);
    setAgentSwitchDialog((current) => current ? { ...current, error: "" } : current);
    try {
      const result = await switchSessionAgent(pending.sessionId, pending.targetProfileId);
      if (activeSessionIdRef.current === pending.sessionId) {
        // The backend's agent_switched runtime event reattaches this durable
        // WebSocket and sends fresh history with the same selection id. Keep
        // composer, attachment, and browser draft state untouched here.
        onSessionUpdate?.(result.session);
      }
      onSessionChange?.();
      setAgentSwitchDialog(null);
      setAgentError("");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAgentSwitchDialog((current) => current?.sessionId === pending.sessionId
        ? { ...current, error: message }
        : current);
    } finally {
      setIsAgentSwitching(false);
    }
  }, [agentSwitchDialog, isAgentSwitching, onSessionChange, onSessionUpdate]);

  const addAttachmentFiles = useCallback(async (files: File[] | FileList) => {
    const incomingFiles = Array.from(files);
    if (incomingFiles.length === 0) return;

    const remainingSlots = MAX_ATTACHMENTS - pendingAttachments.length;
    if (remainingSlots <= 0) {
      setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
      return;
    }

    const acceptedFiles = incomingFiles.slice(0, remainingSlots);
    const errors: string[] = [];
    if (incomingFiles.length > remainingSlots) {
      errors.push(`Only added ${remainingSlots} file(s); max ${MAX_ATTACHMENTS} per message.`);
    }

    const validFiles = acceptedFiles.filter((file) => {
      const mimeType = inferMimeType(file);
      const isImage = mimeType.startsWith("image/");
      if (isImage && !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
        errors.push(`${file.name || "Image"}: unsupported type ${mimeType || "unknown"}.`);
        return false;
      }
      if (isImage && file.size > MAX_IMAGE_BYTES && !COMPRESSIBLE_IMAGE_MIME_TYPES.has(mimeType)) {
        errors.push(`${file.name || "Image"}: ${formatAttachmentBytes(file.size)} exceeds ${formatAttachmentBytes(MAX_IMAGE_BYTES)}.`);
        return false;
      }
      if (!isImage && file.size > MAX_FILE_BYTES) {
        errors.push(`${file.name || "File"}: ${formatAttachmentBytes(file.size)} exceeds ${formatAttachmentBytes(MAX_FILE_BYTES)}.`);
        return false;
      }
      return true;
    });

    const attachments: PendingAttachment[] = [];
    let totalAcceptedBytes = pendingAttachments.reduce((total, attachment) => total + attachment.size, 0);
    for (const file of validFiles) {
      try {
        const attachment = await fileToPendingAttachment(file);
        if (totalAcceptedBytes + attachment.size > MAX_TOTAL_ATTACHMENT_BYTES) {
          errors.push(`${attachment.fileName || "File"}: total attachments exceed ${formatAttachmentBytes(MAX_TOTAL_ATTACHMENT_BYTES)}.`);
          continue;
        }
        totalAcceptedBytes += attachment.size;
        attachments.push(attachment);
      } catch (err: unknown) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    if (attachments.length > 0) {
      setPendingAttachments((prev) => [...prev, ...attachments]);
    }
    setAttachmentError(errors.join(" "));
  }, [pendingAttachments]);

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const attachmentFiles = Array.from(e.clipboardData.files);
    if (attachmentFiles.length === 0) return;
    if (!e.clipboardData.getData("text/plain")) {
      e.preventDefault();
    }
    void addAttachmentFiles(attachmentFiles);
  }, [addAttachmentFiles]);

  const handleSend = useCallback(async () => {
    const trimmed = inputText.trim();
    const attachments = pendingAttachments;
    if (isCompacting || (!trimmed && attachments.length === 0) || wsStatus !== "connected" || !activeSessionId) return;

    clearRuntimeError();
    const isFirstMessage = messages.length === 0;
    const queuedMessageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const queuedAttachments: PendingAttachment[] = attachments;
    const turnAnchorText = trimmed || (attachments.length > 0 ? "File attachment" : "");

    if (hasActiveAssistantOutput()) {
      setQueuedMessagesSynced((prev) => [
        ...prev,
        { id: queuedMessageId, content: trimmed, attachments: queuedAttachments },
      ]);
    } else {
      // Optimistically place the just-submitted user message in the timeline.
      // The backend echo/history will replace it later. This prevents live
      // event races where agent_start/agent_end arrives before the user echo,
      // making the prompt appear below the assistant until a refresh.
      setMessages((prev) => upsertUserMessage(prev, makeLocalPendingUserMessage(queuedMessageId, trimmed, queuedAttachments)));
      if (!scrollContainerRef.current || isScrolledToBottom(scrollContainerRef.current)) {
        pinActiveTurnScrollRef.current = true;
        setActiveTurnScrollAnchorText(turnAnchorText);
      } else {
        pinActiveTurnScrollRef.current = false;
        setActiveTurnScrollAnchorText(null);
      }
    }

    sendWs({
      type: "message",
      content: trimmed,
      attachments: attachments.map((attachment) => ({
        name: attachment.fileName,
        mimeType: attachment.mimeType,
        data: attachment.data,
        size: attachment.size,
      })),
    });
    onSessionChange?.();
    window.setTimeout(() => onSessionChange?.(), 500);
    persistChatDraft(activeSessionId, "");
    setInputText("");
    setPendingAttachments([]);
    setAttachmentError("");

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    // Auto-title after first message
    if (isFirstMessage && activeSessionId) {
      setTimeout(() => {
        refreshSessionTitle(activeSessionId)
          .then(() => onSessionChange?.())
          .catch(() => {});
      }, 2000);
    }
  }, [
    inputText,
    pendingAttachments,
    isCompacting,
    wsStatus,
    sendWs,
    activeSessionId,
    messages.length,
    onSessionChange,
    hasActiveAssistantOutput,
    setQueuedMessagesSynced,
    clearRuntimeError,
  ]);

  const handleResendMessage = useCallback((msg: ChatMessage) => {
    const messageId = typeof msg.id === "string" ? msg.id : null;
    if (!messageId || wsStatus !== "connected" || !activeSessionId || hasActiveAssistantOutput()) return;

    clearRuntimeError();
    clearQueuedAndDeferredUserMessages();
    setStreamingBlocksSynced({ content: [] });
    isStreamingRef.current = false;
    setIsStreaming(false);
    pinActiveTurnScrollRef.current = false;
    setActiveTurnScrollAnchorText(null);
    setResendingMessageId(messageId);
    sendWs({ type: "resend", message_id: messageId });
    onSessionChange?.();
    window.setTimeout(() => {
      setResendingMessageId((current) => current === messageId ? null : current);
    }, 1500);
  }, [
    activeSessionId,
    clearQueuedAndDeferredUserMessages,
    clearRuntimeError,
    hasActiveAssistantOutput,
    onSessionChange,
    sendWs,
    setStreamingBlocksSynced,
    wsStatus,
  ]);

  const handleInterrupt = useCallback(() => {
    const restoredQueuedMessages = restoreQueuedMessagesToComposer();
    sendWs({ type: "interrupt", clear_queue: restoredQueuedMessages });
  }, [restoreQueuedMessagesToComposer, sendWs]);

  const handleCommandGuardToggle = useCallback(() => {
    if (wsStatus !== "connected" || commandGuardSaving) return;
    const nextMode: CommandGuardMode = commandGuardState?.mode === "off" ? "balanced" : "off";
    if (nextMode === "off") {
      setActiveCommandGuardPinPrompt({
        prompt: "Identity PIN required to disable command guard",
        reason: "Disabling command guard is a high-impact safety-control change.",
        requestedMode: "off",
      });
      return;
    }
    setCommandGuardSaving(true);
    setCommandGuardState((prev) => ({
      ...(prev ?? { available: true }),
      available: prev?.available ?? true,
      mode: nextMode,
      source: "pending",
    }));
    sendWs({ type: "command_guard", mode: nextMode });
  }, [commandGuardSaving, commandGuardState?.mode, sendWs, wsStatus]);

  const handleInterviewSubmit = useCallback(
    (answers: InterviewAnswer[]) => {
      if (!activeInterview || activeInterview.submission) return;
      const submittedAt = Date.now();
      const next: QueuedInterview = {
        ...activeInterview,
        submission: { answers, submittedAt, state: "retry" },
      };
      // Write the browser-resilience copy before attempting WebSocket send.
      // It is intentionally per session and request, never a singleton slot.
      persistInterviewSubmission(next);
      setInterviewQueueSynced((current) => current.map((item) => (
        item.requestId === next.requestId && item.sessionId === next.sessionId ? next : item
      )));
      sendQueuedInterviewSubmission(next.requestId);
    },
    [activeInterview, sendQueuedInterviewSubmission, setInterviewQueueSynced],
  );

  const handleInterviewRetry = useCallback((requestId: string) => {
    sendQueuedInterviewSubmission(requestId);
  }, [sendQueuedInterviewSubmission]);

  const handleInterviewCancel = useCallback(() => {
    if (!activeInterview || activeInterview.submission) return;
    // Cancellation has its own terminal protocol message. An empty answer
    // array is invalid for a durable submission and must never masquerade as
    // a completed response.
    sendWs({
      type: "interview_cancel",
      requestId: activeInterview.requestId,
    });
    setInterviewQueueSynced((current) => current.filter((item) => (
      !(item.requestId === activeInterview.requestId && item.sessionId === activeInterview.sessionId)
    )));
  }, [activeInterview, sendWs, setInterviewQueueSynced]);

  const handleSudoSubmit = useCallback(
    (password: string) => {
      if (!activeSudoPrompt) return;
      sendWs({
        type: "sudo_response",
        requestId: activeSudoPrompt.requestId,
        password,
      });
      setActiveSudoPrompt(null);
    },
    [activeSudoPrompt, sendWs],
  );

  const handleSudoApprove = useCallback(() => {
    if (!activeSudoPrompt) return;
    sendWs({
      type: "sudo_response",
      requestId: activeSudoPrompt.requestId,
      approved: true,
    });
    setActiveSudoPrompt(null);
  }, [activeSudoPrompt, sendWs]);

  const handleSudoCancel = useCallback(() => {
    if (!activeSudoPrompt) return;
    sendWs({
      type: "sudo_response",
      requestId: activeSudoPrompt.requestId,
      cancelled: true,
    });
    setActiveSudoPrompt(null);
  }, [activeSudoPrompt, sendWs]);

  const handleCommandGuardPinSubmit = useCallback((pin: string) => {
    if (!activeCommandGuardPinPrompt) return;
    if (activeCommandGuardPinPrompt.requestId) {
      sendWs({
        type: "command_guard_pin_response",
        requestId: activeCommandGuardPinPrompt.requestId,
        pin,
      });
    } else if (activeCommandGuardPinPrompt.requestedMode) {
      setCommandGuardSaving(true);
      sendWs({ type: "command_guard", mode: activeCommandGuardPinPrompt.requestedMode, pin });
    }
    setActiveCommandGuardPinPrompt(null);
  }, [activeCommandGuardPinPrompt, sendWs]);

  const handleCommandGuardPinCancel = useCallback(() => {
    if (!activeCommandGuardPinPrompt) return;
    if (activeCommandGuardPinPrompt.requestId) {
      sendWs({
        type: "command_guard_pin_response",
        requestId: activeCommandGuardPinPrompt.requestId,
        cancelled: true,
      });
    }
    setActiveCommandGuardPinPrompt(null);
    setCommandGuardSaving(false);
  }, [activeCommandGuardPinPrompt, sendWs]);

  const handleSetGoal = useCallback(() => {
    const trimmed = goalInput.trim();
    if (!trimmed || !activeSessionId) return;

    sendWs({ type: "set_goal", goal: trimmed, status: "pending" });
    updateSessionGoal(activeSessionId, trimmed, "pending").catch(() => {});
    setGoalInput("");
    setShowGoalInput(false);
    onSessionChange?.();
  }, [goalInput, activeSessionId, sendWs, onSessionChange]);

  const slashContext = useMemo(() => parseSlashAutocomplete(inputText), [inputText]);

  const slashSuggestions = useMemo(() => {
    if (!slashContext) return [];
    if (slashContext.mode === "command") {
      return slashCommands
        .filter((command) => fuzzyIncludes(command.name, slashContext.prefix))
        .slice(0, 12)
        .map((command) => ({ type: "command" as const, command }));
    }

    const command = slashCommands.find((candidate) => candidate.name === slashContext.commandName);
    const rawSuggestions = command?.name === "model"
      ? modelArgumentSuggestions(modelOptions)
      : command?.argumentSuggestions ?? [];
    return rawSuggestions
      .filter((suggestion) => fuzzyIncludes(`${suggestion.value} ${suggestion.label} ${suggestion.description ?? ""}`, slashContext.argumentPrefix))
      .slice(0, 12)
      .map((argument) => ({ type: "argument" as const, argument, command }));
  }, [modelOptions, slashCommands, slashContext]);

  const showSlashAutocomplete = slashAutocompleteOpen && slashSuggestions.length > 0;

  useEffect(() => {
    if (!slashContext || slashSuggestions.length === 0) {
      setSlashAutocompleteOpen(false);
      setSlashAutocompleteIndex(0);
      return;
    }
    setSlashAutocompleteOpen(true);
    setSlashAutocompleteIndex((index) => Math.min(index, slashSuggestions.length - 1));
  }, [slashContext, slashSuggestions.length]);

  const resizeComposer = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const applySlashSuggestion = useCallback(
    (index = slashAutocompleteIndex) => {
      if (!slashContext || slashSuggestions.length === 0) return;
      const suggestion = slashSuggestions[Math.max(0, Math.min(index, slashSuggestions.length - 1))];
      if (!suggestion) return;

      if (suggestion.type === "command") {
        const nextText = `/${suggestion.command.name} `;
        setInputText(nextText);
        persistChatDraft(activeSessionId, nextText);
      } else if (slashContext.mode === "argument") {
        const nextText = `${inputText.slice(0, slashContext.argumentStart)}${suggestion.argument.value}`;
        setInputText(nextText);
        persistChatDraft(activeSessionId, nextText);
      }
      setSlashAutocompleteOpen(false);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        resizeComposer();
      });
    },
    [activeSessionId, inputText, resizeComposer, slashAutocompleteIndex, slashContext, slashSuggestions],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSlashAutocomplete) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashAutocompleteIndex((index) => (index + 1) % slashSuggestions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashAutocompleteIndex((index) => (index - 1 + slashSuggestions.length) % slashSuggestions.length);
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          applySlashSuggestion();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashAutocompleteOpen(false);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [applySlashSuggestion, handleSend, showSlashAutocomplete, slashSuggestions.length],
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInputText(e.target.value);
      persistChatDraft(activeSessionId, e.target.value);
      const ta = e.target;
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    },
    [activeSessionId],
  );

  const handleMessagesScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const distance = getScrollDistanceFromBottom(container);
    setShowScrollToBottom(distance > BOTTOM_SCROLL_TOLERANCE_PX);

    // Let a deliberate user scroll opt out of prompt-top pinning.
    if (pinActiveTurnScrollRef.current && Date.now() - lastProgrammaticScrollAtRef.current > 200) {
      const activePrompt = activeTurnUserMessageRef.current;
      if (activePrompt) {
        const promptTop = activePrompt.getBoundingClientRect().top;
        const containerTop = container.getBoundingClientRect().top;
        if (Math.abs(promptTop - containerTop) > 80) {
          pinActiveTurnScrollRef.current = false;
        }
      }
    }
  }, []);

  // ------------------------------------------------------------------
  // Status
  // ------------------------------------------------------------------

  const statusDot = (() => {
    switch (wsStatus) {
      case "connected":
        return "bg-green-500";
      case "connecting":
        return "bg-yellow-500 animate-pulse";
      case "disconnected":
        return "bg-red-500";
    }
  })();

  const allowedAgentIds = activeProject?.access_policy.allowed_agent_profile_ids ?? null;
  const availableAgentProfiles = agentProfiles.filter((profile) => (
    profile.enabled && (!allowedAgentIds || allowedAgentIds.includes(profile.id))
  ));
  const currentAgentProfile = agentProfiles.find((profile) => profile.id === effectiveAgentProfileId) ?? null;
  const currentAgentLabel = currentAgentProfile?.name ?? (effectiveAgentProfileId ? "Unknown agent" : "Project default");
  // TTS authorization is backend-owned. Display names and profile labels never
  // determine whether a runtime may use it; rejected calls surface normally.
  const ttsAllowed = true;

  const selectedModelKnown =
    !selectedModelValue ||
    modelOptions.some(
      (model) => selectedModelValue === modelSelectValue(model.provider, model.id),
    );
  const selectedModelLabel = modelDisplayLabel(
    modelOptions,
    selectedModelValue,
    defaultModel,
  );
  const filteredModelOptions = useMemo(
    () => modelOptions.filter((model) => modelMatchesQuery(model, modelQuery)),
    [modelOptions, modelQuery],
  );
  const visibleTodos = todoState.todos;
  const activeTodoCount = visibleTodos.filter(
    (todo) => todo.status !== "done" && todo.status !== "cancelled",
  ).length;
  const commandGuardMode = commandGuardState?.mode ?? "unknown";
  const commandGuardAvailable = commandGuardState?.available ?? true;
  const commandGuardIsOff = commandGuardMode === "off";
  const commandGuardLabel = commandGuardAvailable
    ? commandGuardMode === "unknown"
      ? "guard"
      : commandGuardIsOff
        ? "guard off"
        : "guard on"
    : "guard unavailable";
  const commandGuardRoute = commandGuardState?.modelRoute?.length
    ? `\nModel route: ${commandGuardState.modelRoute.join(" → ")}`
    : "";
  const commandGuardTitle = commandGuardState?.error
    || (commandGuardMode === "unknown"
      ? "Toggle command guard for this live session"
      : `Command guard: ${commandGuardMode}${commandGuardState?.source ? ` (${commandGuardState.source})` : ""}${commandGuardRoute}`);

  // Streaming content for live rendering
  const hasStreamingContent = streamingBlocks.content.length > 0;
  const isAgentRunning = isStreaming || hasStreamingContent || isCompacting;
  const isTranscriptLoading = !transcriptOwnedBySelection || isSessionHistoryLoading || wsStatus === "connecting";
  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  if (!activeSessionId) {
    return (
      <section className="h-full flex flex-col bg-neutral-950">
        <div className="flex-1 flex items-center justify-center text-neutral-600 text-sm font-mono px-4 text-center">
          Select a session or create a new one
        </div>
      </section>
    );
  }

  return (
    <section className="h-full flex flex-col bg-neutral-950 text-neutral-100">
      {/* ---- Top bar ---- */}
      <header className="min-h-10 px-4 py-2 flex flex-col gap-1 border-b border-neutral-800 shrink-0">
        <div className="flex w-full items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono text-neutral-400 truncate">
            {activeSession?.cwd || "…"}
          </span>
          {currentGoal && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded border truncate max-w-[200px] ${
                currentGoalStatus === "completed"
                  ? "border-green-800 text-green-400"
                  : currentGoalStatus === "in_progress"
                    ? "border-blue-800 text-blue-400"
                    : "border-yellow-800 text-yellow-400"
              }`}
              title={currentGoal}
            >
              {currentGoal.slice(0, 40)}
              {currentGoal.length > 40 ? "…" : ""}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowGoalInput((v) => !v)}
            className="text-[10px] text-neutral-500 hover:text-neutral-300 px-1 py-0.5 rounded hover:bg-neutral-800"
            title="Set goal"
          >
            {currentGoal ? "✎" : "+goal"}
          </button>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                if (isAgentRunning || isAgentSwitching) return;
                setIsModelPickerOpen(false);
                setIsAgentPickerOpen((open) => !open);
              }}
              disabled={isAgentRunning || isAgentSwitching || availableAgentProfiles.length === 0}
              aria-haspopup="listbox"
              aria-expanded={isAgentPickerOpen}
              title={agentError || "Agent identity and runtime policy for future turns"}
              className={`max-w-28 truncate rounded-full border bg-neutral-900 px-2 py-0.5 text-left text-xs outline-none hover:border-neutral-600 focus:border-blue-600 disabled:cursor-not-allowed disabled:opacity-60 sm:max-w-44 ${agentError ? "border-red-900/70 text-red-300" : "border-neutral-700 text-neutral-200"}`}
            >
              {activeProject?.access_policy.privacy_mode === "protected" ? "🔒 " : ""}{currentAgentLabel}
            </button>
            {isAgentPickerOpen && (
              <div className="absolute right-0 top-7 z-50 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 shadow-2xl">
                <div className="border-b border-neutral-800 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                  Switch agent
                </div>
                <div role="listbox" aria-label="Allowed agent profiles" className="max-h-72 overflow-y-auto p-1">
                  {availableAgentProfiles.map((profile) => {
                    const selected = profile.id === effectiveAgentProfileId;
                    return (
                      <button
                        key={profile.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        disabled={selected}
                        onClick={() => void handleAgentPreview(profile)}
                        className={`block w-full rounded px-2 py-2 text-left disabled:cursor-default ${selected ? "bg-blue-950/60 text-blue-200" : "text-neutral-200 hover:bg-neutral-800"}`}
                      >
                        <span className="block truncate text-xs font-medium">{profile.name}{selected ? " — current" : ""}</span>
                        <span className="block truncate text-[10px] text-neutral-500">
                          Memory: {profile.memory_access === "read_write" ? "read/write" : profile.memory_access === "read" ? "read only" : "none"}
                        </span>
                      </button>
                    );
                  })}
                  {availableAgentProfiles.length <= 1 && (
                    <p className="px-2 py-3 text-xs leading-relaxed text-neutral-500">No other enabled agent is allowed for this project.</p>
                  )}
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleCommandGuardToggle}
            disabled={wsStatus !== "connected" || commandGuardSaving}
            title={commandGuardTitle}
            className={`rounded border px-2 py-0.5 text-xs font-mono disabled:cursor-not-allowed disabled:opacity-60 ${
              !commandGuardAvailable
                ? "border-neutral-800 bg-neutral-900 text-neutral-500"
                : commandGuardIsOff
                  ? "border-amber-900/70 bg-amber-950/30 text-amber-300 hover:bg-amber-950/50"
                  : "border-emerald-900/70 bg-emerald-950/30 text-emerald-300 hover:bg-emerald-950/50"
            }`}
          >
            {commandGuardSaving ? "guard…" : commandGuardLabel}
          </button>
          {isAgentRunning && (
            <button
              type="button"
              data-testid="chat-interrupt-button"
              className="rounded border border-red-900/70 bg-red-950/30 px-2 py-0.5 text-xs font-mono text-red-300 hover:bg-red-950/50 hover:text-red-200"
              onClick={handleInterrupt}
              title="Interrupt the running agent turn"
            >
              Interrupt
            </button>
          )}
          {modelOptions.length > 0 && (
            <div className="relative flex items-center gap-1 text-xs text-neutral-500">
              <span className="hidden sm:inline">model:</span>
              <button
                type="button"
                onClick={() => {
                  if (isAgentRunning || isModelSaving) return;
                  setIsAgentPickerOpen(false);
                  setModelQuery("");
                  setIsModelPickerOpen((open) => !open);
                }}
                disabled={isAgentRunning || isModelSaving}
                title={modelError || "Model used for future turns"}
                className="max-w-64 truncate rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-left text-xs text-neutral-200 outline-none hover:border-neutral-700 focus:border-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {selectedModelLabel}
              </button>
              {isModelPickerOpen && (
                <div className="absolute right-0 top-7 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-neutral-700 bg-neutral-950 shadow-2xl">
                  <div className="border-b border-neutral-800 p-2">
                    <input
                      type="text"
                      value={modelQuery}
                      onChange={(e) => setModelQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setIsModelPickerOpen(false);
                      }}
                      placeholder="Search models by name, provider, or id..."
                      className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-blue-600"
                      autoFocus
                    />
                  </div>
                  <div className="max-h-80 overflow-y-auto p-1">
                    {!selectedModelKnown && selectedModelValue && (
                      <button
                        type="button"
                        className="block w-full rounded px-2 py-2 text-left text-xs text-neutral-200 hover:bg-neutral-800"
                        onClick={() => void handleModelSelect(selectedModelValue)}
                      >
                        Current session model
                      </button>
                    )}
                    <button
                      type="button"
                      className={`block w-full rounded px-2 py-2 text-left text-xs ${
                        selectedModelValue === ""
                          ? "bg-blue-950/60 text-blue-200"
                          : "text-neutral-200 hover:bg-neutral-800"
                      }`}
                      onClick={() => void handleModelSelect("")}
                    >
                      {defaultModel ? `default (${defaultModel.name || defaultModel.id})` : "default"}
                    </button>
                    {filteredModelOptions.length === 0 ? (
                      <div className="px-2 py-4 text-center text-xs text-neutral-500">
                        No models match “{modelQuery}”.
                      </div>
                    ) : (
                      Array.from(new Set(filteredModelOptions.map((model) => model.provider))).map(
                        (provider) => (
                          <div key={provider} className="py-1">
                            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                              {provider}
                            </div>
                            {filteredModelOptions
                              .filter((model) => model.provider === provider)
                              .map((model) => {
                                const value = modelSelectValue(model.provider, model.id);
                                const selected = value === selectedModelValue;
                                return (
                                  <button
                                    key={`${model.provider}:${model.id}`}
                                    type="button"
                                    disabled={!model.available}
                                    onClick={() => void handleModelSelect(value)}
                                    className={`block w-full rounded px-2 py-1.5 text-left text-xs disabled:cursor-not-allowed disabled:opacity-45 ${
                                      selected
                                        ? "bg-blue-950/60 text-blue-200"
                                        : "text-neutral-200 hover:bg-neutral-800"
                                    }`}
                                  >
                                    <span className="block truncate font-medium">
                                      {model.name || model.id}
                                      {!model.available ? " — no key" : ""}
                                    </span>
                                    <span className="block truncate font-mono text-[10px] text-neutral-500">
                                      {model.provider}/{model.id}
                                    </span>
                                  </button>
                                );
                              })}
                          </div>
                        ),
                      )
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          {contextUsage && contextUsage.contextWindow > 0 && (
            <div
              className="group relative flex items-center gap-1.5"
              title={
                contextUsage.tokens != null && contextUsage.percent != null
                  ? `${contextUsage.tokens.toLocaleString()} / ${contextUsage.contextWindow.toLocaleString()} tokens (${contextUsage.percent.toFixed(1)}%)`
                  : contextUsage.tokens != null
                    ? `${contextUsage.tokens.toLocaleString()} tokens (window: ${contextUsage.contextWindow.toLocaleString()})`
                    : `Context window: ${contextUsage.contextWindow.toLocaleString()} tokens`
              }
            >
              {/* Progress bar track */}
              <div className="w-16 h-2 bg-neutral-800 rounded-full overflow-hidden border border-neutral-700">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    (contextUsage.percent ?? 0) > 90
                      ? "bg-red-500"
                      : (contextUsage.percent ?? 0) > 70
                        ? "bg-yellow-500"
                        : (contextUsage.percent ?? 0) > 0
                          ? "bg-green-500"
                          : "bg-transparent"
                  }`}
                  style={{
                    width: `${Math.min(contextUsage.percent ?? 0, 100)}%`,
                  }}
                />
              </div>
              {/* Percentage label */}
              <span
                className={`text-[10px] font-mono ${
                  (contextUsage.percent ?? 0) > 90
                    ? "text-red-400"
                    : (contextUsage.percent ?? 0) > 70
                      ? "text-yellow-400"
                      : "text-neutral-400"
                }`}
              >
                {contextUsage.percent != null
                  ? `${Math.round(contextUsage.percent)}%`
                  : "—"}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5 text-xs text-neutral-500">
            <div className={`w-2 h-2 rounded-full ${statusDot}`} />
            <span className="font-mono">{isCompacting ? "compacting" : wsStatus}</span>
          </div>
        </div>
        </div>
        <BashModeStatus mode={bashMode} />
        {visibleTodos.length > 0 && (
          <div className="flex min-w-0 items-center gap-2 pl-0 sm:pl-0">
            <TodoStatusPanel
              todos={visibleTodos}
              source={todoState.source}
              open={isTodoPanelOpen}
              onToggle={() => setIsTodoPanelOpen((open) => !open)}
            />
            <span className="truncate text-[11px] text-neutral-600">
              {activeTodoCount === 0
                ? "Checklist complete"
                : `${activeTodoCount} pending for this session`}
            </span>
          </div>
        )}
      </header>

      {runtimeError && (
        <div
          data-testid="chat-runtime-error"
          className="border-b border-red-900/70 bg-red-950/40 px-4 py-3 text-sm text-red-100"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-red-300">
                Session error
              </div>
              <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-red-100">{runtimeError.message}</pre>
            </div>
            <button
              type="button"
              onClick={() => setRuntimeError(null)}
              className="shrink-0 rounded border border-red-800/70 px-2 py-1 text-xs text-red-200 hover:bg-red-900/50"
              aria-label="Dismiss session error"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* ---- Goal input ---- */}
      {showGoalInput && (
        <div className="px-4 py-2 border-b border-neutral-800 bg-neutral-900/50 flex gap-2">
          <input
            type="text"
            className="flex-1 bg-neutral-800 text-sm text-neutral-100 rounded px-2 py-1 border border-neutral-700 focus:outline-none focus:border-blue-500"
            placeholder="Set a goal for this session..."
            value={goalInput}
            onChange={(e) => setGoalInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSetGoal();
              if (e.key === "Escape") setShowGoalInput(false);
            }}
            autoFocus
          />
          <button
            type="button"
            onClick={handleSetGoal}
            className="px-3 py-1 text-xs font-medium rounded bg-blue-700 hover:bg-blue-600 text-white"
          >
            Set
          </button>
          <button
            type="button"
            onClick={() => setShowGoalInput(false)}
            className="px-3 py-1 text-xs rounded text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800"
          >
            Cancel
          </button>
        </div>
      )}

      {/* ---- Message list ---- */}
      <div
        ref={scrollContainerRef}
        data-testid="chat-message-list"
        data-transcript-state={isTranscriptLoading ? "loading" : visibleMessageStart > 0 ? "hydrating" : "ready"}
        data-visible-message-start={visibleMessageStart}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-3"
        onScroll={handleMessagesScroll}
      >
        {displayMessages.length === 0 && deferredUserMessages.length === 0 && !hasStreamingContent && !activeInterview && !activeSudoPrompt && !activeCommandGuardPinPrompt && (
          <div data-testid={isTranscriptLoading ? "chat-loading-shell" : undefined} className="flex items-center justify-center h-full text-neutral-600 text-sm font-mono">
            {isTranscriptLoading ? "Loading session…" : "No messages yet"}
          </div>
        )}
        {displayMessages.map((msg, i) => {
          const messageId = typeof msg.id === "string" ? msg.id : null;
          const userMessageText = getUserMessageText(msg.message);
          const isActiveTurnUserMessage = Boolean(
            activeTurnScrollAnchorText
              && msg.type === "user"
              && (
                userMessageText === activeTurnScrollAnchorText
                || userMessageText.startsWith(activeTurnScrollAnchorText)
                || (activeTurnScrollAnchorText === "File attachment" && (getUserMessageImages(msg.message).length > 0 || userMessageText.includes("<file name=")))
              ),
          );
          const anchorAttrs = messageId ? { "data-message-id": messageId, id: `msg-${messageId}` } : undefined;
          if (isActiveTurnUserMessage) {
            return (
              <div key={messageId ?? `active-turn-user-${i}`} ref={activeTurnUserMessageRef} {...anchorAttrs}>
                {renderMessage(msg, i, {
                  canResendUserMessage: wsStatus === "connected" && !isAgentRunning,
                  resendingMessageId,
                  onResendUserMessage: handleResendMessage,
                  sessionId: activeSessionId,
                  ttsAllowed,
                })}
              </div>
            );
          }
          return (
            <MemoizedMessageRow
              key={messageId ?? `msg-${i}`}
              msg={msg}
              canResendUserMessage={wsStatus === "connected" && !isAgentRunning}
              resendingMessageId={resendingMessageId}
              onResendUserMessage={handleResendMessage}
              sessionId={activeSessionId}
              ttsAllowed={ttsAllowed}
            />
          );
        })}

        {/* Live streaming content */}
        {hasStreamingContent && (
          <div data-testid="chat-streaming" data-role="assistant" className="px-4 py-3 bg-neutral-900 rounded-lg border border-blue-900/30">
            <div className="text-[10px] uppercase tracking-wider text-blue-400 mb-1 font-semibold">
              Streaming...
            </div>
            <div className="space-y-2">
              {renderAssistantContentBlocks(streamingBlocks.content)}
            </div>
          </div>
        )}

        {/* Accepted next-turn user messages wait behind the active assistant turn. */}
        {deferredUserMessages.map((msg, i) => (
          <div key={`deferred-user-${i}`}>{renderMessage(msg, i, { sessionId: activeSessionId })}</div>
        ))}

        <div ref={scrollAnchorRef} />

        {/* Scroll-to-bottom button */}
        {showScrollToBottom && (
          <div className="sticky bottom-3 flex justify-center z-10">
            <button
              type="button"
              onClick={() => {
                scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
                setShowScrollToBottom(false);
              }}
              className="bg-neutral-800 hover:bg-neutral-700 text-neutral-400
                rounded-full w-9 h-9 flex items-center justify-center shadow-lg
                border border-neutral-700 transition-all hover:text-neutral-200
                hover:border-neutral-600"
              aria-label="Scroll to bottom"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14" />
                <path d="m19 12-7 7-7-7" />
              </svg>
            </button>
          </div>
        )}
      </div>

      <QueuedUserMessages messages={queuedUserMessages} />

      {/* ---- Interactive prompts: never persisted into chat history ---- */}
      {activeInterview && (
        <div data-testid="interview-queue" className="shrink-0 border-t border-blue-900/40 bg-neutral-950 px-3 py-2">
          {visibleInterviews.length > 1 && (
            <div className="mb-2 text-xs text-blue-300">
              Questionnaire {1} of {visibleInterviews.length}
            </div>
          )}
          <InterviewForm
            key={activeInterview.requestId}
            questions={activeInterview.questions}
            onSubmit={handleInterviewSubmit}
            onCancel={handleInterviewCancel}
            submissionState={activeInterview.submission?.state}
            submissionMessage={activeInterview.submission?.message}
            onRetry={activeInterview.submission ? () => handleInterviewRetry(activeInterview.requestId) : undefined}
            storageKey={interviewDraftStorageKey(activeInterview.requestId)}
          />
        </div>
      )}
      {activeSudoPrompt && (
        <div className="shrink-0 border-t border-amber-900/50 bg-neutral-950 px-3 py-2">
          <SudoPrompt
            key={activeSudoPrompt.requestId}
            prompt={activeSudoPrompt.prompt}
            kind={activeSudoPrompt.kind}
            command={activeSudoPrompt.command}
            executable={activeSudoPrompt.executable}
            argv={activeSudoPrompt.argv}
            cwd={activeSudoPrompt.cwd}
            timeoutMs={activeSudoPrompt.timeoutMs}
            origin={activeSudoPrompt.origin}
            onSubmit={handleSudoSubmit}
            onApprove={handleSudoApprove}
            onCancel={handleSudoCancel}
          />
        </div>
      )}
      {activeCommandGuardPinPrompt && (
        <div className="shrink-0 border-t border-red-900/50 bg-neutral-950 px-3 py-2">
          <CommandGuardPinPrompt
            key={activeCommandGuardPinPrompt.requestId}
            prompt={activeCommandGuardPinPrompt.prompt}
            command={activeCommandGuardPinPrompt.command}
            reason={activeCommandGuardPinPrompt.reason}
            onSubmit={handleCommandGuardPinSubmit}
            onCancel={handleCommandGuardPinCancel}
          />
        </div>
      )}

      {/* ---- Input bar ---- */}
      <div className="border-t border-neutral-800 px-3 py-2 shrink-0">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.currentTarget.files) void addAttachmentFiles(e.currentTarget.files);
            e.currentTarget.value = "";
          }}
        />
        {pendingAttachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingAttachments.map((attachment) => (
              <div key={attachment.id} className="group relative overflow-hidden rounded border border-neutral-700 bg-neutral-900">
                {attachment.kind === "image" && attachment.previewUrl ? (
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.fileName}
                    title={`${attachment.fileName} (${formatAttachmentBytes(attachment.size)})`}
                    className="h-16 w-16 object-cover"
                  />
                ) : (
                  <div
                    title={`${attachment.fileName} (${formatAttachmentBytes(attachment.size)})`}
                    className="flex h-16 w-40 items-center gap-2 px-2 text-xs text-neutral-300"
                  >
                    <span className="text-lg">📄</span>
                    <span className="min-w-0 flex-1 truncate">{attachment.fileName}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removePendingAttachment(attachment.id)}
                  className="absolute right-0.5 top-0.5 rounded bg-neutral-950/80 px-1 text-xs text-neutral-300 opacity-90 hover:bg-red-900 hover:text-white"
                  aria-label={`Remove ${attachment.fileName}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {attachmentError && (
          <div className="mb-2 text-xs text-amber-300">{attachmentError}</div>
        )}
        <div className="relative flex items-end gap-2">
          {showSlashAutocomplete && (
            <div className="absolute bottom-full left-0 z-50 mb-2 w-[min(44rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 shadow-2xl">
              <div className="border-b border-neutral-800 px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider text-neutral-500">
                Slash commands
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {slashSuggestions.map((suggestion, index) => {
                  const selected = index === slashAutocompleteIndex;
                  const key = suggestion.type === "command"
                    ? `command:${suggestion.command.name}`
                    : `argument:${suggestion.argument.value}`;
                  const label = suggestion.type === "command"
                    ? `/${suggestion.command.name}`
                    : suggestion.argument.label;
                  const value = suggestion.type === "command"
                    ? suggestion.command.argumentHint
                    : suggestion.argument.value;
                  const description = suggestion.type === "command"
                    ? suggestion.command.description
                    : suggestion.argument.description;
                  const source = suggestion.type === "command"
                    ? suggestion.command.source
                    : suggestion.command?.name;
                  return (
                    <button
                      key={key}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applySlashSuggestion(index);
                      }}
                      className={`flex w-full items-start gap-3 px-3 py-2 text-left text-sm ${
                        selected ? "bg-blue-900/50 text-blue-100" : "text-neutral-200 hover:bg-neutral-900"
                      }`}
                    >
                      <span className="w-44 shrink-0 truncate font-mono text-xs text-blue-300">{label}</span>
                      <span className="min-w-0 flex-1">
                        {value && <span className="mr-2 font-mono text-xs text-neutral-400">{value}</span>}
                        {description && <span className="text-xs text-neutral-500">{description}</span>}
                      </span>
                      {source && <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] uppercase text-neutral-600">{source}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <button
            type="button"
            className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-300 hover:border-neutral-600 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={wsStatus !== "connected" || pendingAttachments.length >= MAX_ATTACHMENTS}
            onClick={() => fileInputRef.current?.click()}
            title="Attach images, PDFs, .eml, or other files"
          >
            📎
          </button>
          <textarea
            ref={textareaRef}
            data-testid="chat-input"
            className="flex-1 bg-neutral-900 text-sm text-neutral-100 rounded-lg px-3 py-2 resize-none border border-neutral-700 focus:outline-none focus:border-blue-500 placeholder-neutral-600"
            rows={1}
            placeholder={
              isAgentRunning
                ? "Type your next message or paste an image/file..."
                : "Type a message or paste an image/file..."
            }
            value={inputText}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={wsStatus !== "connected"}
          />
          {isAgentRunning && (
            <button
              type="button"
              data-testid="chat-composer-interrupt-button"
              className="rounded-lg border border-red-900/70 bg-red-950/40 px-3 py-2 text-sm font-semibold text-red-200 hover:bg-red-900/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              disabled={wsStatus !== "connected"}
              onClick={handleInterrupt}
              title="Interrupt the running agent turn"
            >
              Interrupt
            </button>
          )}
          <button
            type="button"
            data-testid="chat-send-button"
            className={`px-4 py-2 text-sm font-semibold rounded-lg text-white disabled:opacity-40 disabled:cursor-not-allowed ${
              isAgentRunning && (inputText.trim() || pendingAttachments.length > 0)
                ? "bg-amber-700 hover:bg-amber-600"
                : "bg-blue-700 hover:bg-blue-600"
            }`}
            disabled={isCompacting || (!inputText.trim() && pendingAttachments.length === 0) || wsStatus !== "connected"}
            onClick={handleSend}
          >
            {isAgentRunning ? "Queue" : "Send"}
          </button>
        </div>
      </div>

      {agentSwitchDialog && (
        <AgentSwitchDialog
          state={agentSwitchDialog}
          previewing={isAgentPreviewing}
          switching={isAgentSwitching}
          onCancel={() => {
            if (!isAgentSwitching) setAgentSwitchDialog(null);
          }}
          onConfirm={() => void handleAgentSwitchConfirm()}
        />
      )}

    </section>
  );
}
