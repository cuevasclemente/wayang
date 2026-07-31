import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createSyntheticCorpus } from "./helpers/syntheticSessions";
import { installWsProfileCollector, getWsProfileEntries } from "./helpers/wsProfile";

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] ?? null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? null };
}

test("synthetic catalog and transcript latency remain responsive", async ({ page, request }, testInfo) => {
  test.setTimeout(300_000);
  await installWsProfileCollector(page);
  const networkProfile = process.env.WAYANG_E2E_NETWORK_PROFILE === "constrained" ? "constrained" : "local";
  if (networkProfile === "constrained") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 80,
      downloadThroughput: 1_500_000 / 8,
      uploadThroughput: 750_000 / 8,
      connectionType: "cellular4g",
    });
  }
  const fixtures = createSyntheticCorpus({ sessionCount: 100, messagesPerSession: 10, projectCount: 5, prefix: "latency-catalog" });
  const histories = [
    ...createSyntheticCorpus({ sessionCount: 1, messagesPerSession: 100, projectCount: 1, prefix: "latency-history-100-a" }),
    ...createSyntheticCorpus({ sessionCount: 1, messagesPerSession: 100, projectCount: 1, prefix: "latency-history-100-b" }),
    ...createSyntheticCorpus({ sessionCount: 1, messagesPerSession: 500, projectCount: 1, prefix: "latency-history-500" }),
    ...createSyntheticCorpus({ sessionCount: 1, messagesPerSession: 2_000, projectCount: 1, prefix: "latency-history-2000" }),
  ];
  const switchTargets = histories.slice(0, 2);

  const expectedFixtures = [...fixtures, ...histories];
  let missingFixtureIds = expectedFixtures.map((fixture) => fixture.id);
  // The live catalog watcher may consume part of this generated corpus while
  // files are still being written. Explicit scans are coalesced with that work,
  // and project-policy generation changes can deliberately defer candidates to
  // the next scan. Synchronize on the exact catalog end state rather than
  // assuming all parsing is attributed to one HTTP response.
  for (let attempt = 0; attempt < 10 && missingFixtureIds.length > 0; attempt++) {
    const importResponse = await request.post("/api/sessions/import");
    expect(importResponse.ok(), await importResponse.text()).toBe(true);
    const importPayload = await importResponse.json() as { parsed?: number };
    expect(typeof importPayload.parsed).toBe("number");

    const importedSessionsResponse = await request.get("/api/sessions");
    expect(importedSessionsResponse.ok(), await importedSessionsResponse.text()).toBe(true);
    const importedSessions = await importedSessionsResponse.json() as Array<{ id?: string }>;
    const importedIds = new Set(importedSessions.map((session) => session.id));
    missingFixtureIds = expectedFixtures.filter((fixture) => !importedIds.has(fixture.id)).map((fixture) => fixture.id);
  }
  expect(missingFixtureIds).toEqual([]);

  const listDurations: number[] = [];
  for (let index = 0; index < 200; index++) {
    const started = performance.now();
    const response = await request.get("/api/sessions");
    expect(response.ok()).toBe(true);
    listDurations.push(performance.now() - started);
  }

  const unchanged = await request.post("/api/sessions/import");
  expect(unchanged.ok()).toBe(true);
  const unchangedPayload = await unchanged.json() as { parsed?: number };
  expect(unchangedPayload.parsed).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.evaluate(() => {
    (window as Window & { __wayangLoadingShellSeen?: boolean }).__wayangLoadingShellSeen = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-testid="chat-loading-shell"]')) {
        (window as Window & { __wayangLoadingShellSeen?: boolean }).__wayangLoadingShellSeen = true;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  const target = histories[3]!;
  await page.locator(`div[title="${target.cwd}"]`).first().click();
  await page.getByText(target.title, { exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { __wayangLoadingShellSeen?: boolean }).__wayangLoadingShellSeen))).toBe(true);
  await expect(page.getByTestId("chat-message-list")).toHaveAttribute("data-transcript-state", "ready", { timeout: 120_000 });
  await expect(page.locator("[data-message-id]")).toHaveCount(target.messageCount, { timeout: 120_000 });

  const entries = await getWsProfileEntries(page);
  const selection = [...entries].reverse().find((entry) => entry.event === "selection_started" && entry.details.activeSessionId === target.id);
  const painted = [...entries].reverse().find((entry) => entry.event === "history_painted" && entry.details.sessionId === target.id);
  const usable = [...entries].reverse().find((entry) => entry.event === "transcript_usable" && entry.details.sessionId === target.id);
  expect(selection).toBeTruthy();
  expect(painted).toBeTruthy();
  expect(usable).toBeTruthy();
  const transcriptUsableDurations = [usable!.at - selection!.at];

  // Warm durable-socket selection matrix (30 samples total) for p50/p95/max.
  for (let sample = 1; sample < 30; sample++) {
    const sampleTarget = switchTargets[sample % switchTargets.length]!;
    const previousUsableCount = (await getWsProfileEntries(page)).filter((entry) => entry.event === "transcript_usable").length;
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await page.getByText(sampleTarget.title, { exact: true }).click();
    await expect.poll(async () => (await getWsProfileEntries(page)).filter((entry) => entry.event === "transcript_usable").length).toBeGreaterThan(previousUsableCount);
    const sampleEntries = await getWsProfileEntries(page);
    const sampleSelection = [...sampleEntries].reverse().find((entry) => entry.event === "selection_started" && entry.details.activeSessionId === sampleTarget.id);
    const sampleUsable = [...sampleEntries].reverse().find((entry) => entry.event === "transcript_usable" && entry.details.sessionId === sampleTarget.id);
    expect(sampleSelection).toBeTruthy();
    expect(sampleUsable).toBeTruthy();
    transcriptUsableDurations.push(sampleUsable!.at - sampleSelection!.at);
  }

  const connectCountBeforeMobileCycle = entries.filter((entry) => entry.event === "connect_start").length;
  await expect(page.getByTestId("mobile-tab-bar")).toBeVisible();
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByTestId("chat-message-list")).toBeVisible();
  const connectCountAfterMobileCycle = (await getWsProfileEntries(page)).filter((entry) => entry.event === "connect_start").length;
  expect(connectCountAfterMobileCycle).toBe(connectCountBeforeMobileCycle);

  const backendMetricsResponse = await request.get("/api/latency/metrics");
  expect(backendMetricsResponse.ok()).toBe(true);
  const backendMetrics = await backendMetricsResponse.json() as Record<string, unknown>;
  const report = {
    schema_version: 1,
    aggregate_only: true,
    network_profile: networkProfile,
    fixture: {
      catalog_sessions: fixtures.length,
      history_message_counts: histories.map((item) => item.messageCount),
      total_synthetic_bytes: [...fixtures, ...histories].reduce((sum, item) => sum + item.bytes, 0),
    },
    list_request_ms: summary(listDurations),
    transcript_usable_ms: summary(transcriptUsableDurations),
    backend: backendMetrics,
  };
  const tempRoot = process.env.WAYANG_E2E_TEMP_ROOT;
  if (!tempRoot || !tempRoot.startsWith("/tmp/")) throw new Error("Latency artifacts must remain under /tmp");
  const reportPath = path.join(tempRoot, "session-latency-aggregate.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  await testInfo.attach("session-latency-aggregate.json", { path: reportPath, contentType: "application/json" });

  const listStats = summary(listDurations);
  // End-to-end request timing includes browser/preview scheduling; keep a
  // broad correctness ceiling here and enforce the plan's strict thresholds
  // against response-finish handler metrics below.
  expect(listStats.p95!).toBeLessThanOrEqual(100);
  expect(listStats.p99!).toBeLessThanOrEqual(150);
  const backendMetricBuckets = (backendMetrics.metrics ?? {}) as Record<string, { p95?: number; p99?: number }>;
  expect(backendMetricBuckets.sessions_list_finish_ms?.p95 ?? Infinity).toBeLessThanOrEqual(20);
  expect(backendMetricBuckets.sessions_list_finish_ms?.p99 ?? Infinity).toBeLessThanOrEqual(50);
});
