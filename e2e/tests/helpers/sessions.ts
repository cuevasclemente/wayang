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

export async function ensureE2eProject(request: APIRequestContext, cwd: string): Promise<void> {
  const listed = await request.get("/api/projects");
  expect(listed.ok(), await listed.text()).toBe(true);
  const projects = await listed.json() as Array<{ cwd?: string }>;
  if (projects.some((project) => project.cwd === cwd)) return;
  const created = await request.post("/api/projects", {
    data: { cwd, name: path.basename(cwd) || "Synthetic E2E project" },
  });
  if (!created.ok() && created.status() !== 409) {
    expect(created.ok(), await created.text()).toBe(true);
  }
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
