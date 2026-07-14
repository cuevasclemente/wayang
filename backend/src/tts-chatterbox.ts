/**
 * tts-chatterbox.ts — HTTP client for the Chatterbox TTS server.
 *
 * Calls the OpenAI-compatible /v1/audio/speech endpoint on a self-hosted
 * Chatterbox instance (typically running Chatterbox-Turbo behind Caddy).
 */

import type { TtsConfig } from "./config.js";

export class ChatterboxError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(`Chatterbox TTS error (${status}): ${message}`);
    this.name = "ChatterboxError";
    this.status = status;
  }
}

/**
 * Send text to Chatterbox and receive audio bytes.
 */
export async function synthesizeChunk(
  text: string,
  config: TtsConfig,
): Promise<Buffer> {
  const url = `${config.baseUrl}/v1/audio/speech`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        input: text,
        voice: config.voice,
        response_format: config.format,
        speed: config.speed,
      }),
    });
  } catch (err) {
    throw new Error(
      `Failed to reach Chatterbox at ${config.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore
    }
    throw new ChatterboxError(
      response.status,
      body.slice(0, 500) || response.statusText,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
