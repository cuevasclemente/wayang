import type { Router } from "express";
import type { MatrixHsTokenVerifier } from "./auth.js";
import type { MatrixDeliveryWorker, MatrixDeliveryWorkerStatus } from "./delivery-worker.js";
import type { MatrixProvisioningService, MatrixProvisioningStatus } from "./provisioning.js";
import {
  createMatrixApplicationServiceRouter,
  createUnavailableMatrixApplicationServiceRouter,
} from "./routes.js";
import type { MatrixApplicationService } from "./service.js";
import type { MatrixTypingController } from "./typing.js";

export interface MatrixProductionTimerPort {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DisabledMatrixProductionOptions {
  readonly enabled: false;
}

export interface EnabledMatrixProductionOptions {
  readonly enabled: true;
  readonly verifier: MatrixHsTokenVerifier;
  readonly service: MatrixApplicationService;
  readonly provisioning: MatrixProvisioningService;
  readonly deliveryWorker: MatrixDeliveryWorker;
  readonly typing: MatrixTypingController;
  readonly endpointIds: readonly string[];
  readonly timer?: MatrixProductionTimerPort;
  readonly provisioningRetryBaseMs?: number;
  readonly provisioningRetryMaximumMs?: number;
  readonly now?: () => number;
}

export type MatrixProductionOptions = DisabledMatrixProductionOptions | EnabledMatrixProductionOptions;

export interface MatrixProductionStatus {
  readonly enabled: boolean;
  readonly started: boolean;
  readonly ready: boolean;
  readonly provisioningAttentionCount: number;
  readonly delivery: MatrixDeliveryWorkerStatus["code"] | "disabled";
}

export interface MatrixProductionBootstrap {
  readonly router: Router;
  start(): Promise<void>;
  status(): MatrixProductionStatus;
  close(): Promise<void>;
}

const systemTimer: MatrixProductionTimerPort = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

class DisabledBootstrap implements MatrixProductionBootstrap {
  readonly router = createUnavailableMatrixApplicationServiceRouter();
  async start(): Promise<void> { /* deliberately inert */ }
  status(): MatrixProductionStatus {
    return Object.freeze({ enabled: false, started: false, ready: false, provisioningAttentionCount: 0, delivery: "disabled" });
  }
  async close(): Promise<void> { /* idempotently inert */ }
}

class EnabledBootstrap implements MatrixProductionBootstrap {
  readonly router: Router;
  private readonly timer: MatrixProductionTimerPort;
  private readonly retryBase: number;
  private readonly retryMaximum: number;
  private readonly attempts = new Map<string, number>();
  private retryTimer: unknown | null = null;
  private provisionRun: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly options: EnabledMatrixProductionOptions) {
    if (new Set(options.endpointIds).size !== options.endpointIds.length) throw new Error("Duplicate Matrix production endpoint");
    this.timer = options.timer ?? systemTimer;
    this.retryBase = options.provisioningRetryBaseMs ?? 1_000;
    this.retryMaximum = options.provisioningRetryMaximumMs ?? 5 * 60_000;
    if (!Number.isInteger(this.retryBase) || this.retryBase < 100
      || !Number.isInteger(this.retryMaximum) || this.retryMaximum < this.retryBase || this.retryMaximum > 60 * 60_000) {
      throw new Error("Invalid Matrix provisioning retry bounds");
    }
    this.router = createMatrixApplicationServiceRouter({ verifier: options.verifier, service: options.service });
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.closed) return Promise.reject(new Error("Matrix production bootstrap is closed"));
    this.startPromise = (async () => {
      // Durable gateway recovery is complete before transaction ingress becomes ready.
      await this.options.service.start();
      if (this.closed) return;
      this.started = true;
      this.options.deliveryWorker.start();
      this.launchProvisioning();
    })();
    return this.startPromise;
  }

  private launchProvisioning(): void {
    if (this.closed || this.provisionRun) return;
    const run = (async () => {
      let retryDelay: number | null = null;
      for (const endpointId of this.options.endpointIds) {
        if (this.closed) break;
        try {
          const result = await this.options.provisioning.ensureEndpoint(endpointId);
          this.attempts.delete(endpointId);
          if (result.status.code !== "ready") retryDelay = Math.min(retryDelay ?? this.retryBase, this.retryBase);
        } catch {
          const code = this.options.provisioning.getStatus(endpointId).code;
          if (code === "encrypted_required" || code === "declaration_changed" || code === "room_binding_conflict") continue;
          const attempt = (this.attempts.get(endpointId) ?? 0) + 1;
          this.attempts.set(endpointId, attempt);
          const delay = Math.min(this.retryMaximum, this.retryBase * (2 ** Math.min(attempt - 1, 10)));
          retryDelay = retryDelay === null ? delay : Math.min(retryDelay, delay);
        }
      }
      if (!this.closed && retryDelay !== null && this.retryTimer === null) {
        this.retryTimer = this.timer.setTimeout(() => {
          this.retryTimer = null;
          this.launchProvisioning();
        }, retryDelay);
      }
    })().finally(() => {
      if (this.provisionRun === run) this.provisionRun = null;
    });
    this.provisionRun = run;
  }

  status(): MatrixProductionStatus {
    const attention = this.options.provisioning.listStatuses()
      .filter((row: MatrixProvisioningStatus) => row.code !== "ready").length;
    const service = this.options.service.status();
    return Object.freeze({
      enabled: true,
      started: this.started,
      ready: service.ready && service.accepting,
      provisioningAttentionCount: Math.min(attention, this.options.endpointIds.length),
      delivery: this.options.deliveryWorker.status().code,
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    // Stop ingress/new claims, then await any one active connector turn per
    // endpoint before the root server tears down Pi session runtimes.
    this.options.service.stopAdmission();
    if (this.retryTimer !== null) this.timer.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.closePromise = Promise.allSettled([
      this.options.service.close(),
      this.options.typing.close(),
      this.provisionRun ?? Promise.resolve(),
      this.options.deliveryWorker.close(),
    ]).then(() => undefined);
    return this.closePromise;
  }
}

/** All configuration and effects are injected; disabled construction is inert. */
export function createMatrixProductionBootstrap(options: MatrixProductionOptions): MatrixProductionBootstrap {
  return options.enabled ? new EnabledBootstrap(options) : new DisabledBootstrap();
}
