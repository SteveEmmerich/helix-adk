/**
 * SSE replay helpers
 *
 * Turns a fixture's line array into a real ReadableStream<Uint8Array> that
 * looks exactly like what fetch() returns for a streaming response.
 *
 * The provider's #buildStream method accepts a Response — so we hand it a
 * fake one wrapping our fixture data. No mocking of private methods needed.
 */

import type { SseFixture } from "./sse.js";

const encoder = new TextEncoder();

/**
 * Build a fake fetch Response whose body streams the fixture lines.
 * Optionally add artificial delay between chunks to simulate network latency.
 */
export function fixtureToResponse(
  fixture: SseFixture,
  opts: { chunkDelayMs?: number; splitChunks?: boolean } = {}
): Response {
  const { chunkDelayMs = 0, splitChunks = false } = opts;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const line of fixture.lines) {
        // Optionally split each line into smaller byte chunks to test
        // the decoder's buffering logic (partial lines across reads)
        const full = `${line}\n\n`;
        if (splitChunks && full.length > 10) {
          const mid = Math.floor(full.length / 2);
          controller.enqueue(encoder.encode(full.slice(0, mid)));
          if (chunkDelayMs > 0) await sleep(chunkDelayMs);
          controller.enqueue(encoder.encode(full.slice(mid)));
        } else {
          controller.enqueue(encoder.encode(full));
        }
        if (chunkDelayMs > 0) await sleep(chunkDelayMs);
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Build a Response that aborts mid-stream after `afterLines` lines.
 * Tests that partial streams are handled gracefully.
 */
export function fixtureToAbortingResponse(
  fixture: SseFixture,
  afterLines: number
): { response: Response; abort: () => void } {
  const controller = new AbortController();
  let lineCount = 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      for (const line of fixture.lines) {
        if (lineCount >= afterLines) {
          // Stop enqueuing — leave stream hanging until aborted
          await new Promise<void>((resolve) => {
            controller.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          ctrl.error(new Error("Stream aborted"));
          return;
        }
        ctrl.enqueue(encoder.encode(`${line}\n\n`));
        lineCount++;
      }
      ctrl.close();
    },
  });

  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    abort: () => controller.abort(),
  };
}

/**
 * Build a Response that errors after `afterLines` lines.
 */
export function fixtureToErroringResponse(
  fixture: SseFixture,
  afterLines: number,
  error = new Error("Network error")
): Response {
  let lineCount = 0;

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const line of fixture.lines) {
        if (lineCount >= afterLines) {
          ctrl.error(error);
          return;
        }
        ctrl.enqueue(encoder.encode(`${line}\n\n`));
        lineCount++;
      }
      ctrl.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
