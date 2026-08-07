import type { ProtectedAutomationJobRow } from "./types.js";
import type { ProtectedAutomationBinding } from "./authority.js";
import type { ProtectedAutomationManagedRuntime } from "./browser-realm.js";
import {
  ProtectedAutomationBrowserRealmRegistry,
  type ProtectedAutomationBrowserLeaseBinding,
  type ProtectedAutomationBrowserRealmAcquire,
  type ProtectedAutomationViewerRegistration,
} from "./browser-realm.js";

export interface ProtectedAutomationPreparationViewerContext {
  runtime: ProtectedAutomationManagedRuntime;
  signal: AbortSignal;
  /** Viewer transports must wrap every inbound viewer message with this gate. */
  handleMessage<T>(dispatch: () => Promise<T>): Promise<T>;
  /** Required immediately before each transport-owned CDP command. */
  assertAuthorized(): Promise<void>;
}

export interface ProtectedAutomationPreparationViewerTransport {
  open(context: ProtectedAutomationPreparationViewerContext): Promise<ProtectedAutomationViewerRegistration>;
}

export interface ProtectedAutomationPreparationLease {
  readonly binding: Readonly<ProtectedAutomationBrowserLeaseBinding>;
  readonly signal: AbortSignal;
  attachViewer(transport: ProtectedAutomationPreparationViewerTransport): Promise<ProtectedAutomationViewerRegistration>;
  saveAndClose(lastSavedAt: number): Promise<void>;
  close(): Promise<void>;
}

export interface ProtectedAutomationPreparationMetadata {
  preparation_id: string;
  source_session_id: string;
  job_id: string;
  job_revision: number;
  state: "waiting_for_owner" | "ready" | "closed";
  websocket_path: string;
}

export interface ProtectedAutomationPreparationPort {
  /** Synchronously denial-latch any realm bound to an obsolete job revision. */
  jobChanged(jobId: string): void;
  prepare(input: {
    binding: Readonly<ProtectedAutomationBinding>;
    job: Readonly<ProtectedAutomationJobRow>;
    assertAuthorized(): void;
  }): Promise<ProtectedAutomationPreparationMetadata>;
}

let productionPreparationPort: ProtectedAutomationPreparationPort | null = null;

export function installProtectedAutomationPreparationPort(port: ProtectedAutomationPreparationPort | null): () => void {
  if (port && productionPreparationPort && productionPreparationPort !== port) {
    throw new Error("Protected automation preparation port is already installed");
  }
  productionPreparationPort = port;
  return () => { if (productionPreparationPort === port) productionPreparationPort = null; };
}

export function getProtectedAutomationPreparationPort(): ProtectedAutomationPreparationPort | null {
  return productionPreparationPort;
}

/**
 * Route-free preparation core. HTTP/WebSocket authentication, origin checks,
 * credential brokering, and UI publication are supplied by production composition.
 */
export class ProtectedAutomationBrowserPreparationCore {
  constructor(private readonly realms: ProtectedAutomationBrowserRealmRegistry) {}

  async acquire(
    request: Omit<ProtectedAutomationBrowserRealmAcquire, "kind" | "runRoot">,
  ): Promise<ProtectedAutomationPreparationLease> {
    const lease = this.realms.acquire({ ...request, kind: "prepare" });
    try { await lease.assertAuthorized(); } catch (error) {
      await lease.close();
      throw error;
    }
    return {
      binding: lease.binding,
      signal: lease.signal,
      attachViewer: async (transport) => {
        if (!transport || typeof transport.open !== "function") throw new Error("Browser preparation viewer transport is unavailable");
        await lease.start();
        let registration!: ProtectedAutomationViewerRegistration;
        registration = await transport.open({
          runtime: lease.runtime,
          signal: lease.signal,
          assertAuthorized: () => lease.assertAuthorized(),
          handleMessage: <T>(dispatch: () => Promise<T>) => lease.handleViewerMessage(registration.id, dispatch),
        });
        let closePromise: Promise<void> | undefined;
        const closeOnce = () => {
          closePromise ??= Promise.resolve().then(() => registration.close());
          return closePromise;
        };
        const guardedRegistration = { id: registration.id, close: closeOnce };
        try { await lease.registerViewer(guardedRegistration); } catch (error) {
          await closeOnce().catch(() => undefined);
          throw error;
        }
        return {
          id: registration.id,
          close: async () => {
            lease.unregisterViewer(registration.id);
            await closeOnce();
          },
        };
      },
      saveAndClose: (lastSavedAt) => lease.saveAndClosePreparation(lastSavedAt),
      close: () => lease.close(),
    };
  }
}
