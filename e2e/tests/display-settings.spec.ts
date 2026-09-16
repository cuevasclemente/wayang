import { expect, test } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

/**
 * The display-scale control lives in workspace settings and persists in
 * localStorage. It drives the document root font size so rem-based text and
 * spacing grow together.
 */
test("display scale is adjustable from settings and survives a reload", async ({ page, request }) => {
  const session = await createE2eSession(request, "e2e display scale");
  await openSessionInUi(page, session);

  const rootFontSize = () =>
    page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
  const baseline = await rootFontSize();
  expect(baseline).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Open workspace settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Workspace settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "Display" }).click();

  await page.getByTestId("ui-scale-preset-largest").click();
  await expect(page.getByTestId("ui-scale-value")).toHaveText("200%");
  expect(await rootFontSize()).toBeCloseTo(baseline * 2, 1);

  await page.reload();
  await expect.poll(rootFontSize).toBeCloseTo(baseline * 2, 1);

  await page.getByRole("button", { name: "Open workspace settings" }).click();
  await page.getByRole("dialog", { name: "Workspace settings" }).getByRole("tab", { name: "Display" }).click();
  await page.getByTestId("ui-scale-reset").click();
  await expect.poll(rootFontSize).toBeCloseTo(baseline, 1);
});
