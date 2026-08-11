import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  PROTECTED_BROWSER_CAPABILITY_ID,
  STANDARD_BROWSER_CAPABILITY_ID,
  type ProtectedBrowserAuthorityCheckpoint,
  type ProtectedBrowserAuthoritySnapshot,
  type ProtectedBrowserBinding,
  type ProtectedBrowserControlMode,
  type ProtectedBrowserDispatchResult,
  type ProtectedBrowserOperation,
  type ProtectedBrowserStorage,
} from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export interface ProtectedBrowserAuthorityPort {
  /** Resolve only from current durable workspace/session/runtime authority. */
  resolve(
    binding: Readonly<ProtectedBrowserBinding>,
    checkpoint: ProtectedBrowserAuthorityCheckpoint,
  ): MaybePromise<ProtectedBrowserAuthoritySnapshot | null>;
  /** Backend-owned handoff transition; must return the newly committed exact control epoch. */
  transitionControl?(
    binding: Readonly<ProtectedBrowserBinding>,
    mode: ProtectedBrowserControlMode,
  ): MaybePromise<ProtectedBrowserAuthoritySnapshot | null>;
  /** Optional denial-first notification used for immediate proactive cleanup. */
  subscribe?(
    binding: Readonly<ProtectedBrowserBinding>,
    revoke: (reason?: string) => void,
  ): () => void;
}

export interface ProtectedBrowserBackendContext {
  readonly binding: Readonly<ProtectedBrowserBinding>;
  readonly storage: Readonly<ProtectedBrowserStorage>;
  readonly signal: AbortSignal;
  /** The backend must call this immediately before every CDP command. */
  assertAuthorized(checkpoint: "pre-cdp"): Promise<void>;
}

export interface ProtectedBrowserBackendPort {
  /**
   * CDP operations must settle action-triggered top-level navigation and attest
   * the resulting current URL. Unattested or late redirects fail closed.
   */
  execute(
    operation: Readonly<ProtectedBrowserOperation>,
    context: ProtectedBrowserBackendContext,
  ): Promise<ProtectedBrowserDispatchResult>;
  /** Best-effort lifecycle stop used after denial has already latched. */
  stop(context: { binding: Readonly<ProtectedBrowserBinding>; storage: Readonly<ProtectedBrowserStorage> }): MaybePromise<void>;
}

export interface ProtectedBrowserCredentialPort {
  /** Opens only a human-controlled broker/UI handoff; no credential value crosses this port. */
  beginHandoff?(binding: Readonly<ProtectedBrowserBinding>): MaybePromise<{ revoke(): MaybePromise<void> } | void>;
  assertInspectionAllowed?(binding: Readonly<ProtectedBrowserBinding>): MaybePromise<void>;
  assertSafeResume?(binding: Readonly<ProtectedBrowserBinding>): MaybePromise<void>;
  /** Synchronous body must invalidate every one-use choice for this lease. */
  revokeLease(binding: Readonly<ProtectedBrowserBinding>): MaybePromise<void>;
  /** Full pair invalidation may additionally clear realm-owned taint state. */
  revokeRealm?(binding: Readonly<ProtectedBrowserBinding>): MaybePromise<void>;
}

export interface ProtectedBrowserViewerHandle {
  id: string;
  kind: "vnc" | "cdp";
}

export interface ProtectedBrowserOptions {
  dataDir: string;
  binding: ProtectedBrowserBinding;
  authority: ProtectedBrowserAuthorityPort;
  backend: ProtectedBrowserBackendPort;
  credentials?: ProtectedBrowserCredentialPort;
  /** Realm-owned state survives replacement runtime leases. */
  initialControlMode?: ProtectedBrowserControlMode;
  onControlModeChanged?: (mode: ProtectedBrowserControlMode, controlGeneration: number) => void;
  /** Synchronous removal of any replacement-publication path for this realm. */
  onRealmRevoked?: () => void;
}

const BINDING_KEYS = [
  "capabilityId",
  "sourceSessionId",
  "projectId",
  "projectCwd",
  "agentProfileId",
  "associationRevision",
  "runtimeGeneration",
  "processBootNonce",
  "controlGeneration",
] as const satisfies readonly (keyof ProtectedBrowserBinding)[];

const CDP_OPERATION_KINDS = new Set<ProtectedBrowserOperation["kind"]>([
  "navigate",
  "snapshot",
  "dom_snapshot",
  "links",
  "accessibility",
  "query_selector",
  "click",
  "click_selector",
  "fill_selector",
  "type_public",
]);

const AGENT_CONTROL_OPERATION_KINDS = new Set<ProtectedBrowserOperation["kind"]>([
  "start",
  "stop",
  "navigate",
  "snapshot",
  "dom_snapshot",
  "links",
  "accessibility",
  "query_selector",
  "click",
  "click_selector",
  "fill_selector",
  "type_public",
]);

const OPERATION_KEYS: Record<ProtectedBrowserOperation["kind"], readonly string[]> = {
  status: ["kind"],
  start: ["kind"],
  stop: ["kind"],
  navigate: ["kind", "url"],
  snapshot: ["kind", "mode"],
  dom_snapshot: ["kind", "includeText", "limit"],
  links: ["kind", "limit"],
  accessibility: ["kind", "limit"],
  query_selector: ["kind", "selector", "limit"],
  click: ["kind", "x", "y"],
  click_selector: ["kind", "selector", "index"],
  fill_selector: ["kind", "selector", "text", "index"],
  type_public: ["kind", "text"],
};

function protectedBrowserError(message: string, statusCode = 403): Error {
  const error = new Error(message);
  (error as Error & { statusCode?: number }).statusCode = statusCode;
  return error;
}

function assertExactString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw protectedBrowserError(`Protected browser ${label} is invalid`);
  }
}

function assertPositiveRevision(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw protectedBrowserError(`Protected browser ${label} is invalid`);
  }
}

export function assertProtectedBrowserBinding(binding: ProtectedBrowserBinding): void {
  if (!binding || typeof binding !== "object" || Object.getPrototypeOf(binding) !== Object.prototype
    || (binding.capabilityId !== PROTECTED_BROWSER_CAPABILITY_ID
      && binding.capabilityId !== STANDARD_BROWSER_CAPABILITY_ID)) {
    throw protectedBrowserError("Interactive browser capability binding is invalid");
  }
  const allowed = new Set<string>(BINDING_KEYS);
  if (Object.keys(binding).some((key) => !allowed.has(key))) {
    throw protectedBrowserError("Protected browser capability binding contains unsupported fields");
  }
  for (const key of [
    "sourceSessionId",
    "projectId",
    "projectCwd",
    "agentProfileId",
    "runtimeGeneration",
    "processBootNonce",
  ] as const) assertExactString(binding[key], key);
  if (!path.isAbsolute(binding.projectCwd)) throw protectedBrowserError("Protected browser projectCwd must be absolute");
  assertPositiveRevision(binding.associationRevision, "associationRevision");
  if (!Number.isSafeInteger(binding.controlGeneration) || binding.controlGeneration < 0) {
    throw protectedBrowserError("Protected browser controlGeneration is invalid");
  }
}

export function exactProtectedBrowserBindingEqual(
  left: Readonly<ProtectedBrowserBinding>,
  right: Readonly<ProtectedBrowserBinding>,
): boolean {
  return BINDING_KEYS.every((key) => left[key] === right[key]);
}

function stableBindingEqualExceptControl(
  left: Readonly<ProtectedBrowserBinding>,
  right: Readonly<ProtectedBrowserBinding>,
): boolean {
  return BINDING_KEYS.every((key) => key === "controlGeneration" || left[key] === right[key]);
}

function snapshotAllowsProtectedBrowser(
  snapshot: ProtectedBrowserAuthoritySnapshot | null,
  binding: Readonly<ProtectedBrowserBinding>,
): snapshot is ProtectedBrowserAuthoritySnapshot {
  const expectedPrivacyMode = binding.capabilityId === STANDARD_BROWSER_CAPABILITY_ID ? "standard" : "protected";
  return Boolean(
    snapshot
    && snapshot.authorized
    && snapshot.privacyMode === expectedPrivacyMode
    && snapshot.sourceSessionDurable
    && !snapshot.sourceQuarantined
    && snapshot.profileEnabled
    && snapshot.projectAllowsProfile,
  );
}

function idStorageSegment(prefix: "project" | "profile", immutableId: string): string {
  assertExactString(immutableId, `${prefix}Id`);
  const digest = crypto.createHash("sha256").update(immutableId, "utf8").digest("base64url");
  return `${prefix}-${digest}`;
}

function ensurePrivateDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw protectedBrowserError("Protected browser storage is not a private directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw protectedBrowserError("Protected browser storage is not owned by the backend user");
  }
  fs.chmodSync(directory, 0o700);
}

/** Resolve and create an owner-private external profile tree keyed only by immutable IDs. */
export function ensureProtectedBrowserStorage(
  dataDir: string,
  projectId: string,
  agentProfileId: string,
  forbiddenProjectCwd?: string,
  capabilityId: ProtectedBrowserBinding["capabilityId"] = PROTECTED_BROWSER_CAPABILITY_ID,
): ProtectedBrowserStorage {
  assertExactString(dataDir, "dataDir");
  const requestedBase = path.resolve(dataDir);
  fs.mkdirSync(requestedBase, { recursive: true, mode: 0o700 });
  const base = fs.realpathSync(requestedBase);
  if (forbiddenProjectCwd) {
    const projectRoot = path.resolve(forbiddenProjectCwd);
    const relativeToProject = path.relative(projectRoot, base);
    if (relativeToProject === "" || (!relativeToProject.startsWith("..") && !path.isAbsolute(relativeToProject))) {
      throw protectedBrowserError("Protected browser storage must remain outside the project root");
    }
  }
  const parts = [
    capabilityId === STANDARD_BROWSER_CAPABILITY_ID ? "standard-browser" : "protected-browser",
    "v1",
    idStorageSegment("project", projectId),
    idStorageSegment("profile", agentProfileId),
  ];
  let rootDir = base;
  for (const part of parts) {
    rootDir = path.join(rootDir, part);
    ensurePrivateDirectory(rootDir);
  }
  const profileDir = path.join(rootDir, "profile");
  const artifactsDir = path.join(rootDir, "artifacts");
  const runtimeDir = path.join(rootDir, "runtime");
  for (const directory of [profileDir, artifactsDir, runtimeDir]) ensurePrivateDirectory(directory);
  return { persistence: "protected", rootDir, profileDir, artifactsDir, runtimeDir };
}

export function isProtectedBrowserHttpsUrl(value: string): boolean {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function isProtectedBrowserAllowedTopLevelUrl(value: string): boolean {
  return value === "about:blank" || isProtectedBrowserHttpsUrl(value);
}

export function normalizeProtectedBrowserHttpsUrl(value: string): string {
  assertExactString(value, "navigation URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw protectedBrowserError("Protected browser navigation requires an absolute HTTPS URL", 400);
  }
  if (!isProtectedBrowserHttpsUrl(parsed.toString())) {
    throw protectedBrowserError("Protected browser agent navigation requires HTTPS without embedded credentials", 400);
  }
  return parsed.toString();
}

function assertPlainExactOperation(operation: ProtectedBrowserOperation): void {
  if (!operation || typeof operation !== "object" || Object.getPrototypeOf(operation) !== Object.prototype) {
    throw protectedBrowserError("Protected browser operation is invalid", 400);
  }
  const descriptors = Object.getOwnPropertyDescriptors(operation);
  if (Reflect.ownKeys(operation).some((key) => typeof key !== "string" || !descriptors[key]?.enumerable || descriptors[key]?.get || descriptors[key]?.set)) {
    throw protectedBrowserError("Protected browser operation contains unsafe properties", 400);
  }
  const kind = (operation as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !(kind in OPERATION_KEYS)) throw protectedBrowserError("Protected browser operation is unknown", 400);
  const allowed = new Set(OPERATION_KEYS[kind as ProtectedBrowserOperation["kind"]]);
  if (Object.keys(operation).some((key) => !allowed.has(key))) throw protectedBrowserError("Protected browser operation contains unsupported fields", 400);

  const finiteNonnegative = (value: unknown) => Number.isFinite(value) && Number(value) >= 0;
  switch (operation.kind) {
    case "navigate":
      normalizeProtectedBrowserHttpsUrl(operation.url);
      break;
    case "snapshot":
      if (operation.mode !== undefined && operation.mode !== "text" && operation.mode !== "screenshot") throw protectedBrowserError("Protected browser snapshot mode is invalid", 400);
      break;
    case "dom_snapshot":
      if (operation.includeText !== undefined && typeof operation.includeText !== "boolean") throw protectedBrowserError("Protected browser includeText is invalid", 400);
      if (operation.limit !== undefined && !finiteNonnegative(operation.limit)) throw protectedBrowserError("Protected browser limit is invalid", 400);
      break;
    case "links":
    case "accessibility":
      if (operation.limit !== undefined && !finiteNonnegative(operation.limit)) throw protectedBrowserError("Protected browser limit is invalid", 400);
      break;
    case "query_selector":
    case "click_selector":
      assertExactString(operation.selector, "selector");
      if ("limit" in operation && operation.limit !== undefined && !finiteNonnegative(operation.limit)) throw protectedBrowserError("Protected browser limit is invalid", 400);
      if ("index" in operation && operation.index !== undefined && !finiteNonnegative(operation.index)) throw protectedBrowserError("Protected browser index is invalid", 400);
      break;
    case "fill_selector":
      assertExactString(operation.selector, "selector");
      if (typeof operation.text !== "string") throw protectedBrowserError("Protected browser public text is invalid", 400);
      if (operation.index !== undefined && !finiteNonnegative(operation.index)) throw protectedBrowserError("Protected browser index is invalid", 400);
      break;
    case "type_public":
      if (typeof operation.text !== "string") throw protectedBrowserError("Protected browser public text is invalid", 400);
      break;
    case "click":
      if (!Number.isFinite(operation.x) || !Number.isFinite(operation.y)) throw protectedBrowserError("Protected browser coordinates are invalid", 400);
      break;
    default:
      break;
  }
}

interface OperationPermit {
  binding: ProtectedBrowserBinding;
  denialEpoch: number;
}

interface RegisteredViewer {
  kind: "vnc" | "cdp";
  close: () => Promise<void>;
}

function oneShotCleanup(cleanup: () => MaybePromise<void>): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => {
    result ??= Promise.resolve().then(cleanup);
    return result;
  };
}

/**
 * Generic, capability-bound protected browser coordinator.
 *
 * Workspace schema/runtime authority and Chromium/CDP semantics are injected.
 * This class owns exact epoch checks, forced private persistence, serialization,
 * control handoff, denial latching, and proactive revocation cleanup.
 */
export class CapabilityBoundProtectedBrowser {
  readonly storage: ProtectedBrowserStorage;
  private binding: ProtectedBrowserBinding;
  private controlMode: ProtectedBrowserControlMode = "agent";
  private revoked = false;
  private denialEpoch = 0;
  private queueTail: Promise<void> = Promise.resolve();
  private abortController = new AbortController();
  private viewers = new Map<string, RegisteredViewer>();
  private pendingLeaseWork = new Set<Promise<unknown>>();
  private credentialHandles = new Set<{ revoke(): MaybePromise<void> }>();
  private unsubscribe: (() => void) | undefined;
  private cleanupPromise: Promise<void> = Promise.resolve();
  private realmCleanupPromise: Promise<void> | undefined;

  constructor(private readonly options: ProtectedBrowserOptions) {
    assertProtectedBrowserBinding(options.binding);
    this.binding = { ...options.binding };
    this.controlMode = options.initialControlMode ?? "agent";
    this.storage = ensureProtectedBrowserStorage(
      options.dataDir,
      this.binding.projectId,
      this.binding.agentProfileId,
      this.binding.projectCwd,
      this.binding.capabilityId,
    );
    this.installSubscription();
  }

  get currentBinding(): Readonly<ProtectedBrowserBinding> {
    return { ...this.binding };
  }

  get mode(): ProtectedBrowserControlMode {
    return this.controlMode;
  }

  get isRevoked(): boolean {
    return this.revoked;
  }

  private installSubscription(): void {
    this.unsubscribe?.();
    // Policy invalidation tears down the pair realm. Ordinary runtime/model
    // replacement calls revoke(), which ends only this exclusive lease.
    this.unsubscribe = this.options.authority.subscribe?.(this.binding, () => { void this.revokeRealm(); });
  }

  private permitStillCurrent(permit: OperationPermit): boolean {
    return !this.revoked
      && permit.denialEpoch === this.denialEpoch
      && exactProtectedBrowserBindingEqual(permit.binding, this.binding);
  }

  private async authorize(
    checkpoint: ProtectedBrowserAuthorityCheckpoint,
    permit?: OperationPermit,
  ): Promise<ProtectedBrowserAuthoritySnapshot> {
    if (this.revoked || (permit && !this.permitStillCurrent(permit))) {
      throw protectedBrowserError("Protected browser authority has been revoked");
    }
    const awaitedBinding = { ...this.binding };
    const awaitedDenialEpoch = this.denialEpoch;
    let snapshot: ProtectedBrowserAuthoritySnapshot | null = null;
    try {
      snapshot = await this.options.authority.resolve(awaitedBinding, checkpoint);
    } catch {
      this.latchRevoked();
      throw protectedBrowserError(`Protected browser authority failed at ${checkpoint}`);
    }
    if (
      this.revoked
      || this.denialEpoch !== awaitedDenialEpoch
      || !exactProtectedBrowserBindingEqual(this.binding, awaitedBinding)
      || (permit && !this.permitStillCurrent(permit))
    ) {
      throw protectedBrowserError("Protected browser authority has been revoked");
    }
    if (!snapshotAllowsProtectedBrowser(snapshot, awaitedBinding) || !exactProtectedBrowserBindingEqual(snapshot, awaitedBinding)) {
      this.latchRevoked();
      throw protectedBrowserError(`Protected browser authority changed at ${checkpoint}`);
    }
    return snapshot;
  }

  private latchRevoked(): void {
    if (this.revoked) return;
    this.revoked = true;
    this.denialEpoch += 1;
    this.abortController.abort(protectedBrowserError("Protected browser authority has been revoked"));
    this.binding = {
      ...this.binding,
      controlGeneration: Number.isSafeInteger(this.binding.controlGeneration + 1)
        ? this.binding.controlGeneration + 1
        : Number.MAX_SAFE_INTEGER,
    };
    this.unsubscribe?.();
    this.unsubscribe = undefined;

    const viewers = [...this.viewers.values()];
    const pendingLeaseWork = [...this.pendingLeaseWork];
    const credentialHandles = [...this.credentialHandles];
    this.viewers.clear();
    this.credentialHandles.clear();
    const cleanupBinding = { ...this.binding };
    // Invoke lease-choice invalidation in the synchronous denial turn. Pair
    // credential taint/document/human state deliberately remains realm-owned.
    let credentialLeaseCleanup: Promise<void>;
    try { credentialLeaseCleanup = Promise.resolve(this.options.credentials?.revokeLease(cleanupBinding)); }
    catch (error) { credentialLeaseCleanup = Promise.reject(error); }
    this.cleanupPromise = Promise.allSettled([
      ...viewers.map((viewer) => Promise.resolve().then(() => viewer.close())),
      ...credentialHandles.map((handle) => Promise.resolve().then(() => handle.revoke())),
      ...pendingLeaseWork,
      credentialLeaseCleanup,
      this.queueTail.catch(() => undefined),
    ]).then(() => undefined);
  }

  /** Denial-first revocation of one source-session/runtime lease only. */
  async revoke(): Promise<void> {
    this.latchRevoked();
    await this.cleanupPromise;
  }

  /** Durable pair invalidation: deny the lease before stopping its realm. */
  revokeRealm(): Promise<void> {
    this.latchRevoked();
    if (!this.realmCleanupPromise) this.options.onRealmRevoked?.();
    this.realmCleanupPromise ??= (async () => {
      await this.cleanupPromise;
      const binding = { ...this.binding };
      await Promise.allSettled([
        Promise.resolve().then(() => this.options.credentials?.revokeRealm?.(binding)),
        Promise.resolve().then(() => this.options.backend.stop({ binding, storage: this.storage })),
      ]);
    })();
    return this.realmCleanupPromise;
  }

  async close(): Promise<void> {
    await this.revoke();
    await this.realmCleanupPromise;
  }

  private trackLeaseWork<T>(operation: () => Promise<T>): Promise<T> {
    const work = operation();
    const tracked = work.then(() => undefined, () => undefined);
    this.pendingLeaseWork.add(tracked);
    void tracked.finally(() => { this.pendingLeaseWork.delete(tracked); });
    return work;
  }

  /** Track a lease-bound route/broker operation so takeover awaits its denial. */
  runLeaseWork<T>(operation: () => Promise<T>): Promise<T> {
    if (this.revoked) return Promise.reject(protectedBrowserError("Protected browser authority has been revoked"));
    return this.trackLeaseWork(operation);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queueTail;
    let release!: () => void;
    this.queueTail = new Promise<void>((resolve) => { release = resolve; });
    return previous.catch(() => undefined).then(operation).finally(release);
  }

  async execute<T = unknown>(operation: ProtectedBrowserOperation): Promise<T> {
    assertPlainExactOperation(operation);
    if (AGENT_CONTROL_OPERATION_KINDS.has(operation.kind) && this.controlMode !== "agent") {
      throw protectedBrowserError("Protected browser agent control is paused", 409);
    }
    await this.authorize("prequeue");
    const permit: OperationPermit = { binding: { ...this.binding }, denialEpoch: this.denialEpoch };
    const normalizedOperation = Object.freeze(operation.kind === "navigate"
      ? { ...operation, url: normalizeProtectedBrowserHttpsUrl(operation.url) }
      : { ...operation }) as ProtectedBrowserOperation;

    return this.serialize(async () => {
      if (AGENT_CONTROL_OPERATION_KINDS.has(normalizedOperation.kind) && this.controlMode !== "agent") {
        throw protectedBrowserError("Protected browser agent control changed while queued", 409);
      }
      await this.authorize("dequeue", permit);
      let preCdpChecked = false;
      const result = await this.options.backend.execute(normalizedOperation, {
        binding: permit.binding,
        storage: this.storage,
        signal: this.abortController.signal,
        assertAuthorized: async () => {
          await this.authorize("pre-cdp", permit);
          preCdpChecked = true;
        },
      });
      if (!this.permitStillCurrent(permit)) throw protectedBrowserError("Protected browser authority has been revoked");
      if (CDP_OPERATION_KINDS.has(normalizedOperation.kind) && !preCdpChecked) {
        this.latchRevoked();
        void this.revokeRealm();
        throw protectedBrowserError("Protected browser backend omitted the pre-CDP authority check");
      }
      if (CDP_OPERATION_KINDS.has(normalizedOperation.kind)) {
        if (!result.topLevelUrl) {
          this.latchRevoked();
          void this.revokeRealm();
          throw protectedBrowserError("Protected browser CDP result omitted top-level URL attestation");
        }
        const allowed = normalizedOperation.kind === "navigate"
          ? isProtectedBrowserHttpsUrl(result.topLevelUrl)
          : isProtectedBrowserAllowedTopLevelUrl(result.topLevelUrl);
        if (!allowed) {
          this.latchRevoked();
          void this.revokeRealm();
          throw protectedBrowserError("Protected browser top-level document is neither HTTPS nor inert");
        }
      }
      await this.authorize("prerelease", permit);
      return result.value as T;
    });
  }

  registerViewer(kind: "vnc" | "cdp", close: () => MaybePromise<void>): Promise<ProtectedBrowserViewerHandle> {
    return this.trackLeaseWork(async () => {
      if (typeof close !== "function") throw protectedBrowserError("Protected browser viewer close handle is invalid", 400);
      const closeOnce = oneShotCleanup(close);
      const permit: OperationPermit = { binding: { ...this.binding }, denialEpoch: this.denialEpoch };
      try {
        await this.authorize("viewer-attach", permit);
        if (!this.permitStillCurrent(permit)) throw protectedBrowserError("Protected browser authority has been revoked");
        const id = crypto.randomBytes(18).toString("base64url");
        this.viewers.set(id, { kind, close: closeOnce });
        return { id, kind };
      } catch (error) {
        await closeOnce().catch(() => undefined);
        throw error;
      }
    });
  }

  unregisterViewer(handle: ProtectedBrowserViewerHandle): void {
    this.viewers.delete(handle.id);
  }

  handleViewerMessage<T>(handle: ProtectedBrowserViewerHandle, dispatch: () => Promise<T>): Promise<T> {
    return this.trackLeaseWork(async () => {
      const viewer = this.viewers.get(handle.id);
      if (!viewer || viewer.kind !== handle.kind) throw protectedBrowserError("Protected browser viewer is unavailable");
      const permit: OperationPermit = { binding: { ...this.binding }, denialEpoch: this.denialEpoch };
      await this.authorize("viewer-message", permit);
      const result = await dispatch();
      await this.authorize("prerelease", permit);
      return result;
    });
  }

  registerCredentialHandle(handle: { revoke(): MaybePromise<void> }): void {
    if (!handle || typeof handle.revoke !== "function") throw protectedBrowserError("Protected browser credential handle is unavailable");
    const wrapped = { revoke: oneShotCleanup(() => handle.revoke()) };
    if (this.revoked) {
      void wrapped.revoke().catch(() => undefined);
      throw protectedBrowserError("Protected browser credential handle is unavailable");
    }
    this.credentialHandles.add(wrapped);
  }

  private async transitionControl(
    mode: ProtectedBrowserControlMode,
    checkpoint: "control-handoff" | "control-resume" | "credential-handoff" | "credential-resume",
  ): Promise<void> {
    const permit: OperationPermit = { binding: { ...this.binding }, denialEpoch: this.denialEpoch };
    await this.authorize(checkpoint, permit);
    const transition = this.options.authority.transitionControl;
    if (!transition) throw protectedBrowserError("Protected browser control transition authority is unavailable");
    const next = await transition(permit.binding, mode);
    if (!this.permitStillCurrent(permit)) throw protectedBrowserError("Protected browser authority has been revoked");
    if (
      !snapshotAllowsProtectedBrowser(next, permit.binding)
      || !stableBindingEqualExceptControl(next, permit.binding)
      || next.controlGeneration <= permit.binding.controlGeneration
    ) {
      this.latchRevoked();
      void this.revokeRealm();
      throw protectedBrowserError("Protected browser control transition was not exact");
    }
    this.binding = Object.fromEntries(BINDING_KEYS.map((key) => [key, next[key]])) as unknown as ProtectedBrowserBinding;
    assertProtectedBrowserBinding(this.binding);
    this.controlMode = mode;
    this.options.onControlModeChanged?.(mode, this.binding.controlGeneration);
    this.abortController.abort(protectedBrowserError("Protected browser control epoch changed", 409));
    this.abortController = new AbortController();
    this.installSubscription();
    await this.authorize(checkpoint);
  }

  /** Trusted backend control for CAPTCHA, payment, recovery, or other human-only steps. */
  handoffToUser(mode: "user" | "paused" = "user"): Promise<void> {
    return this.trackLeaseWork(() => this.transitionControl(mode, "control-handoff"));
  }

  /** Trusted backend resume; the injected port owns fresh-document readiness checks. */
  resumeAgentControl(): Promise<void> {
    return this.trackLeaseWork(async () => {
      if (this.controlMode !== "user" && this.controlMode !== "paused") {
        throw protectedBrowserError("Protected browser is not in human control", 409);
      }
      const permit: OperationPermit = { binding: { ...this.binding }, denialEpoch: this.denialEpoch };
      await this.authorize("control-resume", permit);
      await this.options.credentials?.assertSafeResume?.(permit.binding);
      if (!this.permitStillCurrent(permit)) throw protectedBrowserError("Protected browser authority has been revoked");
      await this.transitionControl("agent", "control-resume");
    });
  }

  beginCredentialHandoff(): Promise<void> {
    return this.trackLeaseWork(async () => {
      const permit: OperationPermit = { binding: { ...this.binding }, denialEpoch: this.denialEpoch };
      await this.authorize("credential-handoff", permit);
      const handle = await this.options.credentials?.beginHandoff?.(permit.binding);
      if (!this.permitStillCurrent(permit)) {
        if (handle) await oneShotCleanup(() => handle.revoke())().catch(() => undefined);
        throw protectedBrowserError("Protected browser authority has been revoked");
      }
      if (handle) this.registerCredentialHandle(handle);
      await this.transitionControl("user", "credential-handoff");
    });
  }

  /** UI-only one-use transition for redacted text/DOM inspection in the filled document. */
  allowAgentInspectionAfterCredentialFill(): Promise<void> {
    return this.trackLeaseWork(async () => {
      if (this.controlMode !== "user" && this.controlMode !== "paused") {
        throw protectedBrowserError("Protected browser is not in human control", 409);
      }
      const permit: OperationPermit = { binding: { ...this.binding }, denialEpoch: this.denialEpoch };
      await this.authorize("credential-resume", permit);
      await this.options.credentials?.assertInspectionAllowed?.(permit.binding);
      if (!this.permitStillCurrent(permit)) throw protectedBrowserError("Protected browser authority has been revoked");
      await this.transitionControl("agent", "credential-resume");
    });
  }

  resumeAgentAfterCredentialHandoff(): Promise<void> {
    return this.trackLeaseWork(async () => {
      if (this.controlMode !== "user" && this.controlMode !== "paused") {
        throw protectedBrowserError("Protected browser is not in human control", 409);
      }
      const permit: OperationPermit = { binding: { ...this.binding }, denialEpoch: this.denialEpoch };
      await this.authorize("credential-resume", permit);
      await this.options.credentials?.assertSafeResume?.(permit.binding);
      if (!this.permitStillCurrent(permit)) throw protectedBrowserError("Protected browser authority has been revoked");
      await this.transitionControl("agent", "credential-resume");
    });
  }
}
