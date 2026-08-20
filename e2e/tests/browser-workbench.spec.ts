import { expect, test, type Page, type Route, type WebSocketRoute } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

type CredentialAvailability = "unavailable" | "locked" | "unlocked";

interface BrowserMockState {
  controlMode: "agent" | "user" | "paused";
  credentialAvailability: CredentialAvailability;
  matchesAvailability?: CredentialAvailability;
  credentialInspection?: "blocked" | "text-allowed";
  profilePersistence?: "shared" | "named";
}

interface CapturedRequest {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

function publicBrowserState(sessionId: string, projectCwd: string, state: BrowserMockState) {
  return {
    sessionId,
    projectCwd,
    status: "running",
    controlMode: state.controlMode,
    secretTainted: false,
    localOnlyRecommended: false,
    needsUser: state.controlMode !== "agent",
    needsUserReason: state.controlMode === "agent" ? undefined : "Private browser step in progress",
    activeUrl: "https://login.example.test/sign-in",
    activeTitle: "Synthetic sign in",
    cdpReady: true,
    viewerTransport: "cdp-screencast",
    vncReady: true,
    profile: state.profilePersistence === "named"
      ? { persistence: "named", name: "Legacy shared" }
      : { persistence: "shared" },
    updatedAt: Date.now(),
    credentialInspection: state.credentialInspection,
  };
}

async function fulfillBrowserApi(
  route: Route,
  sessionId: string,
  projectCwd: string,
  state: BrowserMockState,
  requests: CapturedRequest[],
) {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const body = request.postDataJSON() as Record<string, unknown> | null;
  if (body) requests.push({ path, method: request.method(), body });

  if (path === "/api/browser/control-mode") {
    if (body?.mode === "agent" && state.credentialInspection) {
      return route.fulfill({
        status: 409,
        json: { error: "Credential inspection must be authorized through the UI-only credential route" },
      });
    }
    state.controlMode = body?.mode === "agent" ? "agent" : body?.mode === "paused" ? "paused" : "user";
    return route.fulfill({ json: publicBrowserState(sessionId, projectCwd, state) });
  }
  if (path === "/api/browser/credentials/status") {
    return route.fulfill({
      json: {
        available: state.credentialAvailability !== "unavailable",
        unlocked: state.credentialAvailability === "unlocked",
        ...(state.credentialAvailability === "unlocked" ? { unlockExpiresAt: Date.now() + 60_000 } : {}),
        origin: "https://login.example.test",
      },
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (path === "/api/browser/credentials/matches") {
    const availability = state.matchesAvailability ?? state.credentialAvailability;
    if (availability === "unavailable") {
      return route.fulfill({ status: 503, json: { error: "Bitwarden CLI is unavailable" } });
    }
    if (availability === "locked") {
      return route.fulfill({ status: 409, json: { error: "Bitwarden vault is not connected" } });
    }
    return route.fulfill({
      json: {
        origin: "https://login.example.test",
        choices: [{
          choiceToken: "opaque-choice-token",
          label: "Synthetic saved login",
          maskedIdentifier: "••••••@example.test",
          hasTotp: true,
        }],
      },
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (path === "/api/browser/credentials/fill" || path === "/api/browser/credentials/fill-totp") {
    state.controlMode = "user";
    state.credentialInspection = "blocked";
    return route.fulfill({ json: { filled: path.endsWith("fill-totp") ? ["totp"] : ["username", "password"] } });
  }
  if (path === "/api/browser/credentials/allow-agent-inspection") {
    if (state.credentialInspection !== "blocked") {
      return route.fulfill({ status: 409, json: { error: "Credential inspection authorization is unavailable" } });
    }
    state.controlMode = "agent";
    state.credentialInspection = "text-allowed";
    return route.fulfill({
      json: {
        allowedInspection: "text-only",
        screenshotsAllowed: false,
        mutationsAllowed: false,
        state: publicBrowserState(sessionId, projectCwd, state),
      },
    });
  }
  if (path === "/api/browser/credentials/lock") {
    state.credentialAvailability = "locked";
    return route.fulfill({ json: { locked: true } });
  }
  if (path === "/api/browser/paste-text") {
    return route.fulfill({ json: publicBrowserState(sessionId, projectCwd, state) });
  }
  return route.fulfill({ json: publicBrowserState(sessionId, projectCwd, state) });
}

async function openMockBrowser(
  page: Page,
  sessionId: string,
  projectCwd: string,
  credentialAvailability: CredentialAvailability = "unlocked",
  matchesAvailability?: CredentialAvailability,
) {
  const state: BrowserMockState = { controlMode: "agent", credentialAvailability, matchesAvailability };
  const requests: CapturedRequest[] = [];
  const viewerMessages: string[] = [];
  const viewerSockets: WebSocketRoute[] = [];
  let sendViewerMessage: ((message: Record<string, unknown>) => void) | null = null;
  await page.routeWebSocket(/\/ws\/browser(?:\?|$)/, (socket) => {
    viewerSockets.push(socket);
    sendViewerMessage = (message) => socket.send(JSON.stringify(message));
    socket.onMessage((message) => {
      if (typeof message === "string") viewerMessages.push(message);
    });
    setTimeout(() => {
      socket.send(JSON.stringify({
        type: "frame-metadata",
        sessionId: 41,
        metadata: { deviceWidth: 1, deviceHeight: 1 },
      }));
      // Public 1×1 PNG bytes stand in for a binary screenshot. The test has no
      // secret-bearing page content, screenshot, storage, or trace fixture.
      socket.send(Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ));
    }, 50);
  });
  await page.routeWebSocket(/\/ws\/browser-vnc(?:\?|$)/, () => {});
  await page.route("**/api/browser/**", (route) => fulfillBrowserApi(route, sessionId, projectCwd, state, requests));
  return {
    state,
    requests,
    viewerMessages,
    sendViewerMessage: (message: Record<string, unknown>) => sendViewerMessage?.(message),
    viewerConnectionCount: () => viewerSockets.length,
    closeViewer: async (code: number, reason: string) => { await viewerSockets.at(-1)?.close({ code, reason }); },
  };
}

test("browser viewer switching and cooperative-control copy stay usable in a narrow panel", async ({ page, request }) => {
  const session = await createE2eSession(request, "e2e browser controls");
  await openMockBrowser(page, session.id, session.cwd);
  await openSessionInUi(page, session);
  await page.getByRole("button", { name: "Browser", exact: true }).click();

  await expect(page.getByText(/Shared control: you and the agent may act/)).toBeVisible();
  const full = page.getByRole("radio", { name: "Full browser" });
  const fast = page.getByRole("radio", { name: "Fast page" });
  await expect(fast).toHaveAttribute("aria-checked", "true");
  await full.click();
  await expect(full).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/Full browser selected/)).toBeVisible();

  await page.getByRole("button", { name: "Pause agent" }).click();
  await expect(page.getByText(/Agent paused: your viewer input remains active/)).toBeVisible();
  await page.getByRole("button", { name: "Resume agent" }).first().click();
  await expect(page.getByText(/Shared control: you and the agent may act/)).toBeVisible();

  await page.setViewportSize({ width: 800, height: 700 });
  await expect(page.getByRole("radio", { name: "Full browser" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Credentials" })).toBeVisible();
  await expect(page.getByLabel("Browser URL")).toBeVisible();
});

test("Fast page ACKs binary presentation and coalesces pointer and wheel bursts", async ({ page, request }) => {
  const session = await createE2eSession(request, "e2e fast browser viewer");
  const mock = await openMockBrowser(page, session.id, session.cwd);
  await openSessionInUi(page, session);
  await page.getByRole("button", { name: "Browser", exact: true }).click();

  await expect.poll(() => mock.viewerMessages.some((raw) => {
    const message = JSON.parse(raw) as { type?: string; sessionId?: number };
    return message.type === "frame-ack" && message.sessionId === 41;
  })).toBe(true);

  const image = page.getByAltText("Chromium fast page");
  await image.evaluate((element) => {
    const container = element.parentElement!;
    const rect = element.getBoundingClientRect();
    for (let index = 0; index < 20; index += 1) {
      container.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        clientX: rect.left + 0.5,
        clientY: rect.top + 0.5,
      }));
      container.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 0.5,
        clientY: rect.top + 0.5,
        deltaY: 2,
      }));
    }
  });
  await page.waitForTimeout(100);

  const inputs = mock.viewerMessages.flatMap((raw) => {
    const message = JSON.parse(raw) as { type?: string; event?: string; deltaY?: number };
    return message.type === "mouse" ? [message] : [];
  });
  expect(inputs.filter((message) => message.event === "move")).toHaveLength(1);
  expect(inputs.filter((message) => message.event === "wheel")).toEqual([
    expect.objectContaining({ deltaY: 40 }),
  ]);
});

test("paused Fast page forwards complete clicks, surfaces input failure, and reconnects cleanly", async ({ page, request }) => {
  const session = await createE2eSession(request, "e2e fast viewer handoff retry");
  const mock = await openMockBrowser(page, session.id, session.cwd);
  await openSessionInUi(page, session);
  await page.getByRole("button", { name: "Browser", exact: true }).click();
  await page.getByRole("button", { name: "Pause agent" }).click();
  await expect(page.getByText(/Agent paused: your viewer input remains active/)).toBeVisible();
  await expect(page.getByText("Fast page connected")).toBeVisible();
  const image = page.getByAltText("Chromium fast page");
  await expect(image).toHaveCSS("opacity", "1");

  const sendClick = async () => {
    // Use Playwright's real pointer sequence so setPointerCapture behaves as it
    // does for a human gesture; synthetic DOM dispatch is not an active pointer.
    const box = await image.boundingBox();
    if (!box) throw new Error("synthetic viewer frame is not presentable");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  await sendClick();
  await expect.poll(() => mock.viewerMessages.flatMap((raw) => {
    const message = JSON.parse(raw) as { type?: string; event?: string };
    return message.type === "mouse" && (message.event === "down" || message.event === "up") ? [message.event] : [];
  })).toEqual(["down", "up"]);

  const beforeRetry = mock.viewerConnectionCount();
  await mock.closeViewer(1011, "input dispatch failed");
  await expect(page.getByRole("alert")).toContainText("Browser input dispatch failed");
  await expect(page.getByText(/Viewer disconnected\. The retained frame is not interactive/)).toBeVisible();
  await page.getByRole("button", { name: "Retry viewer" }).click();
  await expect.poll(() => mock.viewerConnectionCount()).toBe(beforeRetry + 1);
  await expect(page.getByText("Fast page connected")).toBeVisible();

  mock.viewerMessages.length = 0;
  await sendClick();
  await expect.poll(() => mock.viewerMessages.flatMap((raw) => {
    const message = JSON.parse(raw) as { type?: string; event?: string };
    return message.type === "mouse" && (message.event === "down" || message.event === "up") ? [message.event] : [];
  })).toEqual(["down", "up"]);
});

test("credential fill stays paused until protected redacted inspection is explicitly allowed", async ({ page, request }) => {
  const session = await createE2eSession(request, "e2e browser credentials");
  const mock = await openMockBrowser(page, session.id, session.cwd);
  await openSessionInUi(page, session);
  await page.getByRole("button", { name: "Browser", exact: true }).click();

  await page.getByRole("button", { name: "Credentials" }).click();
  const drawer = page.getByRole("complementary", { name: "Private credentials" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Credentials mode — agent paused")).toBeVisible();
  await expect(drawer.getByTestId("credential-origin")).toHaveText("https://login.example.test");
  await expect(drawer.getByText("Synthetic saved login")).toBeVisible();
  await expect(drawer.getByText("••••••@example.test")).toBeVisible();
  const statusRequest = mock.requests.find((entry) => entry.path === "/api/browser/credentials/status");
  expect(statusRequest?.method).toBe("POST");
  expect(statusRequest?.body).toEqual(expect.objectContaining({
    sessionId: session.id,
    projectCwd: session.cwd,
  }));
  await expect(drawer.getByRole("button", { name: /reveal/i })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: /copy/i })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: /submit/i })).toHaveCount(0);

  await drawer.getByRole("button", { name: "Fill login" }).click();
  await expect(page.getByText(/^Saved login filled\. Wayang does not click Submit; the site may react automatically to field changes/)).toBeVisible();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(/read-only redacted text and DOM inspection only/)).toBeVisible();
  await expect(drawer.getByText(/all agent navigation, click, type, and mutations remain blocked/)).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Allow agent read-only redacted inspection" })).toBeVisible();
  const fillRequest = mock.requests.find((entry) => entry.path === "/api/browser/credentials/fill");
  expect(fillRequest?.body.choiceToken).toBe("opaque-choice-token");
  expect(fillRequest?.body).not.toHaveProperty("origin");
  expect(fillRequest?.body).not.toHaveProperty("itemId");
  expect(fillRequest?.body).not.toHaveProperty("selector");

  await drawer.getByRole("button", { name: "Close credentials drawer" }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByText(/Credential fill protection: the agent remains paused/)).toBeVisible();

  // Generic Resume must surface the backend 409 and direct the user back to
  // the UI-only credential authorization instead of bypassing it.
  await page.getByRole("button", { name: "Resume agent" }).first().click();
  await expect(page.getByText(/Generic Resume cannot bypass credential-fill protection/)).toBeVisible();
  await expect(drawer).toBeVisible();

  await drawer.getByRole("button", { name: "Allow agent read-only redacted inspection" }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByText(/^Agent read-only inspection:/)).toBeVisible();
  await expect(page.getByText(/all agent navigation, click, type, and mutations remain blocked/).first()).toBeVisible();
  const allowRequest = mock.requests.find((entry) => entry.path === "/api/browser/credentials/allow-agent-inspection");
  expect(allowRequest?.method).toBe("POST");
  expect(allowRequest?.body).toEqual(expect.objectContaining({ sessionId: session.id, projectCwd: session.cwd }));
  expect(allowRequest?.body).not.toHaveProperty("choiceToken");
  expect(mock.state.controlMode).toBe("agent");
  expect(mock.state.credentialInspection).toBe("text-allowed");

  // A page URL/title event is not backend confirmation of a new top-level
  // document and must not clear the credential inspection gate in React.
  mock.sendViewerMessage({ type: "page", url: "https://login.example.test/next", title: "Next view" });
  await expect(page.getByText(/^Agent read-only inspection:/)).toBeVisible();

  // Only a subsequent backend public state clears the UI restriction.
  mock.state.credentialInspection = undefined;
  mock.sendViewerMessage({ type: "status" });
  await expect(page.getByText(/Shared control: you and the agent may act/)).toBeVisible();
});

test("credential drawer preserves matches 409 handling after an unlocked status", async ({ page, request }) => {
  const session = await createE2eSession(request, "e2e locked browser credentials");
  const mock = await openMockBrowser(page, session.id, session.cwd, "unlocked", "locked");
  await openSessionInUi(page, session);
  await page.getByRole("button", { name: "Browser", exact: true }).click();
  await page.getByRole("button", { name: "Credentials" }).click();

  const drawer = page.getByRole("complementary", { name: "Private credentials" });
  await expect(drawer.getByText("Locked", { exact: true })).toBeVisible();
  await expect(drawer.getByTestId("credential-origin")).toHaveText("https://login.example.test");
  await expect(drawer.getByText("make browser-credentials-unlock")).toBeVisible();
  await expect(drawer).not.toContainText("not connected");
  expect(mock.requests.some((entry) => entry.path === "/api/browser/credentials/status" && entry.method === "POST")).toBe(true);
  expect(mock.requests.some((entry) => entry.path === "/api/browser/credentials/matches" && entry.method === "POST")).toBe(true);
});

test("named Standard Fast page sends human paste only through its authenticated viewer", async ({ page, request }) => {
  const session = await createE2eSession(request, "e2e named browser paste");
  const mock = await openMockBrowser(page, session.id, session.cwd);
  mock.state.profilePersistence = "named";
  mock.state.controlMode = "user";
  await openSessionInUi(page, session);
  await page.getByRole("button", { name: "Browser", exact: true }).click();

  await expect(page.getByText("Fast page connected")).toBeVisible();
  await page.getByRole("button", { name: "Paste text" }).click();
  const target = page.getByLabel("Direct paste target");
  await target.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "synthetic-human-paste");
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await expect(page.getByText("Clipboard text was sent to the focused browser field.")).toBeVisible();
  await expect.poll(() => mock.viewerMessages.flatMap((raw) => {
    const message = JSON.parse(raw) as { type?: string; text?: string };
    return message.type === "paste" ? [message] : [];
  })).toEqual([{ type: "paste", text: "synthetic-human-paste" }]);
  expect(mock.requests.some((entry) => entry.path === "/api/browser/paste-text")).toBe(false);
  const storage = await page.evaluate(() => ({
    local: Object.values(localStorage),
    session: Object.values(sessionStorage),
  }));
  expect([...storage.local, ...storage.session].join("\n")).not.toContain("synthetic-human-paste");
});

test("direct paste forwards an uncontrolled DOM value without retaining it in browser storage", async ({ page, request }) => {
  const session = await createE2eSession(request, "e2e browser paste");
  const mock = await openMockBrowser(page, session.id, session.cwd);
  await openSessionInUi(page, session);
  await page.getByRole("button", { name: "Browser", exact: true }).click();

  await page.getByRole("button", { name: "Paste…" }).click();
  const target = page.getByLabel("Direct paste target");
  await target.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "public-paste-canary");
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await expect(page.getByText("Clipboard text pasted into the focused browser field.")).toBeVisible();

  const pasteRequest = mock.requests.find((entry) => entry.path === "/api/browser/paste-text");
  expect(pasteRequest?.body.text).toBe("public-paste-canary");
  const storage = await page.evaluate(() => ({
    local: Object.values(localStorage),
    session: Object.values(sessionStorage),
  }));
  expect([...storage.local, ...storage.session].join("\n")).not.toContain("public-paste-canary");
});
