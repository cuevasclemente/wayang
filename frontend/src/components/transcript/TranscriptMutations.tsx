import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, FileJson, ListTree, Pencil, Settings2, Trash2, X } from "lucide-react";
import {
  ApiError,
  apiErrorCode,
  deleteTranscriptEvent,
  editTranscriptEvent,
  fetchTranscriptEvent,
  fetchTranscriptEvents,
  type TranscriptEvent,
  type TranscriptEventWarning,
  type TranscriptMutationOperation,
} from "../../api/client";
import {
  reconstructTranscriptEntry,
  type TranscriptMutationMarkerValue,
} from "./transcriptMutationHelpers";

const MAX_ADVANCED_PAYLOAD_CHARS = 100_000;
const MAX_PREVIEW_CHARS = 12_000;
const INSPECTOR_PAGE_SIZE = 40;
const CONFLICT_CODES = new Set(["cas_conflict"]);

type MutationMarker = TranscriptMutationMarkerValue;

export interface TranscriptEventRowSummary {
  eventId: string;
  label: string;
  preview?: string;
  marker?: Exclude<MutationMarker, "partially modified" | null>;
}

interface MutationAvailability {
  available: boolean;
  reason: string;
}

interface TranscriptMutationContextValue {
  availability: MutationAvailability;
  openManage: (summaries: TranscriptEventRowSummary[], trigger: HTMLButtonElement) => void;
  openInspector: (trigger: HTMLButtonElement) => void;
}

const TranscriptMutationContext = createContext<TranscriptMutationContextValue | null>(null);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function TranscriptMutationMarker({ marker }: { marker: MutationMarker }) {
  if (!marker) return null;
  const testMarker = marker === "partially modified" ? "partial" : marker;
  return (
    <span
      data-testid={`transcript-event-${testMarker}-marker`}
      className="text-[10px] font-normal lowercase tracking-normal text-neutral-500"
      title={marker === "deleted" ? "This persisted event was deleted" : marker === "edited" ? "This persisted event was edited" : "Some events in this rendered group were modified"}
    >
      · {marker}
    </span>
  );
}

function errorMessage(error: unknown): string {
  const code = apiErrorCode(error);
  if (code === "pin_cooldown" || code === "cooldown") return "PIN verification is cooling down. Wait, then enter the PIN again.";
  if (code === "invalid_pin" || code === "wrong_pin" || code === "pin_invalid") return "The identity PIN was not accepted.";
  if (code === "event_not_found") return "This persisted event is no longer available.";
  if (code === "runtime_busy" || code === "session_mutable") return "The session changed while this dialog was open. Wait for an idle, authoritative transcript and review again.";
  if (error instanceof ApiError) return error.message || `The request failed (HTTP ${error.status}).`;
  return error instanceof Error ? error.message : "The request failed unexpectedly.";
}

function isAmbiguousMutationError(error: unknown): boolean {
  if (apiErrorCode(error) === "reindex_failed") return true;
  if (error instanceof ApiError) return error.status === 0 || error.status >= 500;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof TypeError;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "null";
  }
}

function bounded(value: string, limit = MAX_PREVIEW_CHARS): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… (${(value.length - limit).toLocaleString()} more characters)`;
}

interface FriendlyEditor {
  text: string;
  buildPayload: (text: string) => unknown;
}

function friendlyEditorForPayload(payload: unknown): FriendlyEditor | null {
  if (typeof payload === "string") return { text: payload, buildPayload: (text) => text };
  const outer = record(payload);
  if (!outer) return null;
  if (typeof outer.content === "string") {
    return { text: outer.content, buildPayload: (text) => ({ ...outer, content: text }) };
  }
  if (Array.isArray(outer.content) && outer.content.length === 1) {
    const block = record(outer.content[0]);
    if (block?.type === "text" && typeof block.text === "string") {
      return { text: block.text, buildPayload: (text) => ({ ...outer, content: [{ ...block, text }] }) };
    }
  }
  const nested = friendlyEditorForPayload(outer.message);
  return nested
    ? { text: nested.text, buildPayload: (text) => ({ ...outer, message: nested.buildPayload(text) }) }
    : null;
}

function inferredWarnings(event: TranscriptEvent, advanced: boolean): TranscriptEventWarning[] {
  const warnings = [...event.warnings];
  const friendly = friendlyEditorForPayload(event.payload);
  if (!friendly || advanced) {
    warnings.push({
      code: advanced ? "advanced_json" : "structured_event",
      message: advanced
        ? "Advanced JSON editing can change the event structure. Preserve the exact payload shape expected by Pi and extensions."
        : "This structured event may participate in tool, extension, or session semantics.",
      requires_acknowledgement: true,
    });
  }
  if (/tool|command|bash|browser|external|approval|sudo/i.test(event.event_type)) {
    warnings.push({
      code: "external_side_effect",
      message: "Changing this record cannot undo commands, browser actions, messages, or other external side effects that already happened.",
      requires_acknowledgement: true,
    });
  }
  return [...new Map(warnings.map((warning) => [`${warning.code}\0${warning.message}`, warning])).values()];
}

function restoreFocus(trigger: HTMLElement | null): void {
  window.requestAnimationFrame(() => {
    if (trigger?.isConnected && (!(trigger instanceof HTMLButtonElement) || !trigger.disabled)) {
      trigger.focus();
      return;
    }
    const modalFallback = document.querySelector<HTMLElement>("[data-testid=transcript-event-manager] button:not(:disabled), [data-testid=transcript-event-inspector] button:not(:disabled)");
    (modalFallback ?? document.querySelector<HTMLElement>("[data-testid=chat-input]"))?.focus();
  });
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), details > summary, [tabindex]:not([tabindex='-1'])",
  )].filter((element) => !element.closest("[inert]") && element.getClientRects().length > 0);
}

function ModalFrame({
  testId,
  labelledBy,
  suspended = false,
  closeDisabled = false,
  onClose,
  initialFocusRef,
  children,
  zClass = "z-[70]",
}: {
  testId: string;
  labelledBy: string;
  suspended?: boolean;
  closeDisabled?: boolean;
  onClose: () => void;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
  zClass?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hasAppliedInitialFocusRef = useRef(false);
  useEffect(() => {
    if (suspended || hasAppliedInitialFocusRef.current) return;
    hasAppliedInitialFocusRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      initialFocusRef?.current?.focus();
      if (!initialFocusRef?.current && rootRef.current) focusableElements(rootRef.current).at(0)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialFocusRef, suspended]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (suspended) return;
    if (event.key === "Escape" && !closeDisabled) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !rootRef.current) return;
    const focusable = focusableElements(rootRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      ref={rootRef}
      className={`fixed inset-0 ${zClass} flex items-center justify-center bg-black/75 p-2 sm:p-6`}
      role={suspended ? undefined : "dialog"}
      aria-modal={suspended ? undefined : true}
      aria-labelledby={suspended ? undefined : labelledBy}
      aria-hidden={suspended ? true : undefined}
      inert={suspended}
      data-testid={testId}
      data-suspended={suspended ? "true" : "false"}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        if (!suspended && !closeDisabled && event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function TranscriptMutationProvider({
  sessionId,
  selectionKey,
  availability,
  paneVisible,
  historyRevision,
  onAuthoritativeRefresh,
  children,
}: {
  sessionId: string;
  selectionKey: string;
  availability: MutationAvailability;
  paneVisible: boolean;
  historyRevision: number;
  onAuthoritativeRefresh: () => void;
  children: ReactNode;
}) {
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [manage, setManage] = useState<{ summaries: TranscriptEventRowSummary[]; trigger: HTMLButtonElement } | null>(null);
  const [mutation, setMutation] = useState<{ eventId: string; operation: TranscriptMutationOperation; trigger: HTMLButtonElement } | null>(null);
  const [pending, setPending] = useState<{ eventId: string; operation: TranscriptMutationOperation; afterRevision: number; ambiguous: boolean } | null>(null);
  const hasOpenModal = Boolean(inspectorOpen || manage || mutation);
  const inspectorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pendingRef = useRef<HTMLDivElement | null>(null);
  const hadPendingRef = useRef(false);
  const scopeRef = useRef<string | null>(selectionKey);
  const availableRef = useRef(availability.available && paneVisible);
  scopeRef.current = selectionKey;
  availableRef.current = availability.available && paneVisible;

  useEffect(() => () => { scopeRef.current = null; availableRef.current = false; }, []);
  useEffect(() => {
    if (!hasOpenModal) return;
    const root = document.getElementById("root");
    if (!root) return;
    const hadInert = root.hasAttribute("inert");
    const previousInert = root.inert;
    const previousAriaHidden = root.getAttribute("aria-hidden");
    const previousModalOwner = root.getAttribute("data-transcript-modal-owner");
    root.inert = true;
    root.setAttribute("aria-hidden", "true");
    root.setAttribute("data-transcript-modal-owner", selectionKey);
    return () => {
      root.inert = previousInert;
      if (!hadInert && !previousInert) root.removeAttribute("inert");
      if (previousAriaHidden === null) root.removeAttribute("aria-hidden");
      else root.setAttribute("aria-hidden", previousAriaHidden);
      if (previousModalOwner === null) root.removeAttribute("data-transcript-modal-owner");
      else root.setAttribute("data-transcript-modal-owner", previousModalOwner);
    };
  }, [hasOpenModal, selectionKey]);
  useEffect(() => {
    if (historyRevision > (pending?.afterRevision ?? Number.MAX_SAFE_INTEGER)) setPending(null);
  }, [historyRevision, pending?.afterRevision]);
  useEffect(() => {
    if (pending) {
      hadPendingRef.current = true;
      pendingRef.current?.focus();
    } else if (hadPendingRef.current) {
      hadPendingRef.current = false;
      document.querySelector<HTMLElement>("[data-testid=chat-input]")?.focus();
    }
  }, [pending]);

  const closeTransient = useCallback(() => {
    setMutation(null);
    setManage(null);
    setInspectorOpen(false);
  }, []);

  useEffect(() => {
    if (!availability.available || !paneVisible) closeTransient();
  }, [availability.available, closeTransient, paneVisible]);

  useEffect(() => {
    const visibilityChanged = () => {
      if (document.visibilityState !== "visible") closeTransient();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => document.removeEventListener("visibilitychange", visibilityChanged);
  }, [closeTransient]);

  const openManage = useCallback((summaries: TranscriptEventRowSummary[], trigger: HTMLButtonElement) => {
    if (!availableRef.current || summaries.length === 0) return;
    setManage({ summaries, trigger });
  }, []);
  const openInspector = useCallback((trigger: HTMLButtonElement) => {
    if (!availableRef.current) return;
    inspectorTriggerRef.current = trigger;
    setInspectorOpen(true);
  }, []);
  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    restoreFocus(inspectorTriggerRef.current);
    inspectorTriggerRef.current = null;
  }, []);
  const isScopeCurrent = useCallback((captured: string) => (
    scopeRef.current === captured && availableRef.current
  ), []);
  const beginAuthoritativeRefresh = useCallback((
    eventId: string,
    operation: TranscriptMutationOperation,
    ambiguous: boolean,
  ) => {
    setPending({ eventId, operation, afterRevision: historyRevision, ambiguous });
    setMutation(null);
    setManage(null);
    setInspectorOpen(false);
    onAuthoritativeRefresh();
  }, [historyRevision, onAuthoritativeRefresh]);

  const context = useMemo<TranscriptMutationContextValue>(() => ({ availability, openManage, openInspector }), [availability, openInspector, openManage]);

  return (
    <TranscriptMutationContext.Provider value={context}>
      <div
        className="h-full"
        data-testid="transcript-mutation-scope"
        data-modal-open={hasOpenModal ? "true" : "false"}
        data-selection-key={selectionKey}
        data-mutation-available={availability.available ? "true" : "false"}
        data-unavailable-reason={availability.reason}
      >
        {children}
      </div>
      {pending && (
        <div
          ref={pendingRef}
          tabIndex={-1}
          data-testid="transcript-mutation-pending"
          data-completion={pending.ambiguous ? "ambiguous" : "confirmed"}
          role="status"
          className="fixed bottom-20 left-1/2 z-[65] -translate-x-1/2 rounded-full border border-blue-800 bg-blue-950 px-4 py-2 text-xs text-blue-100 shadow-xl"
        >
          {pending.ambiguous ? "Mutation outcome uncertain; reloading authoritative transcript…" : "Updating transcript from the authoritative session…"}
        </div>
      )}
      {inspectorOpen && (
        <TranscriptEventInspector
          sessionId={sessionId}
          selectionKey={selectionKey}
          availability={availability}
          suspended={Boolean(manage || mutation)}
          onManage={openManage}
          onClose={closeInspector}
        />
      )}
      {manage && (
        <TranscriptEventManager
          summaries={manage.summaries}
          availability={availability}
          suspended={Boolean(mutation)}
          onChoose={(eventId, operation, trigger) => setMutation({ eventId, operation, trigger })}
          onClose={() => {
            const trigger = manage.trigger;
            setManage(null);
            restoreFocus(trigger);
          }}
        />
      )}
      {mutation && (
        <TranscriptMutationDialog
          key={`${selectionKey}:${mutation.eventId}:${mutation.operation}`}
          sessionId={sessionId}
          selectionKey={selectionKey}
          eventId={mutation.eventId}
          operation={mutation.operation}
          trigger={mutation.trigger}
          isScopeCurrent={isScopeCurrent}
          onSuccess={() => {
            if (!isScopeCurrent(selectionKey)) return;
            beginAuthoritativeRefresh(mutation.eventId, mutation.operation, false);
          }}
          onAmbiguous={() => beginAuthoritativeRefresh(mutation.eventId, mutation.operation, true)}
          onClose={() => setMutation(null)}
        />
      )}
    </TranscriptMutationContext.Provider>
  );
}

export const TranscriptInspectorButton = memo(function TranscriptInspectorButton() {
  const context = useContext(TranscriptMutationContext);
  if (!context) return null;
  return (
    <button
      type="button"
      data-testid="transcript-event-inspector-button"
      disabled={!context.availability.available}
      aria-disabled={!context.availability.available}
      onClick={(event) => context.openInspector(event.currentTarget)}
      className="inline-flex items-center gap-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-xs text-neutral-400 hover:border-neutral-700 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-35"
      title={context.availability.available ? "Inspect persisted transcript events" : context.availability.reason}
    >
      <ListTree size={12} aria-hidden="true" /><span className="hidden sm:inline">Events</span>
    </button>
  );
});

export const PersistedTranscriptEventActions = memo(function PersistedTranscriptEventActions({
  eventIds,
  label,
  summaries,
}: {
  eventIds: string[];
  label: string;
  summaries?: TranscriptEventRowSummary[];
}) {
  const context = useContext(TranscriptMutationContext);
  const ids = [...new Set(eventIds.filter(Boolean))];
  if (!context || ids.length === 0) return null;
  const rows: TranscriptEventRowSummary[] = summaries?.filter((summary) => ids.includes(summary.eventId)) ?? ids.map((eventId, index): TranscriptEventRowSummary => ({
    eventId,
    label: ids.length === 1 ? label : `${label} event ${index + 1}`,
  }));
  const modifiedRows = rows.filter((row) => row.marker);
  const markerSet = new Set(modifiedRows.map((row) => row.marker));
  const marker: MutationMarker = modifiedRows.length > 0 && (modifiedRows.length < rows.length || markerSet.size > 1)
    ? "partially modified"
    : markerSet.values().next().value ?? null;
  return (
    <div data-testid="transcript-event-actions" className="flex items-center justify-end gap-2 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
      <TranscriptMutationMarker marker={marker} />
      <button
        type="button"
        data-testid="transcript-event-manage"
        disabled={!context.availability.available}
        aria-disabled={!context.availability.available}
        onClick={(event) => context.openManage(rows, event.currentTarget)}
        className="inline-flex min-h-9 items-center gap-1.5 rounded border border-neutral-700/70 bg-neutral-950/70 px-2 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-35"
        title={context.availability.available ? `Manage ${ids.length === 1 ? "this persisted event" : `${ids.length} persisted events`}` : context.availability.reason}
      >
        <Settings2 size={12} aria-hidden="true" /> {ids.length === 1 ? "Manage event" : `Manage ${ids.length} events`}
      </button>
    </div>
  );
});

function TranscriptEventManager({
  summaries,
  availability,
  suspended,
  onChoose,
  onClose,
}: {
  summaries: TranscriptEventRowSummary[];
  availability: MutationAvailability;
  suspended: boolean;
  onChoose: (eventId: string, operation: TranscriptMutationOperation, trigger: HTMLButtonElement) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <ModalFrame testId="transcript-event-manager" labelledBy="transcript-event-manager-title" suspended={suspended} onClose={onClose} initialFocusRef={closeRef} zClass="z-[75]">
      <section className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-neutral-800 px-4 py-3">
          <div><div className="text-[10px] font-semibold uppercase tracking-wider text-blue-400">Persisted events</div><h2 id="transcript-event-manager-title" className="mt-1 text-base font-semibold">Choose an exact event</h2></div>
          <button ref={closeRef} type="button" onClick={onClose} className="rounded p-2 text-neutral-400 hover:bg-neutral-800" aria-label="Close event manager"><X size={18} /></button>
        </header>
        <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          {summaries.map((summary, index) => (
            <li key={summary.eventId} data-testid="transcript-event-manager-row" data-event-id={summary.eventId} className="rounded border border-neutral-800 bg-neutral-900/50 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1"><div className="text-xs font-semibold text-neutral-200">{index + 1}. {summary.label}</div><div className="mt-1 break-all font-mono text-[10px] text-neutral-600">{summary.eventId}</div>{summary.preview && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-neutral-400">{bounded(summary.preview, 280)}</p>}<TranscriptMutationMarker marker={summary.marker ?? null} /></div>
                <div className="flex gap-1">
                  <button type="button" data-testid="transcript-event-edit" disabled={!availability.available || summary.marker === "deleted"} onClick={(event) => onChoose(summary.eventId, "edit", event.currentTarget)} className="inline-flex min-h-10 items-center gap-1 rounded border border-neutral-700 px-3 text-xs hover:bg-neutral-800 disabled:opacity-35"><Pencil size={13} /> Edit</button>
                  <button type="button" data-testid="transcript-event-delete" disabled={!availability.available || summary.marker === "deleted"} onClick={(event) => onChoose(summary.eventId, "delete", event.currentTarget)} className="inline-flex min-h-10 items-center gap-1 rounded border border-red-900/70 px-3 text-xs text-red-300 hover:bg-red-950/50 disabled:opacity-35"><Trash2 size={13} /> Delete</button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </ModalFrame>
  );
}

function LazyEventDetails({ sessionId, event }: { sessionId: string; event: TranscriptEvent }) {
  const [envelopeOpen, setEnvelopeOpen] = useState(false);
  const [payloadOpen, setPayloadOpen] = useState(false);
  const [detail, setDetail] = useState<TranscriptEvent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    if (detail || loading) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    void fetchTranscriptEvent(sessionId, event.event_id, controller.signal).then((fresh) => {
      if (!controller.signal.aborted) setDetail(fresh);
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(loadError));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
  }, [detail, event.event_id, loading, sessionId]);
  useEffect(() => () => controllerRef.current?.abort(), []);
  const exact = detail ?? event;
  return (
    <>
      <details className="mt-2 text-xs" onToggle={(toggle) => { setEnvelopeOpen(toggle.currentTarget.open); if (toggle.currentTarget.open) load(); }}><summary className="cursor-pointer text-neutral-400">Read-only envelope</summary>{envelopeOpen && (loading ? <p className="mt-2 text-neutral-500">Loading exact event…</p> : error ? <p role="alert" className="mt-2 text-red-300">{error}</p> : <pre className="mt-2 max-h-48 overflow-auto rounded bg-neutral-950 p-2 font-mono text-[11px] text-neutral-400">{bounded(prettyJson(exact.envelope))}</pre>)}</details>
      <details className="mt-2 text-xs" onToggle={(toggle) => { setPayloadOpen(toggle.currentTarget.open); if (toggle.currentTarget.open) load(); }}><summary className="cursor-pointer text-neutral-400">Payload</summary>{payloadOpen && (loading ? <p className="mt-2 text-neutral-500">Loading exact event…</p> : error ? <p role="alert" className="mt-2 text-red-300">{error}</p> : <pre className="mt-2 max-h-64 overflow-auto rounded bg-neutral-950 p-2 font-mono text-[11px] text-neutral-300">{exact.deleted ? "(deleted payload)" : bounded(prettyJson(exact.payload))}</pre>)}</details>
    </>
  );
}

function TranscriptEventInspector({
  sessionId,
  selectionKey,
  availability,
  suspended,
  onManage,
  onClose,
}: {
  sessionId: string;
  selectionKey: string;
  availability: MutationAvailability;
  suspended: boolean;
  onManage: (summaries: TranscriptEventRowSummary[], trigger: HTMLButtonElement) => void;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [allBranches, setAllBranches] = useState(false);
  const [hiddenTypes, setHiddenTypes] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const controllersRef = useRef(new Set<AbortController>());

  useEffect(() => () => {
    mountedRef.current = false;
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
  }, []);

  const loadPage = useCallback((nextCursor: string | null, append: boolean) => {
    const controller = new AbortController();
    const generation = ++generationRef.current;
    controllersRef.current.add(controller);
    setLoading(true);
    setError("");
    void fetchTranscriptEvents(sessionId, {
      cursor: nextCursor ?? undefined,
      limit: INSPECTOR_PAGE_SIZE,
      includePayload: false,
    }, controller.signal).then((result) => {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setEvents((current) => append ? [...current, ...result.events] : result.events);
      setCursor(result.next_cursor);
    }).catch((loadError: unknown) => {
      if (mountedRef.current && !controller.signal.aborted && generation === generationRef.current) setError(errorMessage(loadError));
    }).finally(() => {
      controllersRef.current.delete(controller);
      if (mountedRef.current && !controller.signal.aborted && generation === generationRef.current) setLoading(false);
    });
    return () => controller.abort();
  }, [sessionId]);

  useEffect(() => {
    setEvents([]);
    setCursor(null);
    return loadPage(null, false);
  }, [loadPage, selectionKey]);

  const visibleEvents = useMemo(() => events.filter((event) => (
    (allBranches || event.active_branch) && (hiddenTypes || !event.hidden_event_type)
  )), [allBranches, events, hiddenTypes]);

  return (
    <ModalFrame testId="transcript-event-inspector" labelledBy="transcript-inspector-title" suspended={suspended} onClose={onClose} initialFocusRef={closeRef}>
      <section className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-neutral-800 px-4 py-3"><div><div className="text-[10px] font-semibold uppercase tracking-wider text-blue-400">Transcript inspector</div><h2 id="transcript-inspector-title" className="mt-1 text-base font-semibold">Persisted session events</h2><p className="mt-1 text-xs text-neutral-500">Active branch and visible event types by default. Event payloads load only when expanded.</p></div><button ref={closeRef} type="button" onClick={onClose} className="rounded p-2 text-neutral-400 hover:bg-neutral-800" aria-label="Close transcript event inspector"><X size={18} /></button></header>
        <div className="flex flex-wrap gap-4 border-b border-neutral-800 bg-neutral-900/40 px-4 py-2 text-xs"><label className="inline-flex min-h-8 items-center gap-2"><input data-testid="transcript-inspector-all-branches" type="checkbox" checked={allBranches} onChange={(change) => setAllBranches(change.target.checked)} /> Show all branches</label><label className="inline-flex min-h-8 items-center gap-2"><input data-testid="transcript-inspector-hidden-types" type="checkbox" checked={hiddenTypes} onChange={(change) => setHiddenTypes(change.target.checked)} /> Show hidden event types</label>{loading && <span role="status" className="self-center text-blue-300">Loading…</span>}</div>
        {error && <div role="alert" className="border-b border-red-900/60 bg-red-950/30 px-4 py-2 text-sm text-red-200">{error}</div>}
        <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          {visibleEvents.map((event) => {
            const summary: TranscriptEventRowSummary = { eventId: event.event_id, label: event.event_type, preview: event.editable_text ?? undefined, marker: event.deleted ? "deleted" : event.edited ? "edited" : undefined };
            return <li key={event.event_id} data-testid="transcript-inspector-event" data-event-id={event.event_id} className="group rounded border border-neutral-800 bg-neutral-900/50 p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><div className="flex flex-wrap items-center gap-2 text-xs"><span className="font-semibold">{event.event_type}</span><span className="font-mono text-[10px] text-neutral-600">{event.event_id}</span>{!event.active_branch && <span className="text-[10px] text-amber-300">other branch</span>}{event.hidden_event_type && <span className="text-[10px] text-neutral-500">hidden type</span>}<TranscriptMutationMarker marker={summary.marker ?? null} /></div></div><button type="button" data-testid="transcript-inspector-manage-event" disabled={!availability.available} onClick={(click) => onManage([summary], click.currentTarget)} className="min-h-9 rounded border border-neutral-700 px-2 text-xs hover:bg-neutral-800 disabled:opacity-35">Manage</button></div><LazyEventDetails sessionId={sessionId} event={event} /></li>;
          })}
          {!loading && visibleEvents.length === 0 && <li className="py-10 text-center text-sm text-neutral-500">No events in the loaded page match this view.</li>}
          {cursor && <li className="flex justify-center py-2"><button type="button" data-testid="transcript-inspector-load-more" disabled={loading} onClick={() => loadPage(cursor, true)} className="min-h-10 rounded border border-neutral-700 px-4 text-xs hover:bg-neutral-800 disabled:opacity-40">Load more</button></li>}
        </ol>
      </section>
    </ModalFrame>
  );
}

function TranscriptMutationDialog({
  sessionId,
  selectionKey,
  eventId,
  operation,
  trigger,
  isScopeCurrent,
  onSuccess,
  onAmbiguous,
  onClose,
}: {
  sessionId: string;
  selectionKey: string;
  eventId: string;
  operation: TranscriptMutationOperation;
  trigger: HTMLButtonElement;
  isScopeCurrent: (captured: string) => boolean;
  onSuccess: () => void;
  onAmbiguous: () => void;
  onClose: () => void;
}) {
  const [event, setEvent] = useState<TranscriptEvent | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [text, setText] = useState("");
  const [json, setJson] = useState("");
  const [pin, setPin] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [reviewRevision, setReviewRevision] = useState(0);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const submittedRef = useRef(false);
  const ambiguitySignalledRef = useRef(false);
  const onAmbiguousRef = useRef(onAmbiguous);
  onAmbiguousRef.current = onAmbiguous;

  const signalAmbiguousCompletion = useCallback(() => {
    if (!submittedRef.current || ambiguitySignalledRef.current) return;
    ambiguitySignalledRef.current = true;
    submittedRef.current = false;
    onAmbiguousRef.current();
  }, []);

  const applyFreshEvent = useCallback((fresh: TranscriptEvent, conflict = false) => {
    const friendly = friendlyEditorForPayload(fresh.payload);
    setEvent(fresh);
    setAdvanced(false);
    setText(friendly?.text ?? "");
    setJson(prettyJson(fresh.payload));
    setPin("");
    setAcknowledged(false);
    setReviewRevision((revision) => revision + 1);
    if (conflict) setError("The event changed. The latest exact event is loaded below; review it again before entering a new PIN.");
  }, []);

  const loadFresh = useCallback(async (conflict = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    if (!conflict) setError("");
    try {
      const fresh = await fetchTranscriptEvent(sessionId, eventId, controller.signal);
      if (!controller.signal.aborted && isScopeCurrent(selectionKey)) applyFreshEvent(fresh, conflict);
    } catch (loadError: unknown) {
      if (!controller.signal.aborted && isScopeCurrent(selectionKey)) setError(errorMessage(loadError));
    } finally {
      if (!controller.signal.aborted && isScopeCurrent(selectionKey)) setLoading(false);
    }
  }, [applyFreshEvent, eventId, isScopeCurrent, selectionKey, sessionId]);

  useEffect(() => {
    void loadFresh();
    return () => {
      signalAmbiguousCompletion();
      requestRef.current?.abort();
    };
  }, [loadFresh, signalAmbiguousCompletion]);

  useEffect(() => {
    if (!event) return;
    const frame = window.requestAnimationFrame(() => {
      (operation === "edit" ? editorRef.current : pinRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [event, operation]);

  const friendly = useMemo(() => event ? friendlyEditorForPayload(event.payload) : null, [event]);
  const warnings = useMemo(() => event ? inferredWarnings(event, advanced) : [], [advanced, event]);
  const warningKey = warnings.map((warning) => `${warning.code}:${warning.message}:${warning.requires_acknowledgement}`).join("|");
  const intentKey = `${operation}\0${event?.intent_token ?? ""}\0${advanced}\0${advanced || !friendly ? json : text}\0${warningKey}\0${reviewRevision}`;
  const previousIntentRef = useRef(intentKey);
  useEffect(() => {
    if (previousIntentRef.current !== intentKey) {
      previousIntentRef.current = intentKey;
      setPin("");
      setAcknowledged(false);
    }
  }, [intentKey]);

  const close = useCallback(() => {
    requestRef.current?.abort();
    setPin("");
    setAcknowledged(false);
    onClose();
    restoreFocus(trigger);
  }, [onClose, trigger]);

  const requiresAcknowledgement = warnings.some((warning) => warning.requires_acknowledgement);
  const pinValid = /^\d{8}$/.test(pin);
  const submit = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    if (!event || !pinValid || submitting || (requiresAcknowledgement && !acknowledged)) return;
    let payload: Record<string, unknown> | null = null;
    if (operation === "edit") {
      let candidate: unknown;
      if (!advanced && friendly) {
        candidate = friendly.buildPayload(text);
      } else {
        if (json.length > MAX_ADVANCED_PAYLOAD_CHARS) { setError(`Payload JSON must be ${MAX_ADVANCED_PAYLOAD_CHARS.toLocaleString()} characters or fewer.`); setPin(""); return; }
        try { candidate = JSON.parse(json) as unknown; } catch { setError("Payload JSON is invalid."); setPin(""); return; }
      }
      const candidateRecord = record(candidate);
      if (!candidateRecord) { setError("Payload JSON must be an object."); setPin(""); return; }
      payload = candidateRecord;
    }
    const capturedIntentToken = event.intent_token;
    const expectedEntry = event.expected_entry;
    const controller = new AbortController();
    requestRef.current = controller;
    ambiguitySignalledRef.current = false;
    submittedRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      const result = operation === "edit" && payload
        ? await editTranscriptEvent(sessionId, eventId, {
          pin,
          expected_entry: expectedEntry,
          replacement_entry: reconstructTranscriptEntry(event.envelope, payload),
        }, controller.signal)
        : await deleteTranscriptEvent(sessionId, eventId, {
            pin,
            expected_entry: expectedEntry,
          }, controller.signal);
      if (result.reindex_failed) {
        signalAmbiguousCompletion();
        return;
      }
      if (controller.signal.aborted || !isScopeCurrent(selectionKey) || event.intent_token !== capturedIntentToken) {
        signalAmbiguousCompletion();
        return;
      }
      submittedRef.current = false;
      onSuccess();
    } catch (submitError: unknown) {
      if (isAmbiguousMutationError(submitError)) {
        signalAmbiguousCompletion();
      } else if (!controller.signal.aborted && isScopeCurrent(selectionKey)) {
        submittedRef.current = false;
        if (submitError instanceof ApiError && submitError.status === 409 && CONFLICT_CODES.has(apiErrorCode(submitError) ?? "")) {
          setPin("");
          setAcknowledged(false);
          setSubmitting(false);
          await loadFresh(true);
        } else setError(errorMessage(submitError));
      }
    } finally {
      if (!controller.signal.aborted && isScopeCurrent(selectionKey)) {
        setPin("");
        setAcknowledged(false);
        setSubmitting(false);
      }
    }
  };

  const previewJson = event ? bounded(prettyJson(event.payload)) : "";
  return (
    <ModalFrame testId="transcript-mutation-dialog" labelledBy="transcript-mutation-title" closeDisabled={submitting} onClose={close} initialFocusRef={event ? operation === "edit" ? editorRef : pinRef : cancelRef} zClass="z-[80]">
      <form
        onSubmit={submit}
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 shadow-2xl"
        data-operation={operation}
        data-selection-key={selectionKey}
        data-review-revision={reviewRevision}
        data-submit-started={submitting ? "true" : "false"}
        data-ambiguity-signalled={ambiguitySignalledRef.current ? "true" : "false"}
      >
        <header className="border-b border-neutral-800 px-4 py-3"><div className={`text-[10px] font-semibold uppercase tracking-wider ${operation === "delete" ? "text-red-400" : "text-blue-400"}`}>PIN-gated transcript mutation</div><h2 id="transcript-mutation-title" className="mt-1 text-base font-semibold">{operation === "delete" ? "Delete transcript event?" : "Edit transcript event"}</h2><p className="mt-1 break-all font-mono text-[10px] text-neutral-600">{eventId}</p></header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {loading && <p role="status" className="text-sm text-neutral-400">Loading the latest exact event…</p>}
          {error && <div role="alert" data-testid="transcript-mutation-error" className="rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-200">{error}</div>}
          {event && <><dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 rounded border border-neutral-800 bg-neutral-900/40 p-3 text-xs"><dt className="text-neutral-500">Type</dt><dd>{event.event_type}</dd><dt className="text-neutral-500">Branch</dt><dd>{event.active_branch ? "active" : "other"}</dd><dt className="text-neutral-500">Event ID</dt><dd className="break-all font-mono text-[10px] text-neutral-500">{event.event_id}</dd></dl><details className="rounded border border-neutral-800 px-3 py-2 text-xs"><summary className="cursor-pointer text-neutral-400">Read-only envelope</summary><pre className="mt-2 max-h-40 overflow-auto rounded bg-neutral-900 p-2 font-mono text-[11px] text-neutral-400">{bounded(prettyJson(event.envelope))}</pre></details>
          {operation === "delete" ? <div data-testid="transcript-delete-preview" className="space-y-2 rounded border border-red-900/60 bg-red-950/20 p-3"><div className="text-xs font-semibold uppercase tracking-wider text-red-300">Exact content to remove</div>{friendly?.text && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-950 p-2 text-xs text-neutral-200">{bounded(friendly.text)}</pre>}<pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-950 p-2 font-mono text-[11px] text-neutral-300">{previewJson}</pre><p className="text-xs leading-relaxed text-red-100/80">Deletion removes this event's stored payload from future context/search; copies or paraphrases in other events, external side effects, providers, and backups remain separate/outside.</p></div> : <div>{friendly && <div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium">{advanced ? "Advanced payload JSON" : "Message text"}</span><button type="button" data-testid="transcript-edit-mode-toggle" onClick={() => setAdvanced((value) => !value)} className="inline-flex min-h-9 items-center gap-1 rounded border border-neutral-700 px-2 text-xs"><FileJson size={12} /> {advanced ? "Use text editor" : "Advanced JSON"}</button></div>}{!friendly || advanced ? <textarea ref={editorRef} data-testid="transcript-event-json-input" aria-label="Advanced event payload JSON" value={json} maxLength={MAX_ADVANCED_PAYLOAD_CHARS} onChange={(change) => setJson(change.target.value)} className="h-64 w-full resize-y rounded border border-neutral-700 bg-neutral-900 p-3 font-mono text-xs outline-none focus:border-blue-500" spellCheck={false} /> : <textarea ref={editorRef} data-testid="transcript-event-text-input" aria-label="Message text" value={text} maxLength={MAX_ADVANCED_PAYLOAD_CHARS} onChange={(change) => setText(change.target.value)} className="h-44 w-full resize-y rounded border border-neutral-700 bg-neutral-900 p-3 text-sm outline-none focus:border-blue-500" />}</div>}
          {warnings.length > 0 && <div data-testid="transcript-mutation-warnings" className="space-y-2 rounded border border-amber-900/60 bg-amber-950/20 p-3"><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-300"><AlertTriangle size={14} /> Review consequences</div><ul className="list-disc space-y-1 pl-5 text-xs text-amber-100/80">{warnings.map((warning) => <li key={`${warning.code}:${warning.message}`}>{warning.message}</li>)}</ul>{requiresAcknowledgement && <label className="flex min-h-9 items-start gap-2 text-xs"><input data-testid="transcript-warning-acknowledgement" type="checkbox" checked={acknowledged} onChange={(change) => setAcknowledged(change.target.checked)} /> I understand these warnings and want to continue.</label>}</div>}
          <div><label htmlFor="transcript-mutation-pin" className="text-xs font-medium">8-digit identity PIN</label><p className="mt-1 text-[11px] text-neutral-500">Cleared whenever the reviewed intent changes and after submit, cancel, error, selection change, or visibility loss.</p><input ref={pinRef} id="transcript-mutation-pin" data-testid="transcript-mutation-pin" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{8}" minLength={8} maxLength={8} value={pin} onChange={(change) => setPin(change.target.value.replace(/\D/g, "").slice(0, 8))} className="mt-2 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-red-500 sm:max-w-xs" placeholder="8-digit PIN" /></div></>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-neutral-800 px-4 py-3"><button ref={cancelRef} type="button" onClick={close} disabled={submitting} className="min-h-10 rounded px-3 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-50">Cancel</button><button type="submit" data-testid="transcript-mutation-submit" disabled={!event || loading || !pinValid || submitting || (requiresAcknowledgement && !acknowledged)} className={`min-h-10 rounded px-4 text-xs font-semibold text-white disabled:opacity-40 ${operation === "delete" ? "bg-red-700" : "bg-blue-700"}`}>{submitting ? "Submitting…" : operation === "delete" ? "Delete event" : "Save edit"}</button></footer>
      </form>
    </ModalFrame>
  );
}
