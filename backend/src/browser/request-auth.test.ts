import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import {
  BROWSER_AGENT_SOURCE_SESSION_HEADER,
  BROWSER_AGENT_TOKEN_HEADER,
  classifyGenericBrowserSourceSession,
  classifyGenericBrowserTarget,
  createLegacyBrowserAgentAttributionRejection,
  LEGACY_BROWSER_AGENT_ATTRIBUTION_ERROR,
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

test("gate-off legacy attribution middleware delegates without inspecting request headers", () => {
  const req = Object.defineProperty({}, "headers", {
    get() { throw new Error("gate-off middleware inspected headers"); },
  }) as unknown as Request;
  let nextCalled = false;
  createLegacyBrowserAgentAttributionRejection(false)(
    req,
    {} as unknown as Response,
    (() => { nextCalled = true; }) as NextFunction,
  );
  assert.equal(nextCalled, true);
});

test("gate-on legacy attribution middleware rejects either header before parsing with no-store", () => {
  for (const header of [BROWSER_AGENT_TOKEN_HEADER, BROWSER_AGENT_SOURCE_SESSION_HEADER]) {
    const responseHeaders = new Map<string, string>();
    let statusCode: number | undefined;
    let body: unknown;
    let nextCalled = false;
    const req = Object.defineProperties({}, {
      headers: { value: { [header]: "synthetic-legacy-attribution" } },
      body: { get() { throw new Error("legacy rejection parsed the request body"); } },
    }) as unknown as Request;
    const res = {
      setHeader(name: string, value: string) {
        responseHeaders.set(name.toLowerCase(), value);
        return this;
      },
      status(value: number) {
        statusCode = value;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    } as unknown as Response;

    createLegacyBrowserAgentAttributionRejection(true)(
      req,
      res,
      (() => { nextCalled = true; }) as NextFunction,
    );

    assert.equal(nextCalled, false, header);
    assert.equal(statusCode, 403, header);
    assert.equal(responseHeaders.get("cache-control"), "no-store", header);
    assert.deepEqual(body, { error: LEGACY_BROWSER_AGENT_ATTRIBUTION_ERROR }, header);
  }
});

test("gate-on legacy attribution middleware preserves unattributed requests", () => {
  let nextCalled = false;
  createLegacyBrowserAgentAttributionRejection(true)(
    { headers: {} } as unknown as Request,
    {} as unknown as Response,
    (() => { nextCalled = true; }) as NextFunction,
  );
  assert.equal(nextCalled, true);
});

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
