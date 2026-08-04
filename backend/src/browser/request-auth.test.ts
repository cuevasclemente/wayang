import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyGenericBrowserSourceSession,
  classifyGenericBrowserTarget,
  type DurableBrowserTargetStore,
} from "./request-auth.js";

function storeFixture(): DurableBrowserTargetStore {
  const projects = [
    {
      id: "standard-project",
      cwd: "/synthetic/standard",
      name: "Sensitive sounding standard project",
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null },
    },
    {
      id: "quarantine-project",
      cwd: "/synthetic/quarantine",
      name: "Ordinary legacy private work",
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null },
    },
    {
      id: "protected-project",
      cwd: "/synthetic/protected",
      name: "Arbitrary future private work",
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: ["arbitrary-profile"] },
    },
    {
      id: "second-protected-project",
      cwd: "/synthetic/protected-two",
      name: "Independent private work",
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: ["second-profile"] },
    },
    {
      id: "malformed-legacy-project",
      cwd: "/synthetic/malformed-legacy",
      name: "Malformed imported work",
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null },
    },
  ] as any[];
  const sessions = [
    { id: "standard-session", cwd: "/synthetic/standard", agent_profile_id: "arbitrarily-named-profile", legacy_private_session_quarantine: false },
    { id: "protected-session", cwd: "/synthetic/protected", agent_profile_id: "arbitrary-profile", legacy_private_session_quarantine: false },
    { id: "legacy-protected-session", cwd: "/synthetic/protected", agent_profile_id: "arbitrary-profile", legacy_private_session_quarantine: true },
    { id: "protected-session-two", cwd: "/synthetic/protected-two", agent_profile_id: "second-profile", legacy_private_session_quarantine: false },
    { id: "quarantined-session", cwd: "/synthetic/quarantine", agent_profile_id: "ordinary-profile", legacy_private_session_quarantine: true },
    { id: "malformed-legacy-session", cwd: "/synthetic/malformed-legacy", agent_profile_id: "ordinary-profile" },
  ] as any[];
  return {
    getSessionById(id) { return sessions.find((session) => session.id === id); },
    getProjectByCwd(cwd) { return projects.find((project) => project.cwd === cwd); },
  } as DurableBrowserTargetStore;
}

test("generic browser classification uses only durable privacy/quarantine state, never names", () => {
  const store = storeFixture();
  assert.equal(classifyGenericBrowserTarget({ sessionId: "standard-session" }, store), "standard");
  assert.equal(classifyGenericBrowserTarget({ projectCwd: "/synthetic/standard" }, store), "standard");
  assert.equal(classifyGenericBrowserTarget({ sessionId: "protected-session" }, store), "protected");
  assert.equal(classifyGenericBrowserTarget({ sessionId: "legacy-protected-session" }, store), "quarantined");
  assert.equal(classifyGenericBrowserTarget({ projectCwd: "/synthetic/protected" }, store), "protected");
  assert.equal(classifyGenericBrowserTarget({ sessionId: "protected-session-two" }, store), "protected");
  assert.equal(classifyGenericBrowserSourceSession("protected-session", store), "protected");
  assert.equal(classifyGenericBrowserSourceSession("quarantined-session", store), "quarantined");
});

test("a supplied protected cwd cannot be hidden behind a Standard durable session", () => {
  const store = storeFixture();
  assert.equal(classifyGenericBrowserTarget({
    sessionId: "standard-session",
    projectCwd: "/synthetic/protected-two",
  }, store), "protected");
});

test("missing legacy quarantine markers fail closed without changing ordinary Standard semantics", () => {
  const store = storeFixture();
  assert.equal(classifyGenericBrowserTarget({ sessionId: "malformed-legacy-session" }, store), "quarantined");
  assert.equal(classifyGenericBrowserTarget({ projectCwd: "/synthetic/malformed-legacy" }, store), "standard");
  assert.equal(classifyGenericBrowserTarget({ sessionId: "standard-session" }, store), "standard");
});
