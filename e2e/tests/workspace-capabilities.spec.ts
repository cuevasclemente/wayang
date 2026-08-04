import { expect, test, type Page, type Route } from "@playwright/test";

const standardProjectId = "project-quartz-91";
const protectedProjectId = "project-night-42";
const profileId = "profile-cobalt-73";
const secondProfileId = "profile-lattice-18";
const provider = "provider-orchid";
const model = "model-cascade";
const requestId = "request-capability-association";
const approvalEventId = "approval-event-22";
const syntheticPin = "24681357";

const catalog = [
  {
    id: "wayang.standard-resources.v1",
    compatiblePrivacyMode: "standard",
    title: "Standard resources",
    riskSummary: "Reviewed global resources outside project-only scope.",
  },
  {
    id: "wayang.host-execution.v1",
    compatiblePrivacyMode: "standard",
    title: "Host execution",
    riskSummary: "Direct execution as the Wayang OS user.",
  },
  {
    id: "wayang.protected-browser.v1",
    compatiblePrivacyMode: "protected",
    title: "Protected browser",
    riskSummary: "Broad control of a persistent authenticated browser.",
  },
] as const;

function project(id: string, name: string, privacyMode: "standard" | "protected") {
  const now = Date.now();
  return {
    id,
    cwd: `/synthetic/${id}`,
    name,
    description: null,
    color: null,
    default_agent_profile_id: profileId,
    default_provider: provider,
    default_model: model,
    access_policy: { privacy_mode: privacyMode, allowed_agent_profile_ids: [profileId, secondProfileId] },
    created_at: now,
    updated_at: now,
  };
}

function profile(id: string, name: string) {
  const now = Date.now();
  return {
    id,
    name,
    description: null,
    enabled: true,
    resource_mode: "project_only",
    memory_access: "none",
    default_provider: provider,
    default_model: model,
    allowed_tools: null,
    allowed_extensions: null,
    created_at: now,
    updated_at: now,
  };
}

interface SyntheticCapabilityApi {
  activationRequests: Record<string, unknown>[];
  commitBodies: Record<string, unknown>[];
  revokeBodies: Record<string, unknown>[];
  statusReads: number;
}

async function installSyntheticApi(page: Page, options: { modelDiscoveryFails?: boolean } = {}): Promise<SyntheticCapabilityApi> {
  const projects = [
    project(standardProjectId, "Quartz Orchard", "standard"),
    project(protectedProjectId, "Night Archive", "protected"),
  ];
  const profiles = [profile(profileId, "Cobalt Finch"), profile(secondProfileId, "Lattice Observer")];
  const api: SyntheticCapabilityApi = {
    activationRequests: [],
    commitBodies: [],
    revokeBodies: [],
    statusReads: 0,
  };
  let association: Record<string, unknown> | null = null;
  let approvalEvent: Record<string, unknown> | null = null;

  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === "GET" || method === "HEAD" ? {} : (request.postDataJSON() ?? {}) as Record<string, unknown>;

    if (path === "/api/auth/status") return route.fulfill({ json: { enabled: false, authenticated: true } });
    if (path === "/api/me") return route.fulfill({ json: { username: "synthetic-user", provider: "synthetic", version: "test" } });
    if (path === "/api/models") {
      if (options.modelDiscoveryFails) return route.fulfill({ status: 503, json: { error: "Synthetic model discovery offline" } });
      return route.fulfill({ json: {
        models: [{ provider, id: model, name: "Cascade", api: "synthetic", reasoning: false, input: ["text"], contextWindow: 32_000, available: true }],
        defaultModel: { provider, id: model, name: "Cascade" },
      } });
    }
    if (path === "/api/key-mode") return route.fulfill({ json: { mode: "default" } });
    if (path === "/api/projects/discover" || path === "/api/fs/discover-projects") return route.fulfill({ json: [] });
    if (path === "/api/projects") return route.fulfill({ json: projects });
    if (path === "/api/agent-profiles" && method === "GET") return route.fulfill({ json: profiles });
    if (path.startsWith("/api/agent-profiles/") && method === "GET") {
      const id = decodeURIComponent(path.slice("/api/agent-profiles/".length));
      const row = profiles.find((candidate) => candidate.id === id);
      return route.fulfill({ json: { ...row, instructions: "Synthetic profile instructions" } });
    }
    if (path === "/api/sessions") return route.fulfill({ json: [] });
    if (path === "/api/sessions/events") return route.fulfill({ status: 204 });
    if (path === "/api/scheduled-agent-jobs") return route.fulfill({ json: { jobs: [] } });

    if (path === "/api/workspace-capabilities" && method === "GET") {
      api.statusReads += 1;
      return route.fulfill({ json: {
        capabilities: catalog,
        associations: association ? [association] : [],
        approvalEvents: approvalEvent ? [approvalEvent] : [],
        history: { returned: approvalEvent ? 1 : 0, limit: 100, hasMore: false },
      } });
    }

    if (path === "/api/workspace-capabilities/requests" && method === "POST") {
      api.activationRequests.push(structuredClone(body));
      return route.fulfill({ json: {
        requestId,
        operationDigest: "digest-operation-abc123",
        previewStateDigest: "digest-preview-def456",
        expiresAt: Date.now() + 120_000,
        capabilityId: "wayang.protected-browser.v1",
        projectId: protectedProjectId,
        projectLabel: "Night Archive",
        projectCwd: `/synthetic/${protectedProjectId}`,
        privacyMode: "protected",
        agentProfileId: profileId,
        agentProfileLabel: "Cobalt Finch",
        profileEnabled: true,
        profileAllowed: true,
        association: { before: null, after: { active: true, revision: 1 } },
        summary: "Associate protected browser with the synthetic Project-Agent pair",
        consequences: [
          "The agent may navigate, click, type non-secret text, download, and cause remote mutations.",
          "Existing authenticated cookies may permit purchases, deletion, exports, or account-setting changes.",
        ],
        affectedRuntimes: [{ runtimeId: "runtime-synthetic-1", status: "idle" }],
      } });
    }

    if (path === `/api/workspace-capabilities/requests/${requestId}/commit` && method === "POST") {
      api.commitBodies.push(structuredClone(body));
      const now = Date.now();
      association = {
        capabilityId: "wayang.protected-browser.v1",
        projectId: protectedProjectId,
        agentProfileId: profileId,
        revision: 1,
        active: true,
        approvedAt: now,
        revokedAt: null,
        updatedAt: now,
      };
      approvalEvent = {
        id: approvalEventId,
        capabilityId: "wayang.protected-browser.v1",
        projectId: protectedProjectId,
        agentProfileId: profileId,
        associationRevision: 1,
        operationDigest: "digest-operation-abc123",
        approvedAt: now,
        revokedAt: null,
      };
      return route.fulfill({ json: { association } });
    }

    if (path === "/api/workspace-capability-associations/revoke" && method === "POST") {
      api.revokeBodies.push(structuredClone(body));
      const now = Date.now();
      association = { ...association!, revision: 2, active: false, revokedAt: now, updatedAt: now };
      approvalEvent = { ...approvalEvent!, revokedAt: now };
      return route.fulfill({ json: { association } });
    }

    if (path.startsWith("/api/workspace-capabilities/requests/") && method === "DELETE") {
      return route.fulfill({ status: 204 });
    }

    return route.fulfill({ json: {} });
  });

  return api;
}

test("capability Settings uses model-independent Project-Agent associations, exact-revision revocation, and separate audit history", async ({ page }) => {
  const api = await installSyntheticApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace and capability settings" }).click();

  const settings = page.getByRole("dialog", { name: "Workspace settings" });
  await settings.getByRole("tab", { name: "Capabilities" }).click();
  await expect(settings.getByText("Backend-issued capability catalog", { exact: true })).toBeVisible();

  for (const capability of catalog) {
    await expect(settings.getByText(capability.id, { exact: true })).toBeVisible();
  }
  await expect(settings).toContainText("Names are labels only; provider and model are fluid runtime choices, not authority.");
  await expect(settings).toContainText("any model currently used by this Agent Profile in this Project");
  await expect(settings).toContainText("Model switches invalidate old runtime actions and rebuild lazily, but do not require another PIN.");
  await expect(settings).toContainText("disable/re-enable of the same stable profile ID");
  await expect(settings.getByLabel("Exact provider/model tuple")).toHaveCount(0);
  await expect(settings).not.toContainText(`${provider}/${model}`);

  await settings.getByRole("button", { name: /Host execution/ }).click();
  await expect(settings).toContainText("Host execution runs as the Wayang OS user outside the filesystem sandbox.");
  await expect(settings).toContainText("A person authenticated to a remotely exposed Wayang instance can trigger those host effects.");

  await settings.getByRole("button", { name: /Protected browser/ }).click();
  await expect(settings).toContainText("The agent may navigate, click, type non-secret text, download, and cause remote mutations.");
  await expect(settings).toContainText("human login handoff does not make later actions read-only");

  await settings.getByLabel("Project").selectOption(protectedProjectId);
  await settings.getByLabel("Agent profile").selectOption(profileId);
  await settings.getByRole("button", { name: "Review association" }).click();

  expect(api.activationRequests).toEqual([{
    capabilityId: "wayang.protected-browser.v1",
    projectId: protectedProjectId,
    agentProfileId: profileId,
  }]);

  const challenge = page.getByRole("dialog", { name: "Associate protected browser with the synthetic Project-Agent pair" });
  await expect(challenge).toBeVisible();
  await expect(challenge).toContainText("wayang.protected-browser.v1");
  await expect(challenge).toContainText(`Night Archive · ${protectedProjectId}`);
  await expect(challenge).toContainText(`Cobalt Finch · ${profileId}`);
  await expect(challenge).toContainText("new → 1");
  await expect(challenge).toContainText("digest-preview-def456");
  await expect(challenge).toContainText("across every provider/model change");
  await expect(challenge).toContainText("re-enabling the same ID restores it through a fresh runtime without another PIN");
  await expect(challenge).toContainText("exact-profile allowlist exclusion, incompatible privacy, or subject deletion ends it");
  await expect(challenge).toContainText("revocation cannot undo completed effects");
  await expect(challenge).not.toContainText(provider);
  await expect(challenge).not.toContainText(model);
  await expect(challenge).toContainText("runtime-synthetic-1 (idle)");

  const pin = challenge.getByLabel("8-digit identity PIN");
  await expect(pin).toHaveAttribute("type", "password");
  await expect(pin).toHaveAttribute("autocomplete", "off");
  await pin.fill("2468abcd");
  await expect(pin).toHaveValue("2468");
  await pin.fill(syntheticPin);
  await expect(pin).toHaveValue(syntheticPin);
  await challenge.getByRole("button", { name: "Associate capability" }).click();

  await expect(challenge).toBeHidden();
  await expect.poll(() => api.commitBodies).toEqual([{ pin: syntheticPin }]);
  await expect.poll(() => api.statusReads).toBeGreaterThanOrEqual(2);

  const current = settings.getByRole("region", { name: "Current associations" });
  const history = settings.getByRole("region", { name: "Approval history" });
  await expect(current.getByText("ACTIVE", { exact: true })).toBeVisible();
  await expect(current).toContainText("Association revision 1");
  await expect(current).not.toContainText(approvalEventId);
  await expect(history).toContainText(approvalEventId);
  await expect(history).toContainText("association revision 1");
  await expect(history).toContainText("digest-operation-abc123");
  await expect(settings).toContainText("A fresh runtime can use it with any model selected for that agent.");
  expect(await page.evaluate(() => `${Object.values(localStorage).join("")} ${Object.values(sessionStorage).join("")}`)).not.toContain(syntheticPin);

  page.once("dialog", (dialog) => dialog.accept());
  await current.getByRole("button", { name: "Revoke" }).click();
  await expect.poll(() => api.revokeBodies).toEqual([{
    capabilityId: "wayang.protected-browser.v1",
    projectId: protectedProjectId,
    agentProfileId: profileId,
    expectedRevision: 1,
  }]);
  await expect(current.getByText("INACTIVE", { exact: true })).toBeVisible();
  await expect(current).toContainText("Association revision 2");
  await expect(history).toContainText("revoked");
  await expect(settings).toContainText("Prior filesystem, process, credential, network, download, or remote-account effects remain");
  await expect(current.getByRole("button", { name: "Revoke" })).toHaveCount(0);
});

test("capability Settings does not depend on provider/model discovery", async ({ page }) => {
  await installSyntheticApi(page, { modelDiscoveryFails: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace and capability settings" }).click();

  const settings = page.getByRole("dialog", { name: "Workspace settings" });
  await settings.getByRole("tab", { name: "Capabilities" }).click();
  await expect(settings.getByText("Backend-issued capability catalog", { exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Review association" })).toBeVisible();
  await expect(settings).not.toContainText("Synthetic model discovery offline");
});

test("agent editor candidly preserves associations through definition edits and disable/re-enable while keeping model defaults", async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace and capability settings" }).click();

  const settings = page.getByRole("dialog", { name: "Workspace settings" });
  await settings.getByRole("tab", { name: "Agents" }).click();
  await settings.getByRole("button", { name: /Cobalt Finch/ }).click();

  await expect(settings.getByLabel("Default provider/model")).toBeVisible();
  await expect(settings).toContainText("The stable profile ID—not its name, definition, provider, or model—is the agent identity used by capability associations.");
  await expect(settings).toContainText("Renaming it or changing instructions, tools, resources, memory, or defaults preserves them.");
  await expect(settings).toContainText("Disabling blocks all runtimes but does not remove associations");
  await expect(settings).toContainText("re-enabling this same ID restores them through fresh runtime handles without another PIN");
  await expect(settings).toContainText("a replacement or clone never inherits them");
});
