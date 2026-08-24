import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureE2eProject, openSessionInUi, repoRoot, type CreatedSession } from "./helpers/sessions";

const SYNTHETIC_PIN = "12345678";

interface SeededMutationSession {
  session: CreatedSession;
  transcriptPath: string;
  userEventId: string;
}

async function seedMutationSession(
  request: APIRequestContext,
  oldText: string,
): Promise<SeededMutationSession> {
  const title = `e2e transcript mutation ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`;
  await ensureE2eProject(request, repoRoot);
  const session: CreatedSession = { id: randomUUID(), cwd: repoRoot, title };
  const sessionsRoot = process.env.WAYANG_E2E_PI_SESSIONS_DIR;
  if (!sessionsRoot) throw new Error("WAYANG_E2E_PI_SESSIONS_DIR is unavailable");

  const cwdSlug = `--${session.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const directory = path.join(sessionsRoot, cwdSlug);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const transcriptPath = path.join(directory, `${Date.now()}_${session.id}.jsonl`);
  const userEventId = `${session.id.slice(0, 8)}-user`;
  const assistantEventId = `${session.id.slice(0, 8)}-assistant`;
  const now = Date.now();
  const nameEventId = `${session.id.slice(0, 8)}-name`;
  const lines = [
    {
      type: "session",
      version: 3,
      id: session.id,
      timestamp: new Date(now).toISOString(),
      cwd: session.cwd,
    },
    {
      type: "session_info",
      id: nameEventId,
      parentId: null,
      timestamp: new Date(now).toISOString(),
      name: title,
    },
    {
      type: "message",
      id: userEventId,
      parentId: nameEventId,
      timestamp: new Date(now + 1).toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: oldText }],
        timestamp: now + 1,
      },
    },
    {
      type: "message",
      id: assistantEventId,
      parentId: userEventId,
      timestamp: new Date(now + 2).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Synthetic assistant reply for transcript mutation coverage." }],
        provider: "synthetic",
        model: "synthetic",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: now + 2,
      },
    },
  ];
  fs.writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  const imported = await request.post("/api/sessions/import");
  expect(imported.ok(), await imported.text()).toBe(true);
  return { session, transcriptPath, userEventId };
}

async function openMutationDialog(page: Page, eventId: string, oldText: string): Promise<void> {
  const userMessage = page
    .locator('[data-testid="chat-message"][data-role="user"]')
    .filter({ hasText: oldText })
    .first();
  await expect(userMessage).toBeVisible({ timeout: 30_000 });
  const persistedRow = page.locator(`[data-message-id="${eventId}"]`).first();
  await persistedRow.getByTestId("transcript-event-manage").click();
  await expect(page.getByTestId("transcript-event-manager")).toBeVisible();
  await page.getByTestId("transcript-event-edit").click();
  await expect(page.getByTestId("transcript-mutation-dialog")).toBeVisible();
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await expect(page.getByTestId("transcript-event-text-input")).toHaveValue(oldText);
}

async function searchContainsSession(
  request: APIRequestContext,
  query: string,
  sessionId: string,
): Promise<boolean> {
  const response = await request.get(`/api/sessions/search?${new URLSearchParams({ q: query }).toString()}`);
  expect(response.ok(), await response.text()).toBe(true);
  const body = await response.json() as { results?: Array<{ session_id?: string }> };
  return (body.results ?? []).some((result) => result.session_id === sessionId);
}

test("PIN-gated human event edit refreshes canonical history and purges old search text", async ({ page, request }) => {
  const oldText = `accidental-wrong-session-${Date.now()}`;
  const replacementText = `corrected-session-message-${Date.now()}`;
  const finalText = `corrected-session-message-final-${Date.now()}`;
  const seeded = await seedMutationSession(request, oldText);

  await openSessionInUi(page, seeded.session);
  await expect(page.getByTestId("chat-message-list")).toHaveAttribute("data-transcript-state", "ready", { timeout: 45_000 });
  await openMutationDialog(page, seeded.userEventId, oldText);

  await page.getByTestId("transcript-event-text-input").fill(replacementText);
  await page.getByTestId("transcript-mutation-pin").fill(SYNTHETIC_PIN);
  await page.getByTestId("transcript-mutation-submit").click();

  await expect(page.getByTestId("transcript-mutation-dialog")).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await expect.poll(() => fs.readFileSync(seeded.transcriptPath, "utf8"), { timeout: 10_000 }).toContain(replacementText);
  await expect(page.getByTestId("chat-message-list").getByText(replacementText, { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("chat-message-list").getByText(oldText, { exact: true })).toHaveCount(0);

  // A trusted server marker from the first edit must remain in expected_entry
  // for CAS, while being stripped from the second editable replacement payload.
  await openMutationDialog(page, seeded.userEventId, replacementText);
  await page.getByTestId("transcript-event-text-input").fill(finalText);
  await page.getByTestId("transcript-mutation-pin").fill(SYNTHETIC_PIN);
  await page.getByTestId("transcript-mutation-submit").click();
  // The shared hardened PIN authority deliberately rate-limits a second
  // mutation in the same session. Keep the exact reviewed dialog open, wait
  // beyond the 30-second cooldown, then resubmit with a freshly entered PIN.
  await expect(page.getByTestId("transcript-mutation-error")).toContainText("cooling down");
  await expect(page.getByTestId("transcript-mutation-pin")).toHaveValue("");
  await page.waitForTimeout(31_000);
  await page.getByTestId("transcript-mutation-pin").fill(SYNTHETIC_PIN);
  await page.getByTestId("transcript-mutation-submit").click();
  await expect(page.getByTestId("chat-message-list").getByText(finalText, { exact: true })).toBeVisible({ timeout: 45_000 });

  const exact = await request.get(`/api/sessions/${encodeURIComponent(seeded.session.id)}/events/${encodeURIComponent(seeded.userEventId)}`);
  expect(exact.ok(), await exact.text()).toBe(true);
  const exactBody = await exact.json() as {
    entry?: {
      message?: { content?: Array<{ type?: string; text?: string }> };
      wayangMutation?: { version?: number; kind?: string; at?: string };
    };
  };
  expect(exactBody.entry?.message?.content?.[0]?.text).toBe(finalText);
  expect(exactBody.entry?.wayangMutation).toMatchObject({ version: 1, kind: "edited" });

  const canonicalBytes = fs.readFileSync(seeded.transcriptPath, "utf8");
  expect(canonicalBytes).toContain(finalText);
  expect(canonicalBytes).not.toContain(replacementText);
  expect(canonicalBytes).not.toContain(oldText);
  expect(await searchContainsSession(request, finalText, seeded.session.id)).toBe(true);
  expect(await searchContainsSession(request, replacementText, seeded.session.id)).toBe(false);
  expect(await searchContainsSession(request, oldText, seeded.session.id)).toBe(false);
});

test("an ambiguous client failure after commit forces authoritative history refresh", async ({ page, request }) => {
  const oldText = `ambiguous-original-${Date.now()}`;
  const replacementText = `ambiguous-committed-${Date.now()}`;
  const seeded = await seedMutationSession(request, oldText);
  // The previous test intentionally completes a verified mutation; the shared
  // synthetic PIN authority preserves its cooldown across browser tests.
  await page.waitForTimeout(31_000);

  await openSessionInUi(page, seeded.session);
  await expect(page.getByTestId("chat-message-list")).toHaveAttribute("data-transcript-state", "ready", { timeout: 45_000 });
  await openMutationDialog(page, seeded.userEventId, oldText);

  const editUrl = `**/api/sessions/${encodeURIComponent(seeded.session.id)}/events/${encodeURIComponent(seeded.userEventId)}/edit`;
  await page.route(editUrl, async (route) => {
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });
  await page.getByTestId("transcript-event-text-input").fill(replacementText);
  await page.getByTestId("transcript-mutation-pin").fill(SYNTHETIC_PIN);
  await page.getByTestId("transcript-mutation-submit").click();

  await expect(page.getByTestId("transcript-mutation-dialog")).toHaveCount(0);
  await expect(page.getByTestId("chat-message-list").getByText(replacementText, { exact: true })).toBeVisible({ timeout: 45_000 });
  expect(fs.readFileSync(seeded.transcriptPath, "utf8")).toContain(replacementText);
});

test("a rejected PIN leaves canonical event bytes unchanged", async ({ page, request }) => {
  const oldText = `pin-rejection-original-${Date.now()}`;
  const attemptedText = `pin-rejection-attempt-${Date.now()}`;
  const seeded = await seedMutationSession(request, oldText);
  const before = fs.readFileSync(seeded.transcriptPath, "utf8");

  await openSessionInUi(page, seeded.session);
  await expect(page.getByTestId("chat-message-list")).toHaveAttribute("data-transcript-state", "ready", { timeout: 45_000 });
  await openMutationDialog(page, seeded.userEventId, oldText);

  await page.getByTestId("transcript-event-text-input").fill(attemptedText);
  await page.getByTestId("transcript-mutation-pin").fill("00000000");
  await page.getByTestId("transcript-mutation-submit").click();

  await expect(page.getByTestId("transcript-mutation-error")).toBeVisible();
  await expect(page.getByTestId("transcript-mutation-pin")).toHaveValue("");
  expect(fs.readFileSync(seeded.transcriptPath, "utf8")).toBe(before);
});
