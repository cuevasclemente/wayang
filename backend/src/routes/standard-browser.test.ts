import assert from "node:assert/strict";
import test from "node:test";
import type { ProtectedBrowserBinding } from "../browser/types.js";
import { createStandardBrowserIntegration } from "./standard-browser.js";

function binding(): ProtectedBrowserBinding {
  return {
    capabilityId: "wayang.standard-browser.v1",
    sourceSessionId: "session-a",
    projectId: "project-a",
    projectCwd: "/synthetic/project-a",
    agentProfileId: "agent-a",
    associationRevision: 4,
    runtimeGeneration: "runtime-a",
    processBootNonce: "boot-a",
    controlGeneration: 1,
  };
}

test("owner selection resolves an existing detached workspace without consulting Pi runtime authority", () => {
  const workspace = { profile: { id: "profile-a" }, workspaceGeneration: "workspace-a" } as any;
  let ownerCalls = 0;
  const service = {
    resolveOwnerWorkspace(sourceSessionId: string, projectCwd?: string) {
      ownerCalls += 1;
      if (sourceSessionId !== "session-a" || (projectCwd && projectCwd !== "/synthetic/project-a")) return null;
      return {
        authority: {
          sourceSessionId,
          projectId: "project-a",
          projectCwd: "/synthetic/project-a",
          agentProfileId: "agent-a",
          associationRevision: 4,
        },
        workspace,
      };
    },
  } as any;
  const integration = createStandardBrowserIntegration(service);
  const selection = integration.select({ targetSessionId: "session-a", projectCwd: "/synthetic/project-a", transport: "http" });
  assert.deepEqual(selection, {
    sourceSessionId: "session-a",
    projectId: "project-a",
    projectCwd: "/synthetic/project-a",
    agentProfileId: "agent-a",
    associationRevision: 4,
    profileId: "profile-a",
    workspaceGeneration: "workspace-a",
  });
  assert.equal(integration.resolve(selection!)?.workspace, workspace);
  assert.ok(ownerCalls >= 2);
});

test("owner selections are exact, generation-bound, and reject agent headers or caller storage selectors", () => {
  const exact = binding();
  const service = {
    resolveOwnerWorkspace(sourceSessionId: string) {
      return sourceSessionId === exact.sourceSessionId ? {
        authority: {
          sourceSessionId,
          projectId: exact.projectId,
          projectCwd: exact.projectCwd,
          agentProfileId: exact.agentProfileId,
          associationRevision: exact.associationRevision,
        },
        workspace: { profile: { id: "profile-a" }, workspaceGeneration: "workspace-a" },
      } : null;
    },
  } as any;
  const integration = createStandardBrowserIntegration(service);
  assert.equal(integration.select({ sourceSessionId: "other", targetSessionId: exact.sourceSessionId, transport: "http" }), null);
  assert.equal(integration.select({ targetSessionId: exact.sourceSessionId, requestedPersistence: "shared", transport: "http" }), null);
  assert.equal(integration.select({ targetSessionId: exact.sourceSessionId, requestedScope: "project", transport: "http" }), null);
  const selection = integration.select({ targetSessionId: exact.sourceSessionId, transport: "http" })!;
  assert.equal(integration.resolve({ ...selection, workspaceGeneration: "stale" }), null);
  assert.equal(integration.resolve({ ...selection, associationRevision: selection.associationRevision + 1 }), null);
});
