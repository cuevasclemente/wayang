import type { ProtectedAutomationBinding } from "./authority.js";
import type { ProtectedAutomationJobRow } from "./types.js";

export interface ProtectedAutomationPurgeIntentPublicState {
  request_id: string;
  job_id: string;
  state: "awaiting_owner_pin";
  requested_at: number;
  expires_at: number;
}

export interface ProtectedAutomationPurgeIntentPort {
  request(input: {
    binding: Readonly<ProtectedAutomationBinding>;
    job: Readonly<ProtectedAutomationJobRow>;
    assertAuthorized(): void | Promise<void>;
  }): Promise<ProtectedAutomationPurgeIntentPublicState>;
}

let productionPurgeIntentPort: ProtectedAutomationPurgeIntentPort | null = null;

export function installProtectedAutomationPurgeIntentPort(
  port: ProtectedAutomationPurgeIntentPort | null,
): () => void {
  if (port && productionPurgeIntentPort && productionPurgeIntentPort !== port) {
    throw new Error("Protected automation purge-intent port is already installed");
  }
  productionPurgeIntentPort = port;
  return () => { if (productionPurgeIntentPort === port) productionPurgeIntentPort = null; };
}

export function getProtectedAutomationPurgeIntentPort(): ProtectedAutomationPurgeIntentPort | null {
  return productionPurgeIntentPort;
}
