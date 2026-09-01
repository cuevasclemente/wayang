import { expect, test, type Page, type Route, type WebSocketRoute } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

type CredentialAvailability = "unavailable" | "locked" | "unlocked";

interface BrowserMockState {
  controlMode: "agent" | "user" | "paused";
  credentialAvailability: CredentialAvailability;
  matchesAvailability?: CredentialAvailability;
  credentialInspection?: "blocked" | "text-allowed";
  profilePersistence?: "shared" | "named";
  viewerTransport?: "cdp-screencast" | "vnc";
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
    viewerTransport: state.viewerTransport ?? "cdp-screencast",
    vncReady: true,
    profile: state.profilePersistence === "named"
      ? { persistence: "named", name: "Legacy shared" }
      : { persistence: "shared" },
    ...(state.profilePersistence === "named" ? {
      tabs: [{ tab: "synthetic-tab", title: "Synthetic sign in", url: "https://login.example.test/sign-in" }],
      activeTab: "synthetic-tab",
    } : {}),
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

async function installSyntheticVncSocket(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const frames: number[][] = [];
    Object.defineProperty(window, "__wayangSyntheticVncFrames", {
      configurable: true,
      value: frames,
    });

    class SyntheticVncSocket {
      binaryType: BinaryType = "arraybuffer";
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      protocol = "";
      readyState = NativeWebSocket.CONNECTING;
      private stage = 0;

      constructor() {
        queueMicrotask(() => {
          this.readyState = NativeWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.deliver(new TextEncoder().encode("RFB 003.008\n"));
        });
      }

      send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        let bytes: Uint8Array;
        if (typeof data === "string") bytes = new TextEncoder().encode(data);
        else if (data instanceof Blob) throw new Error("Synthetic VNC does not accept Blob client frames");
        else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        else bytes = new Uint8Array(data);
        frames.push(Array.from(bytes));
        if (this.stage === 0) {
          this.stage = 1;
          queueMicrotask(() => this.deliver(new Uint8Array([1, 1])));
        } else if (this.stage === 1) {
          this.stage = 2;
          queueMicrotask(() => this.deliver(new Uint8Array([0, 0, 0, 0])));
        } else if (this.stage === 2) {
          this.stage = 3;
          const name = new TextEncoder().encode("Wayang synthetic VNC");
          const serverInit = new Uint8Array(24 + name.length);
          const view = new DataView(serverInit.buffer);
          view.setUint16(0, 800);
          view.setUint16(2, 600);
          serverInit[4] = 32;
          serverInit[5] = 24;
          serverInit[6] = 0;
          serverInit[7] = 1;
          view.setUint16(8, 255);
          view.setUint16(10, 255);
          view.setUint16(12, 255);
          serverInit[14] = 16;
          serverInit[15] = 8;
          serverInit[16] = 0;
          view.setUint32(20, name.length);
          serverInit.set(name, 24);
          queueMicrotask(() => this.deliver(serverInit));
        }
      };

      close = () => {
        if (this.readyState === NativeWebSocket.CLOSED) return;
        this.readyState = NativeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close", { code: 1000, reason: "", wasClean: true }));
      };

      private deliver(bytes: Uint8Array) {
        if (this.readyState !== NativeWebSocket.OPEN) return;
        const copy = bytes.slice();
        this.onmessage?.(new MessageEvent("message", { data: copy.buffer }));
      }
    }

    function RoutedWebSocket(this: WebSocket, url: string | URL, protocols?: string | string[]) {
      if (String(url).includes("/ws/browser-vnc")) return new SyntheticVncSocket() as unknown as WebSocket;
      return new NativeWebSocket(url, protocols);
    }
    RoutedWebSocket.prototype = NativeWebSocket.prototype;
    Object.defineProperties(RoutedWebSocket, {
      CONNECTING: { value: NativeWebSocket.CONNECTING },
      OPEN: { value: NativeWebSocket.OPEN },
      CLOSING: { value: NativeWebSocket.CLOSING },
      CLOSED: { value: NativeWebSocket.CLOSED },
    });
    window.WebSocket = RoutedWebSocket as unknown as typeof WebSocket;
  });
}

async function openMockBrowser(
  page: Page,
  sessionId: string,
  projectCwd: string,
  credentialAvailability: CredentialAvailability = "unlocked",
  matchesAvailability?: CredentialAvailability,
  routeCdpViewer = true,
) {
  const state: BrowserMockState = { controlMode: "agent", credentialAvailability, matchesAvailability };
  const requests: CapturedRequest[] = [];
  const viewerMessages: string[] = [];
  const viewerSockets: WebSocketRoute[] = [];
  let sendViewerMessage: ((message: Record<string, unknown>) => void) | null = null;
  if (routeCdpViewer) {
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
  }
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

  await expect(page.getByTestId("browser-workbench").getByText("Shared control", { exact: true })).toBeVisible();
  await expect(page.getByTestId("browser-control-notice")).toHaveCount(0);
  const full = page.getByRole("radio", { name: "Full browser" });
  const fast = page.getByRole("radio", { name: "Fast page" });
  await expect(fast).toHaveAttribute("aria-checked", "true");
  await full.click();
  await expect(full).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Pause agent" }).click();
  await expect(page.getByText(/Agent paused: your viewer input remains active/)).toBeVisible();
  await page.getByRole("button", { name: "Resume agent" }).first().click();
  await expect(page.getByTestId("browser-workbench").getByText("Shared control", { exact: true })).toBeVisible();
  await fast.click();
  await expect(fast).toHaveAttribute("aria-checked", "true");

  await page.setViewportSize({ width: 800, height: 700 });
  await expect(page.getByRole("radio", { name: "Full browser" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Credentials" })).toBeVisible();
  await expect(page.getByLabel("Browser URL")).toBeVisible();
  await expect(page.getByTestId("browser-details")).not.toHaveAttribute("open", "");
  const [workbenchBox, viewportBox] = await Promise.all([
    page.getByTestId("browser-workbench").boundingBox(),
    page.getByTestId("browser-viewport").boundingBox(),
  ]);
  expect(workbenchBox).not.toBeNull();
  expect(viewportBox).not.toBeNull();
  expect(viewportBox!.height / workbenchBox!.height).toBeGreaterThan(0.7);
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
  await expect(page.getByTestId("browser-workbench").getByText("Shared control", { exact: true })).toBeVisible();
  await expect(page.getByTestId("browser-control-notice")).toHaveCount(0);
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

test("named Standard Full browser paste is paused, focus-bound, exactly once, and RFB-only", async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const session = await createE2eSession(request, "e2e named full browser paste");
  await installSyntheticVncSocket(page);
  const mock = await openMockBrowser(page, session.id, session.cwd, "unlocked", undefined, false);
  mock.state.profilePersistence = "named";
  mock.state.viewerTransport = "vnc";
  await openSessionInUi(page, session);
  await page.getByRole("button", { name: "Browser", exact: true }).click();

  await expect(page.getByText("Full browser connected")).toBeVisible();
  await expect(page.getByTestId("browser-details")).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("protected-downloads")).toBeHidden();
  const [workbenchBox, viewportBox] = await Promise.all([
    page.getByTestId("browser-workbench").boundingBox(),
    page.getByTestId("browser-viewport").boundingBox(),
  ]);
  expect(workbenchBox).not.toBeNull();
  expect(viewportBox).not.toBeNull();
  expect(viewportBox!.height / workbenchBox!.height).toBeGreaterThan(0.65);
  const pasteButton = page.getByRole("button", { name: "Paste text" });
  await pasteButton.click();
  await expect(page.getByText("Pause the agent before using human-only Full browser paste.")).toBeVisible();

  await page.getByRole("button", { name: "Pause agent" }).click();
  await expect(page.getByRole("button", { name: "Resume agent" })).toHaveCount(1);
  await pasteButton.click();
  await expect(page.getByText("Click the destination field in Full browser before pasting.")).toBeVisible();

  await page.getByTestId("full-browser-viewer").click({ position: { x: 10, y: 10 } });
  await pasteButton.click();
  const target = page.getByLabel("Full browser paste target");
  await expect(target).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => { throw new Error("synthetic permission denial"); } },
    });
  });
  const readClipboardButton = page.getByRole("button", { name: "Read and paste system clipboard" });
  await readClipboardButton.click();
  await expect(page.getByText(/Clipboard access was denied.*Paste into the capture target instead/)).toBeVisible();

  await page.evaluate(() => {
    const pending: Array<(text: string) => void> = [];
    Object.defineProperty(window, "__wayangPendingClipboardReads", { configurable: true, value: pending });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => new Promise<string>((resolve) => pending.push(resolve)) },
    });
  });
  await readClipboardButton.click();
  await readClipboardButton.click();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __wayangPendingClipboardReads: Array<(text: string) => void> }
  ).__wayangPendingClipboardReads.length)).toBe(2);

  const canary = "synthetic-full-browser-paste";
  await target.evaluate((element, text) => {
    const textarea = element as HTMLTextAreaElement;
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", text);
    textarea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
    // Model the native paste/input race. The component's content-free latch
    // must suppress this second delivery even before React unmounts capture.
    textarea.value = text;
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
  }, canary);
  await expect(page.getByText("Clipboard text was pasted once into the focused Full browser field.")).toBeVisible();
  await page.evaluate((text) => {
    const pending = (
      window as unknown as { __wayangPendingClipboardReads: Array<(value: string) => void> }
    ).__wayangPendingClipboardReads.splice(0);
    pending.forEach((resolve) => resolve(text));
  }, canary);

  await expect.poll(async () => page.evaluate((text) => {
    const frames = (window as unknown as { __wayangSyntheticVncFrames: number[][] }).__wayangSyntheticVncFrames;
    const bytes = new Uint8Array(frames.flat());
    const needle = new TextEncoder().encode(text);
    let count = 0;
    for (let offset = 0; offset <= bytes.length - needle.length; offset += 1) {
      if (needle.every((value, index) => bytes[offset + index] === value)) count += 1;
    }
    return count;
  }, canary)).toBe(1);
  expect(mock.requests.some((entry) => entry.path === "/api/browser/paste-text")).toBe(false);
  const storage = await page.evaluate(() => ({
    local: Object.values(localStorage),
    session: Object.values(sessionStorage),
  }));
  expect([...storage.local, ...storage.session].join("\n")).not.toContain(canary);
});

test("direct paste forwards an uncontrolled DOM value without retaining it in browser storage", async ({ page, request }) => {
  const session = await createE2eSession(request, "e2e browser paste");
  const mock = await openMockBrowser(page, session.id, session.cwd);
  await openSessionInUi(page, session);
  await page.getByRole("button", { name: "Browser", exact: true }).click();

  await page.getByText("More", { exact: true }).click();
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
