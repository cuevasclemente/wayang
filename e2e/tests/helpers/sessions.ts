import { expect, type APIRequestContext, type Page } from "@playwright/test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const repoRoot = path.resolve(__dirname, "../../..");

export interface CreatedSession {
  id: string;
  cwd: string;
  title: string;
}

export async function createE2eSession(request: APIRequestContext, titlePrefix: string): Promise<CreatedSession> {
  const title = `${titlePrefix} ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`;
  const createResponse = await request.post("/api/sessions", {
    data: {
      cwd: repoRoot,
      title,
    },
  });
  if (!createResponse.ok()) {
    expect(createResponse.ok(), await createResponse.text()).toBe(true);
  }
  return await createResponse.json() as CreatedSession;
}

export async function openSessionInUi(page: Page, session: CreatedSession): Promise<void> {
  await page.goto("/");
  const projectName = path.basename(session.cwd);
  await page.locator("div[title]").filter({ hasText: projectName }).first().click();
  await page.getByText(session.title, { exact: true }).click();
}
