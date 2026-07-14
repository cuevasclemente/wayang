/**
 * session-search.spec.ts — Playwright coverage for the session history search
 * feature documented in docs/session-history-search.md.
 *
 * These tests seed sessions via the backend HTTP API and then drive the
 * SessionsPanel filter UI directly. They do not rely on a real pi instance
 * because the PI_OFFLINE flag in playwright.config.ts keeps pi from
 * actually starting.
 */

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { repoRoot } from "./helpers/sessions";

async function seedSessionWithTranscript(
  request: import("@playwright/test").APIRequestContext,
  opts: { title: string; transcript: Array<{ role: "user" | "assistant"; text: string; id?: string }> },
): Promise<{ id: string; cwd: string; piSessionFile: string }> {
  const create = await request.post("/api/sessions", {
    data: { cwd: repoRoot, title: opts.title },
  });
  expect(create.ok(), await create.text()).toBe(true);
  const session = await create.json();

  // Synthesize a pi JSONL file in the e2e pi sessions dir so the indexer
  // picks it up via the standard mtime watcher.
  const piSessionsDir =
    process.env.WAYANG_E2E_PI_SESSIONS_DIR || process.env.PI_CODING_AGENT_SESSION_DIR;
  if (!piSessionsDir) {
    throw new Error(
      "neither WAYANG_E2E_PI_SESSIONS_DIR nor PI_CODING_AGENT_SESSION_DIR is set",
    );
  }
  // pi encodes the cwd into the directory name as `--<path>--` with
  // path separators replaced by `-`. Must match SessionManager.getDefaultSessionDir.
  const cwdSlug = `--${session.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const dir = path.join(piSessionsDir, cwdSlug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}_${session.id}.jsonl`);
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "session",
      version: 3,
      id: session.id,
      cwd: session.cwd,
      timestamp: new Date().toISOString(),
    }),
  );
  for (let i = 0; i < opts.transcript.length; i++) {
    const t = opts.transcript[i];
    lines.push(
      JSON.stringify({
        type: "message",
        id: t.id ?? `${session.id}-m${i}`,
        message: { role: t.role, content: [{ type: "text", text: t.text }] },
      }),
    );
  }
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");

  // Ask the backend to import canonical pi session files so the new file is
  // adopted into the store immediately.
  const importRes = await request.post("/api/sessions/import");
  expect(importRes.ok(), `import failed: ${await importRes.text()}`).toBe(true);

  // Force a synchronous, per-session reindex so the chunk is searchable
  // without waiting for the 30s mtime tick.
  const reindex = await request.post("/api/sessions/search/reindex", {
    data: { session_id: session.id },
  });
  expect(reindex.ok(), `reindex failed: ${await reindex.text()}`).toBe(true);

  return { id: session.id, cwd: session.cwd, piSessionFile: file };
}

async function pollSearch(
  request: import("@playwright/test").APIRequestContext,
  query: string,
  expectedSessionId: string,
  filters: Record<string, string> = {},
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last = "no probe yet";
  while (Date.now() < deadline) {
    const params = new URLSearchParams({ q: query, ...filters });
    const res = await request.get(`/api/sessions/search?${params.toString()}`);
    last = await res.text();
    if (res.ok()) {
      const body = JSON.parse(last);
      if ((body.results || []).some((r: { session_id: string }) => r.session_id === expectedSessionId)) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`session search did not return expected id ${expectedSessionId} within 30s. last=${last}`);
}

async function typeSearchQuery(page: Page, query: string): Promise<void> {
  const input = page.getByTestId("session-search-input");
  await expect(input).toBeVisible();
  await input.fill(query);
}

test("session search returns transcript matches with highlighting", async ({ page, request }) => {
  const session = await seedSessionWithTranscript(request, {
    title: `e2e search transcript ${Date.now()}`,
    transcript: [
      { role: "user", text: "Why does my ssh tunnel to build-host keep dropping?" },
      {
        role: "assistant",
        text: "Use BatchMode=yes and ServerAliveInterval=30 to keep the ssh tunnel stable.",
      },
    ],
  });

  await pollSearch(request, "ssh tunnel", session.id);

  await page.goto("/");
  await expect(page.getByTestId("session-search-input")).toBeVisible({ timeout: 20_000 });

  await typeSearchQuery(page, "ssh tunnel");

  const results = page.getByTestId("session-search-results");
  await expect(results).toBeVisible({ timeout: 10_000 });

  const result = page.getByTestId("session-search-result").filter({ hasText: "e2e search transcript" }).first();
  await expect(result).toBeVisible();
  await expect(result.locator("mark").first()).toBeVisible();
});

test("toggling Include archived surfaces archived sessions", async ({ page, request }) => {
  const session = await seedSessionWithTranscript(request, {
    title: `e2e archived search ${Date.now()}`,
    transcript: [
      { role: "user", text: "Investigating kalshi forecasting calibration drift across thesis groups." },
      { role: "assistant", text: "Brier score binning helps verify kalshi calibration." },
    ],
  });

  // Archive the session.
  const archived = await request.delete(`/api/sessions/${encodeURIComponent(session.id)}`);
  expect(archived.ok()).toBe(true);

  // Reindex so archived flag is captured.
  await request.post("/api/sessions/search/reindex", { data: { session_id: session.id } });

  await pollSearch(request, "kalshi calibration", session.id, { archived: "any" });

  await page.goto("/");
  await expect(page.getByTestId("session-search-input")).toBeVisible({ timeout: 20_000 });

  // Default: archived hidden — no match for our archived-only session.
  await typeSearchQuery(page, "kalshi calibration");
  await page.waitForTimeout(500); // debounce + network
  const before = page.getByTestId("session-search-result").filter({ hasText: "e2e archived search" });
  await expect(before).toHaveCount(0);

  // Open filters and toggle Include archived.
  await page.getByRole("button", { name: /Filters/ }).click();
  await page.getByLabel("Include archived").check();

  const after = page.getByTestId("session-search-result").filter({ hasText: "e2e archived search" }).first();
  await expect(after).toBeVisible({ timeout: 10_000 });
});

test("clicking a search result navigates into the chat", async ({ page, request }) => {
  const session = await seedSessionWithTranscript(request, {
    title: `e2e click result ${Date.now()}`,
    transcript: [
      { role: "user", text: "Find the place I was debugging websocket disconnection storms." },
    ],
  });

  await pollSearch(request, "websocket disconnection", session.id);

  await page.goto("/");
  await typeSearchQuery(page, "websocket disconnection");
  const result = page
    .getByTestId("session-search-result")
    .filter({ hasText: "e2e click result" })
    .first();
  await expect(result).toBeVisible({ timeout: 10_000 });
  await result.click();

  // After click, ChatPanel should mount and render the user message we seeded.
  await expect(
    page.getByTestId("chat-message-list").getByText("Find the place I was debugging websocket disconnection storms.", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
});
