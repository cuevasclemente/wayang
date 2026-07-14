import { expect, test } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";
import {
  formatWsConnectionTiming,
  getWsConnectionTiming,
  installWsProfileCollector,
} from "./helpers/wsProfile";

const SOCKET_OPEN_THRESHOLD_MS = Number.parseInt(process.env.WAYANG_E2E_WS_OPEN_THRESHOLD_MS || "5000", 10);
const SESSION_READY_THRESHOLD_MS = Number.parseInt(process.env.WAYANG_E2E_WS_READY_THRESHOLD_MS || "10000", 10);
const UI_READY_THRESHOLD_MS = Number.parseInt(process.env.WAYANG_E2E_UI_READY_THRESHOLD_MS || "30000", 10);

test("connects the chat websocket within a reasonable local threshold", async ({ page, request }, testInfo) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => {
    consoleLines.push(`[${msg.type()}] ${msg.text()}`);
  });

  await installWsProfileCollector(page);

  const session = await createE2eSession(request, "e2e websocket timing");
  const uiStart = Date.now();
  let timingText = "websocket profile was not collected";

  try {
    await openSessionInUi(page, session);
    await expect(page.getByTestId("chat-input")).toBeEnabled({ timeout: UI_READY_THRESHOLD_MS });

    const uiReadyMs = Date.now() - uiStart;
    const timing = await getWsConnectionTiming(page, session.id);
    timingText = [`uiReadyMs=${uiReadyMs}`, formatWsConnectionTiming(timing)].join("\n\n");

    expect(timing.connectStartMs, timingText).not.toBeNull();
    expect(timing.socketOpenMs, timingText).not.toBeNull();
    expect(timing.sessionReadyMs, timingText).not.toBeNull();
    expect(timing.openDurationMs, timingText).not.toBeNull();
    expect(timing.readyDurationMs, timingText).not.toBeNull();

    expect(timing.openDurationMs!, timingText).toBeLessThanOrEqual(SOCKET_OPEN_THRESHOLD_MS);
    expect(timing.readyDurationMs!, timingText).toBeLessThanOrEqual(SESSION_READY_THRESHOLD_MS);
    expect(uiReadyMs, timingText).toBeLessThanOrEqual(UI_READY_THRESHOLD_MS);
  } finally {
    try {
      const timing = await getWsConnectionTiming(page, session.id);
      timingText = timingText === "websocket profile was not collected"
        ? formatWsConnectionTiming(timing)
        : timingText;
    } catch {
      // Page may already be closed after an early startup failure.
    }

    await testInfo.attach("websocket-connection-timing.txt", {
      body: timingText,
      contentType: "text/plain",
    });
    await testInfo.attach("browser-console.txt", {
      body: consoleLines.slice(-300).join("\n"),
      contentType: "text/plain",
    });
  }
});
