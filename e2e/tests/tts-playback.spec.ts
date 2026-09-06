import { expect, test, type Route } from "@playwright/test";
import { chunk, completed, emit, expectPlays, flushTts, installTtsFixture, startTts } from "./helpers/ttsPlayback";

test("TTS waits for exact next index; duplicates and generation events cannot interrupt", async ({ page }) => {
  await installTtsFixture(page);
  await startTts(page);
  await emit(page, "chunk_completed", chunk(2));
  await expectPlays(page, []);
  await emit(page, "chunk_completed", chunk(1));
  await expectPlays(page, [1]);
  // StrictMode ref replay must not pause an element that remains attached.
  expect(await page.evaluate(() => window.__tts.pauses)).toEqual([]);
  await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
  const pausesBeforeProgress = await page.evaluate(() => window.__tts.pauses.length);
  await emit(page, "job_started", { status: "running", chunks_total: 4 });
  await emit(page, "manifest", { chunks: [chunk(1), chunk(2), chunk(4)], chunks_total: 4 });
  await emit(page, "chunk_completed", { ...chunk(1), url: "/must-not-replace-source" });
  await expectPlays(page, [1]);
  expect(await page.evaluate(() => window.__tts.pauses.length)).toBe(pausesBeforeProgress);
  await page.locator("audio").dispatchEvent("ended");
  await expectPlays(page, [1, 2]);
  await page.locator("audio").dispatchEvent("ended");
  await expect(page.getByText("Buffering next chunk…", { exact: true })).toBeVisible();
  await emit(page, "chunk_split", { chunks_total: 4 });
  await expectPlays(page, [1, 2]);
  await emit(page, "chunk_completed", chunk(3));
  await expectPlays(page, [1, 2, 3]);
  await page.locator("audio").dispatchEvent("ended");
  await expectPlays(page, [1, 2, 3, 4]);
  await emit(page, "job_completed", completed([1, 2, 3, 4]));
  await page.locator("audio").dispatchEvent("ended");
  await expect(page.getByText("Audio ready", { exact: true })).toBeVisible();
  await expectPlays(page, [1, 2, 3, 4]);
  await page.getByRole("button", { name: "Replay full audio" }).click();
  await expectPlays(page, [1, 2, 3, 4, "final"]);
  await page.locator("audio").dispatchEvent("ended");
  await expectPlays(page, [1, 2, 3, 4, "final"]);
});

test("TTS honors native pause across completion and manual pause in a silent gap", async ({ page }) => {
  await installTtsFixture(page);
  await startTts(page);
  await emit(page, "chunk_completed", chunk(1));
  await expectPlays(page, [1]);
  await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
  await page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.pause());
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await emit(page, "job_started", { status: "running" });
  await emit(page, "chunk_completed", chunk(2));
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await expectPlays(page, [1]);
  await page.getByRole("button", { name: "Resume read aloud" }).click();
  await expectPlays(page, [1, 1]); // Explicit resume is the only extra play on this segment.
  await page.locator("audio").dispatchEvent("ended");
  await expectPlays(page, [1, 1, 2]);
  await page.locator("audio").dispatchEvent("ended");
  await page.getByRole("button", { name: "Pause read aloud" }).click();
  await emit(page, "job_completed", completed([1, 2, 3]));
  await expectPlays(page, [1, 1, 2]);
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume read aloud" }).click();
  await expectPlays(page, [1, 1, 2, 3]);
});

test("TTS autoplay rejection waits for a gesture despite future progress and completion", async ({ page }) => {
  await installTtsFixture(page);
  await startTts(page);
  await page.evaluate(() => { window.__tts.rejectNext = true; });
  await emit(page, "chunk_completed", chunk(1));
  await expect(page.getByText("Playback needs a click to continue", { exact: true })).toBeVisible();
  await emit(page, "job_started", { status: "running" });
  await emit(page, "job_completed", completed([1, 2]));
  await expectPlays(page, [1]);
  await page.getByRole("button", { name: "Resume read aloud" }).click();
  await expectPlays(page, [1, 1]);
  await page.locator("audio").dispatchEvent("ended");
  await expectPlays(page, [1, 1, 2]);
});

test("TTS late play rejection cannot undo an explicit resume of the same source", async ({ page }) => {
  await installTtsFixture(page);
  await startTts(page);
  await page.evaluate(() => { window.__tts.holdNext = true; });
  await emit(page, "chunk_completed", chunk(1));
  await expectPlays(page, [1]);
  await page.getByRole("button", { name: "Pause read aloud" }).click();
  await page.getByRole("button", { name: "Resume read aloud" }).click();
  await expectPlays(page, [1, 1]);
  await page.evaluate(() => window.__tts.pending[0](new Error("Synthetic superseded play rejection")));
  await emit(page, "chunk_completed", chunk(2));
  await expectPlays(page, [1, 1]);
  await expect(page.getByText("Playing chunk 1", { exact: true })).toBeVisible();
});

test("TTS retry ignores old SSE and pending play rejection; unmount stops audio and closes stream", async ({ page }) => {
  await installTtsFixture(page);
  await startTts(page);
  await page.evaluate(() => { window.__tts.holdNext = true; });
  await emit(page, "chunk_completed", chunk(1));
  await expectPlays(page, [1]);
  await emit(page, "job_failed", { status: "failed" });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => page.evaluate(() => window.__tts.sources.length)).toBe(2);
  await emit(page, "chunk_completed", chunk(1));
  await expectPlays(page, [1, 1]);
  await emit(page, "job_completed", completed([1, 2]), 0);
  await page.evaluate(() => window.__tts.pending[0](new Error("Synthetic late rejection")));
  await expectPlays(page, [1, 1]);
  await expect(page.getByText("Playing chunk 1", { exact: true })).toBeVisible();
  await page.getByText("tts-b", { exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/tts-b$/);
  await expect(page.locator("audio")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__tts.sources.every((source) => source.closed))).toBe(true);
  expect(await page.evaluate(() => window.__tts.pauses)).toContain(chunk(1).url);
  await emit(page, "chunk_completed", chunk(2));
  await expectPlays(page, [1, 1]);
});

for (const outcome of ["success", "failure"] as const) {
  test(`TTS late synthesize ${outcome} cannot revive playback after session switch`, async ({ page }) => {
    await installTtsFixture(page);
    let pending: Route | undefined;
    await page.route("**/api/tts/synthesize", (route) => { pending = route; });
    await page.goto("/sessions/tts-a");
    await page.getByRole("button", { name: /Read aloud/ }).click();
    await expect.poll(() => Boolean(pending)).toBe(true);
    await page.getByText("tts-b", { exact: true }).click();
    await expect(page).toHaveURL(/\/sessions\/tts-b$/);
    const response = page.waitForResponse("**/api/tts/synthesize");
    await pending!.fulfill(outcome === "success"
      ? { json: { jobId: "old", eventsUrl: "/api/tts/jobs/old/events", status: "queued" } }
      : { status: 500, json: { error: "Synthetic late failure" } });
    await (await response).finished();
    await flushTts(page);
    expect(await page.evaluate(() => window.__tts.sources.length)).toBe(0);
    await expect(page.locator("audio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expectPlays(page, []);
  });
}

test("direct TTS fallback completes once and full replay needs a click", async ({ page }) => {
  await installTtsFixture(page);
  await page.route("**/api/tts/synthesize", (route) => route.fulfill({ json: { id: "direct", url: "/api/tts/jobs/test/final", chunks: 1, duration: 1 } }));
  await page.goto("/sessions/tts-a");
  await page.getByRole("button", { name: /Read aloud/ }).click();
  await expect(page.getByText("Playing audio", { exact: true })).toBeVisible();
  await expectPlays(page, ["final"]);
  await page.locator("audio").dispatchEvent("ended");
  await expect(page.getByText("Audio ready", { exact: true })).toBeVisible();
  await expectPlays(page, ["final"]);
  await page.getByRole("button", { name: "Replay full audio" }).click();
  await expectPlays(page, ["final", "final"]);
});

test("native browser media ends each synthetic WAV once and waits silently for the next", async ({ page }) => {
  await installTtsFixture(page, true);
  // 150 ms of PCM silence: no provider, private session, or stored audio required.
  const frames = 1200;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(frames * 2, 40);
  await page.route("**/api/tts/jobs/test/chunks/*", (route) => route.fulfill({ contentType: "audio/wav", body: wav }));
  await startTts(page);
  await emit(page, "chunk_completed", chunk(1));
  await expect(page.getByText("Buffering next chunk…", { exact: true })).toBeVisible();
  await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.ended)).toBe(true);
  await expectPlays(page, [1]);
  await emit(page, "job_started", { status: "running" });
  await emit(page, "chunk_split", { chunks_total: 2 });
  await expectPlays(page, [1]);
  await emit(page, "job_completed", completed([1, 2]));
  await expect(page.getByText("Audio ready", { exact: true })).toBeVisible();
  await expectPlays(page, [1, 2]);
});
