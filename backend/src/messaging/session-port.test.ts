import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createAgentProfile } from "../agent-profiles.js";
import { close, flush, getStore, init } from "../db.js";
import { createProject } from "../projects.js";
import { archiveSession, createSession, updatePiSessionFile } from "../sessions.js";
import type { MessagingConversationBinding, MessagingEndpointDeclaration } from "./contracts.js";
import { ProductionWayangMessagingSessionPort } from "./session-port.js";

function withStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-messaging-port-"));
  const prior = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(dir, "data");
  close();
  init();
  return fn(dir).finally(() => {
    close();
    if (prior === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function setup(dir: string) {
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const profile = createAgentProfile({ name: "Port profile" });
  const project = createProject({ cwd, default_agent_profile_id: profile.id });
  const declaration: MessagingEndpointDeclaration = {
    endpointId: "port-endpoint",
    connectorId: "matrix",
    provisioningKey: "port-endpoint",
    projectId: project.id,
    agentProfileId: profile.id,
    displayName: "Port Agent",
    conversationMode: "shared",
    allowedSubjectIds: ["@alice:example.test"],
    transportSecurity: "unencrypted_accepted",
  };
  return { cwd, profile, project, declaration };
}

function binding(activeWayangSessionId: string | null): MessagingConversationBinding {
  return {
    endpointId: "port-endpoint",
    connectorId: "matrix",
    externalConversationId: "!room:example.test",
    activeWayangSessionId,
    revision: 2,
  };
}

test("production session port creates, lists, resolves, and reports only its exact Project/Profile scope", () => withStore(async (dir) => {
  const f = setup(dir);
  const port = new ProductionWayangMessagingSessionPort();
  const candidate = await port.createSessionCandidate(f.declaration, "event-a");
  assert.equal((await port.createSessionCandidate(f.declaration, "event-a")).id, candidate.id, "candidate creation is crash-idempotent");
  assert.equal(getStore().sessions.find((row) => row.id === candidate.id)?.project_id, f.project.id);
  assert.match(candidate.title, /Port Agent/);
  const listed = await port.listEligibleSessions(f.declaration, candidate.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.active, true);
  assert.equal((await port.resolveEligibleSession(f.declaration, candidate.id)).id, candidate.id);

  const otherProfile = createAgentProfile({ name: "Other profile" });
  const wrongProfile = createSession(f.cwd, { agentProfileId: otherProfile.id });
  await assert.rejects(port.resolveEligibleSession(f.declaration, wrongProfile.id), /not eligible/);

  const otherRoot = path.join(dir, "other-project");
  fs.mkdirSync(otherRoot);
  createProject({ cwd: otherRoot, default_agent_profile_id: f.profile.id });
  const wrongProject = createSession(otherRoot, { agentProfileId: f.profile.id });
  await assert.rejects(port.resolveEligibleSession(f.declaration, wrongProject.id), /not eligible/);

  const archived = createSession(f.cwd, { agentProfileId: f.profile.id });
  archiveSession(archived.id);
  await assert.rejects(port.resolveEligibleSession(f.declaration, archived.id), /not eligible/);

  const status = await port.getStatus(f.declaration, binding(candidate.id));
  assert.equal(status.projectId, f.project.id);
  assert.equal(status.agentProfileId, f.profile.id);
  assert.equal(status.activeSession?.id, candidate.id);
  assert.equal(status.runtimeStatus, "stopped");
}));

test("same-cwd Project replacement does not make an unresolved old session eligible", () => withStore(async (dir) => {
  const f = setup(dir);
  const oldSession = createSession(f.cwd, { agentProfileId: f.profile.id, title: "Old Project identity" });
  const replacementProjectId = "replacement-project-id";
  const store = getStore();
  const storedProject = store.projects.find((row) => row.id === f.project.id)!;
  storedProject.id = replacementProjectId;
  const storedSession = store.sessions.find((row) => row.id === oldSession.id)!;
  storedSession.project_id = null;
  storedSession.legacy_capability_ineligible = true;
  flush();

  const replacementDeclaration = { ...f.declaration, projectId: replacementProjectId };
  const port = new ProductionWayangMessagingSessionPort();
  assert.deepEqual(await port.listEligibleSessions(replacementDeclaration, null), []);
  await assert.rejects(
    port.resolveEligibleSession(replacementDeclaration, oldSession.id),
    /not eligible/,
  );
}));

test("origin inspection finds the exact persisted messaging custom-message marker", () => withStore(async (dir) => {
  const f = setup(dir);
  const row = createSession(f.cwd, { agentProfileId: f.profile.id });
  const file = path.join(dir, "session.jsonl");
  const digest = "a".repeat(64);
  fs.writeFileSync(file, [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "synthetic-messaging-session",
      timestamp: "2026-08-09T00:00:00.000Z",
      cwd: f.cwd,
    }),
    JSON.stringify({
      type: "custom_message",
      id: "origin-1",
      parentId: null,
      timestamp: "2026-08-09T00:00:01.000Z",
      customType: "wayang-messaging-input",
      content: "hello",
      display: true,
      details: {
        connector_id: "matrix",
        connector_event_id: "$event",
        endpoint_id: f.declaration.endpointId,
        canonical_event_sha256: digest,
      },
    }),
  ].join("\n") + "\n", "utf8");
  updatePiSessionFile(row.id, file);

  const port = new ProductionWayangMessagingSessionPort();
  assert.equal(await port.inspectOrigin(row.id, {
    connectorId: "matrix",
    connectorEventId: "$event",
    endpointId: f.declaration.endpointId,
    canonicalEventSha256: digest,
  }), "present");
  assert.equal(await port.inspectOrigin(row.id, {
    connectorId: "matrix",
    connectorEventId: "$other",
    endpointId: f.declaration.endpointId,
    canonicalEventSha256: digest,
  }), "absent");
}));
