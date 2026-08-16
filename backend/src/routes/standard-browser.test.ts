import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { WebSocket } from "ws";
import { StandardViewerInputError } from "../browser/standard-viewer.js";
import type { ProtectedBrowserBinding } from "../browser/types.js";
import { attachSelectedStandardViewer, createStandardBrowserIntegration, type StandardBrowserRouteSelection } from "./standard-browser.js";

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

class SyntheticViewerSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readonly CLOSING = 2;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readonly sent: Buffer[] = [];

  send(message: Buffer): void { this.sent.push(message); }
  close(code?: number, reason?: string): void {
    if (this.readyState === this.CLOSING || this.readyState === 3) return;
    this.closes.push({ code, reason });
    this.readyState = this.CLOSING;
    this.emit("close");
  }
}

function viewerSelection(): StandardBrowserRouteSelection {
  return {
    sourceSessionId: "session-a",
    projectId: "project-a",
    projectCwd: "/synthetic/project-a",
    agentProfileId: "agent-a",
    associationRevision: 4,
    profileId: "profile-a",
    workspaceGeneration: "workspace-a",
  };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a WebSocket closed during viewer opening cannot leak the resolved transport", async () => {
  const socket = new SyntheticViewerSocket();
  let resolveViewer!: (viewer: any) => void;
  let transportCloses = 0;
  const integration = {
    openViewer() { return new Promise((resolve) => { resolveViewer = resolve; }); },
  } as any;
  attachSelectedStandardViewer(socket as unknown as WebSocket, viewerSelection(), "cdp", integration);
  socket.close(1000, "synthetic owner left");
  resolveViewer({
    async dispatch() {},
    async close() { transportCloses += 1; },
    onMessage() { return () => undefined; },
  });
  await turn();
  assert.equal(transportCloses, 1);
});

test("Standard viewer dispatch failure closes the internal transport and owning WebSocket with a bounded reason", async () => {
  const socket = new SyntheticViewerSocket();
  let transportCloses = 0;
  const integration = {
    async openViewer() {
      return {
        async dispatch() { throw new StandardViewerInputError("input_authorization_failed"); },
        async close() { transportCloses += 1; },
        onMessage() { return () => undefined; },
      };
    },
  } as any;
  attachSelectedStandardViewer(socket as unknown as WebSocket, viewerSelection(), "cdp", integration);
  await turn();
  socket.emit("message", Buffer.from("{}"), false);
  await turn();
  assert.deepEqual(socket.closes, [{ code: 1008, reason: "input authorization failed" }]);
  assert.equal(transportCloses, 1);
  assert.doesNotMatch(JSON.stringify(socket.closes), /session-a|project-a|private/);
});

test("Standard viewer internal seal propagates to the owning WebSocket and remains reconnectable", async () => {
  const socket = new SyntheticViewerSocket();
  let closeListener: ((reason?: string) => void) | undefined;
  const integration = {
    async openViewer() {
      return {
        async dispatch() {},
        async close() {},
        onMessage() { return () => undefined; },
        onClose(listener: (reason?: string) => void) { closeListener = listener; return () => { closeListener = undefined; }; },
      };
    },
  } as any;
  attachSelectedStandardViewer(socket as unknown as WebSocket, viewerSelection(), "cdp", integration);
  await turn();
  closeListener?.("input_attestation_failed");
  assert.deepEqual(socket.closes, [{ code: 1011, reason: "input attestation failed" }]);

  const replacement = new SyntheticViewerSocket();
  attachSelectedStandardViewer(replacement as unknown as WebSocket, viewerSelection(), "cdp", integration);
  await turn();
  assert.equal(replacement.readyState, replacement.OPEN, "a fresh exact viewer can attach after failure");
});
