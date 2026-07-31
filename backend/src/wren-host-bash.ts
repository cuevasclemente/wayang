/**
 * @deprecated Incremental-build compatibility only. New integrations must use
 * host-execution.ts. These aliases do not preserve Wren identity, flag, UUID,
 * name, kind, or legacy `wren_host` authorization semantics.
 */
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
  buildHostChildEnvironment,
  createHostBashOperations,
  createHostBashToolDefinition,
  installHostBashRegistryGuard,
  resolveHostBashExecutable,
  resolveHostExecutionAuthorization,
  type CreateHostBashOptions,
  type ExactHostExecutionCapabilityWitness,
  type HostBashRegistryGuard,
  type HostEnvironmentOptions,
  type HostExecutionAuthorizationFacts,
  type HostExecutionMode,
  type HostExecutionRequest,
} from "./host-execution.js";

export type WayangBashMode = HostExecutionMode | "wren_host";
export interface WrenHostAuthorizationDecision {
  allowed: boolean;
  reason?: string;
  witness?: ExactHostExecutionCapabilityWitness;
}
export type WrenHostBashRegistryGuard = HostBashRegistryGuard;
export type WrenHostEnvironmentOptions = HostEnvironmentOptions;
export type WrenHostExecutionRequest = HostExecutionRequest;

export interface WrenHostAuthorizationFacts {
  /** Ignored. The removed environment/configuration flag never grants authority. */
  configEnabled?: boolean;
  capabilityWitness?: ExactHostExecutionCapabilityWitness | null;
  row: HostExecutionAuthorizationFacts["row"];
  profile: HostExecutionAuthorizationFacts["profile"];
  project: HostExecutionAuthorizationFacts["project"];
  requestedCwd: string;
  authorization: HostExecutionAuthorizationFacts["authorization"];
  isInteractive?: boolean;
  isSubagent: boolean;
  execution?: Omit<
    NonNullable<HostExecutionAuthorizationFacts["execution"]>,
    "selectedBashMode" | "expectedCapabilityWitness"
  > & {
    selectedBashMode: WayangBashMode;
    expectedCapabilityWitness?: ExactHostExecutionCapabilityWitness;
  };
}

export interface CreateWrenHostBashOptions {
  authorizeExecution: (request: WrenHostExecutionRequest) => WrenHostAuthorizationDecision;
  operations?: BashOperations;
  environmentOptions?: WrenHostEnvironmentOptions;
}

export function resolveWrenHostAuthorization(
  facts: WrenHostAuthorizationFacts,
): WrenHostAuthorizationDecision {
  return resolveHostExecutionAuthorization({
    capabilityWitness: facts.capabilityWitness,
    row: facts.row,
    profile: facts.profile,
    project: facts.project,
    requestedCwd: facts.requestedCwd,
    authorization: facts.authorization,
    isInteractive: facts.isInteractive === true,
    isSubagent: facts.isSubagent,
    execution: facts.execution as HostExecutionAuthorizationFacts["execution"],
  });
}

export const buildWrenHostChildEnvironment = buildHostChildEnvironment;
export const resolveWrenHostBashExecutable = resolveHostBashExecutable;
export const installWrenHostBashRegistryGuard = installHostBashRegistryGuard;

function genericOptions(options: CreateWrenHostBashOptions): CreateHostBashOptions {
  return {
    operations: options.operations,
    environmentOptions: options.environmentOptions,
    authorizeExecution: (request) => {
      const decision = options.authorizeExecution(request);
      return decision.allowed === true && decision.witness
        ? { allowed: true, witness: decision.witness }
        : { allowed: false, reason: decision.reason ?? "exact host capability authorization failed" };
    },
  };
}

export function createWrenHostBashOperations(options: CreateWrenHostBashOptions): BashOperations {
  return createHostBashOperations(genericOptions(options));
}

export function createWrenHostBashToolDefinition(cwd: string, options: CreateWrenHostBashOptions): any {
  return createHostBashToolDefinition(cwd, genericOptions(options));
}
