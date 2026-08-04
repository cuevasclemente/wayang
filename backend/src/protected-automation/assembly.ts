import {
  ProtectedAutomationManager,
  setProtectedAutomationManager,
  type ProtectedAutomationManagerOptions,
} from "./manager.js";
import {
  ProtectedAutomationScheduler,
  setProtectedAutomationScheduler,
  type ProtectedAutomationSchedulerOptions,
} from "./scheduler.js";

export interface ProtectedAutomationServices {
  manager: ProtectedAutomationManager;
  scheduler: ProtectedAutomationScheduler;
  start(): void;
  stop(): Promise<void>;
}

/**
 * App-owned lifecycle seam. Constructing this does not activate the hidden
 * capability; it only makes already-authorized compiled runtimes dispatchable.
 */
export function createProtectedAutomationServices(options: {
  manager?: ProtectedAutomationManagerOptions;
  scheduler?: ProtectedAutomationSchedulerOptions;
} = {}): ProtectedAutomationServices {
  const manager = new ProtectedAutomationManager(options.manager);
  const scheduler = new ProtectedAutomationScheduler(manager, options.scheduler);
  let started = false;
  return {
    manager,
    scheduler,
    start() {
      if (started) return;
      started = true;
      try {
        setProtectedAutomationManager(manager);
        setProtectedAutomationScheduler(scheduler);
        manager.start();
        scheduler.start();
      } catch (failure) {
        started = false;
        try { scheduler.stop(); } catch {}
        try { setProtectedAutomationScheduler(null); } catch {}
        try { setProtectedAutomationManager(null); } catch {}
        void Promise.resolve().then(() => manager.stop()).catch(() => undefined);
        throw failure;
      }
    },
    async stop() {
      if (!started) return;
      started = false;
      // Every denial/teardown path is begun independently. A faulty timer
      // closer must never leave the manager/global dispatch surface published.
      try { scheduler.stop(); } catch { /* continue denial cleanup */ }
      try { setProtectedAutomationScheduler(null); } catch { /* continue */ }
      try { setProtectedAutomationManager(null); } catch { /* continue */ }
      await Promise.allSettled([Promise.resolve().then(() => manager.stop())]);
    },
  };
}
