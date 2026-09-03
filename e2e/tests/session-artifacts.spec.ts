import { expect, test, type Page } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

const markdownId = "11111111-1111-4111-8111-111111111111";
const htmlId = "22222222-2222-4222-8222-222222222222";

function artifact(id: string, renderer: "markdown" | "html", name: string) {
  return {
    id,
    name,
    display_path: `reports/${name}`,
    title: renderer === "markdown" ? "Synthetic report" : "Untrusted HTML",
    description: "Synthetic artifact fixture",
    source: "presented",
    renderer,
    language: renderer,
    size: 100,
    modified_at: Date.now(),
    last_seen_at: Date.now(),
    available: true,
    unavailable_reason: null,
    preview_available: true,
    preview_unavailable_reason: null,
    download_available: true,
    download_unavailable_reason: null,
  };
}

async function mockArtifactCatalog(page: Page, sessionId: string, artifacts: ReturnType<typeof artifact>[]) {
  await page.route(new RegExp(`/api/sessions/${sessionId}/artifacts$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session_id: sessionId, revision: artifacts.length, artifacts }),
    });
  });
}

test("Artifacts replaces Files, migrates saved state, and safely previews Markdown and HTML", async ({ page, request }) => {
  const session = await createE2eSession(request, "e2e session artifacts");
  await page.addInitScript(({ sessionId }) => {
    window.localStorage.setItem(`wayang:right-panel-tab:${sessionId}`, "files");
  }, { sessionId: session.id });

  await mockArtifactCatalog(page, session.id, [artifact(markdownId, "markdown", "report.md"), artifact(htmlId, "html", "unsafe.html")]);
  await page.route(new RegExp(`/api/sessions/${session.id}/artifacts/([^/]+)/preview$`), async (route) => {
    const id = route.request().url().split("/").at(-2);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(id === htmlId
        ? {
            artifact_id: htmlId,
            renderer: "html",
            language: "html",
            sha256: "b".repeat(64),
            text: `<article><h1>Safe body</h1><script>window.__artifactExecuted=true</script><img src="https://example.invalid/leak"><form><input></form><p style="background:url(https://example.invalid/leak)">Text</p><a href="javascript:alert(1)">bad link</a></article>`,
          }
        : {
            artifact_id: markdownId,
            renderer: "markdown",
            language: "markdown",
            sha256: "a".repeat(64),
            text: "# Synthetic Markdown\n\n![remote](https://example.invalid/leak.png)\n",
          }),
    });
  });

  await openSessionInUi(page, session);
  await expect(page.getByRole("button", { name: "Artifacts", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Files$/i })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Synthetic Markdown" })).toBeVisible();
  await expect(page.getByText(/Remote image blocked/)).toBeVisible();
  expect(await page.evaluate((sessionId) => window.localStorage.getItem(`wayang:right-panel-tab:${sessionId}`), session.id)).toBe("artifacts");

  await page.getByRole("option", { name: /Untrusted HTML/ }).click();
  const frame = page.frameLocator('iframe[title="Sanitized preview of Untrusted HTML"]');
  await expect(frame.getByRole("heading", { name: "Safe body" })).toBeVisible();
  await expect(frame.locator("script, img, form, input")).toHaveCount(0);
  await expect(frame.locator("p[style], a[href]")).toHaveCount(0);
});

test("mobile Tools opens the session Artifacts surface", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const session = await createE2eSession(request, "e2e mobile artifacts");
  await mockArtifactCatalog(page, session.id, [artifact(markdownId, "markdown", "mobile.md")]);
  await page.route(new RegExp(`/api/sessions/${session.id}/artifacts/${markdownId}/preview$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        artifact_id: markdownId,
        renderer: "markdown",
        language: "markdown",
        sha256: "c".repeat(64),
        text: "# Mobile artifact\n",
      }),
    });
  });
  await page.goto(`/sessions/${session.id}`);
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await expect(page.getByRole("button", { name: "Artifacts", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Mobile artifact" })).toBeVisible();
});
