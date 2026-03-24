/**
 * Provider SSE replay tests
 *
 * Strategy: for each fixture, build a fake fetch Response from the raw SSE lines,
 * hand it to the provider's internal stream builder, read the resulting
 * ReadableStream<StreamEvent>, and assert the output matches expected.
 *
 * This tests the real parsing code paths without any API calls.
 *
 * We access providers via a thin test shim (see below) because #buildStream
 * is private. The shim exposes it for testing without changing production code.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { consumeStream, modelId } from "@helix/ai";
import type { CompletionResponse, StreamEvent } from "@helix/ai";
import {
  fixtureToAbortingResponse,
  fixtureToErroringResponse,
  fixtureToResponse,
} from "../fixtures/replay.js";
import {
  FIXTURES_BY_PROVIDER,
  anthropicMalformedJson,
  anthropicParallelToolCalls,
  anthropicThinking,
  googleParallelToolCalls,
  openaiParallelToolCalls,
} from "../fixtures/sse.js";

// ─── Test shim ────────────────────────────────────────────────────────────────
// We need to call provider.stream() with a fake fetch.
// The cleanest approach: monkey-patch global fetch for the duration of the test.

function withFakeResponse(response: Response, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function makeRequest(model = "claude-sonnet-4-5") {
  return {
    model: modelId(model),
    messages: [{ role: "user" as const, content: "test" }],
  };
}

// ─── Result collector ─────────────────────────────────────────────────────────

interface StreamResult {
  events: StreamEvent[];
  response: CompletionResponse | undefined;
  error: Error | undefined;
}

async function collectStream(stream: ReadableStream<StreamEvent>): Promise<StreamResult> {
  const events: StreamEvent[] = [];
  let response: CompletionResponse | undefined;
  let error: Error | undefined;

  try {
    const result = await consumeStream(stream, (e) => {
      events.push(e);
    });
    if (result.ok) response = result.value;
    else error = result.error;
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  }

  return { events, response, error };
}

// ─── Anthropic provider tests ─────────────────────────────────────────────────

describe("AnthropicProvider — SSE replay", () => {
  let provider: InstanceType<typeof import("@helix/ai")["AnthropicProvider"]>;

  beforeAll(async () => {
    const { AnthropicProvider } = await import("@helix/ai");
    provider = new AnthropicProvider({ apiKey: "test-key" });
  });

  for (const fixture of FIXTURES_BY_PROVIDER.anthropic) {
    it(`parses: ${fixture.name}`, async () => {
      const response = fixtureToResponse(fixture);
      await withFakeResponse(response, async () => {
        const result = await provider.stream(makeRequest("claude-sonnet-4-5"));
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const { events, response: resp, error } = await collectStream(result.value);
        expect(error).toBeUndefined();
        expect(resp).toBeDefined();
        expect(resp?.stopReason).toBe(fixture.expected.stopReason);

        if (fixture.expected.text !== undefined) {
          const textEvents = events.filter((e) => e.type === "text_delta");
          const fullText = textEvents.map((e) => (e.type === "text_delta" ? e.delta : "")).join("");
          expect(fullText).toBe(fixture.expected.text);
        }

        if (fixture.expected.toolCalls) {
          const toolStarts = events.filter((e) => e.type === "tool_call_start");
          expect(toolStarts).toHaveLength(fixture.expected.toolCalls.length);
          for (let i = 0; i < fixture.expected.toolCalls.length; i++) {
            const expected = fixture.expected.toolCalls[i];
            const actual = toolStarts[i];
            if (!expected || !actual) continue;
            if (actual.type === "tool_call_start") {
              expect(actual.name).toBe(expected.name);
            }
          }
        }

        if (fixture.expected.hasUsage) {
          expect(resp?.usage.promptTokens + resp?.usage.completionTokens).toBeGreaterThan(0);
        }
      });
    });
  }

  it("produces unique IDs for parallel tool calls", async () => {
    const response = fixtureToResponse(anthropicParallelToolCalls);
    await withFakeResponse(response, async () => {
      const result = await provider.stream(makeRequest());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { response: resp } = await collectStream(result.value);
      const toolCalls = resp?.message.content.filter((c) => c.type === "tool_call");
      expect(toolCalls).toHaveLength(2);

      // IDs must be unique even for same tool called twice
      const ids = toolCalls.map((c) => (c.type === "tool_call" ? c.id : ""));
      expect(new Set(ids).size).toBe(2);
    });
  });

  it("strips thinking blocks from visible content", async () => {
    const response = fixtureToResponse(anthropicThinking);
    await withFakeResponse(response, async () => {
      const result = await provider.stream(makeRequest("claude-opus-4-5"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { events, response: resp } = await collectStream(result.value);

      // Thinking events should be emitted
      const thinkingEvents = events.filter((e) => e.type === "thinking_delta");
      expect(thinkingEvents.length).toBeGreaterThan(0);

      // But the final message content should only have visible text
      const textParts = resp?.message.content.filter((c) => c.type === "text");
      expect(textParts).toHaveLength(1);
      expect((textParts[0] as { text: string }).text).toBe("The answer is 42.");
    });
  });

  it("skips malformed JSON lines and continues", async () => {
    const response = fixtureToResponse(anthropicMalformedJson);
    await withFakeResponse(response, async () => {
      const result = await provider.stream(makeRequest());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { response: resp, error } = await collectStream(result.value);
      expect(error).toBeUndefined();
      expect(resp?.message.content.find((c) => c.type === "text")?.text ?? "").toBe("Recovered.");
    });
  });

  it("handles mid-stream network error gracefully", async () => {
    const response = fixtureToErroringResponse(
      anthropicParallelToolCalls,
      3, // error after 3 lines
      new Error("ECONNRESET")
    );
    await withFakeResponse(response, async () => {
      const result = await provider.stream(makeRequest());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { error } = await collectStream(result.value);
      // Should surface as a stream error, not a crash
      expect(error).toBeDefined();
      expect(error?.message).toContain("ECONNRESET");
    });
  });

  it("cancels cleanly when AbortSignal fires", async () => {
    const { response, abort } = fixtureToAbortingResponse(anthropicParallelToolCalls, 2);
    const ac = new AbortController();

    await withFakeResponse(response, async () => {
      const result = await provider.stream({ ...makeRequest(), signal: ac.signal });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Start reading, then abort
      const reader = result.value.getReader();
      await reader.read(); // consume first event
      abort();
      ac.abort();

      // Stream should end (either closed or errored) — not hang
      const done = await Promise.race([
        (async () => {
          try {
            while (!(await reader.read()).done) {
              /* drain */
            }
          } catch {
            /* error is fine */
          }
          return "done";
        })(),
        new Promise<string>((r) => setTimeout(() => r("timeout"), 2000)),
      ]);

      expect(done).toBe("done");
      reader.releaseLock();
    });
  });

  it("replays split chunks (partial lines across reads)", async () => {
    // Same as simple text but with chunks split in the middle of SSE lines
    const { anthropicSimpleText } = await import("../fixtures/sse.js");
    const response = fixtureToResponse(anthropicSimpleText, { splitChunks: true });
    await withFakeResponse(response, async () => {
      const result = await provider.stream(makeRequest());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { response: resp } = await collectStream(result.value);
      expect(resp?.message.content[0]?.type).toBe("text");
    });
  });
});

// ─── OpenAI provider tests ────────────────────────────────────────────────────

describe("OpenAIProvider — SSE replay", () => {
  let provider: InstanceType<typeof import("@helix/ai")["OpenAIProvider"]>;

  beforeAll(async () => {
    const { OpenAIProvider } = await import("@helix/ai");
    provider = new OpenAIProvider({ apiKey: "test-key" });
  });

  for (const fixture of FIXTURES_BY_PROVIDER.openai) {
    it(`parses: ${fixture.name}`, async () => {
      const response = fixtureToResponse(fixture);
      await withFakeResponse(response, async () => {
        const result = await provider.stream(makeRequest("gpt-4o"));
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const { response: resp, error } = await collectStream(result.value);
        expect(error).toBeUndefined();
        expect(resp?.stopReason).toBe(fixture.expected.stopReason);
      });
    });
  }

  it("produces unique IDs for parallel OpenAI tool calls", async () => {
    const response = fixtureToResponse(openaiParallelToolCalls);
    await withFakeResponse(response, async () => {
      const result = await provider.stream(makeRequest("gpt-4o"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { response: resp } = await collectStream(result.value);
      const toolCalls = resp?.message.content.filter((c) => c.type === "tool_call");
      expect(toolCalls).toHaveLength(2);
      const ids = toolCalls.map((c) => (c.type === "tool_call" ? c.id : ""));
      expect(new Set(ids).size).toBe(2);
    });
  });

  it("streams [DONE] sentinel is handled, not parsed as JSON", async () => {
    const { openaiSimpleText } = await import("../fixtures/sse.js");
    // Verify the [DONE] line doesn't cause a JSON parse error
    const response = fixtureToResponse(openaiSimpleText);
    await withFakeResponse(response, async () => {
      const result = await provider.stream(makeRequest("gpt-4o"));
      const { error } = await collectStream(result.value);
      expect(error).toBeUndefined();
    });
  });
});

// ─── Google provider tests ────────────────────────────────────────────────────

describe("GoogleProvider — SSE replay", () => {
  let provider: InstanceType<typeof import("@helix/ai")["GoogleProvider"]>;

  beforeAll(async () => {
    const { GoogleProvider } = await import("@helix/ai");
    provider = new GoogleProvider({ apiKey: "test-key" });
  });

  for (const fixture of FIXTURES_BY_PROVIDER.google) {
    it(`parses: ${fixture.name}`, async () => {
      const response = fixtureToResponse(fixture);
      await withFakeResponse(response, async () => {
        const result = await provider.stream(makeRequest("gemini-2.5-flash"));
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const { response: resp, error } = await collectStream(result.value);
        expect(error).toBeUndefined();
        expect(resp?.stopReason).toBe(fixture.expected.stopReason);
      });
    });
  }

  it("produces unique IDs when same tool called twice", async () => {
    // This is the Google ID collision bug we fixed — regression test
    const response = fixtureToResponse(googleParallelToolCalls);
    await withFakeResponse(response, async () => {
      const result = await provider.stream(makeRequest("gemini-2.5-flash"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { response: resp } = await collectStream(result.value);
      const toolCalls = resp?.message.content.filter((c) => c.type === "tool_call");
      expect(toolCalls).toHaveLength(2);
      const ids = toolCalls.map((c) => (c.type === "tool_call" ? c.id : ""));
      // IDs must differ even though tool name is the same
      expect(ids[0]).not.toBe(ids[1]);
    });
  });
});

// ─── Cross-provider invariants ────────────────────────────────────────────────

describe("All providers — stream contract invariants", () => {
  it("every stream ends with exactly one 'done' event", async () => {
    const { AnthropicProvider, OpenAIProvider, GoogleProvider } = await import("@helix/ai");
    const providers = [
      {
        p: new AnthropicProvider({ apiKey: "k" }),
        fixture: (await import("../fixtures/sse.js")).anthropicSimpleText,
        model: "claude-sonnet-4-5",
      },
      {
        p: new OpenAIProvider({ apiKey: "k" }),
        fixture: (await import("../fixtures/sse.js")).openaiSimpleText,
        model: "gpt-4o",
      },
      {
        p: new GoogleProvider({ apiKey: "k" }),
        fixture: (await import("../fixtures/sse.js")).googleSimpleText,
        model: "gemini-2.5-flash",
      },
    ];

    for (const { p, fixture, model } of providers) {
      const response = fixtureToResponse(fixture);
      await withFakeResponse(response, async () => {
        const result = await p.stream(makeRequest(model));
        if (!result.ok) return;

        const events: StreamEvent[] = [];
        await consumeStream(result.value, (e) => {
          events.push(e);
        });

        const doneEvents = events.filter((e) => e.type === "done");
        expect(doneEvents).toHaveLength(1);
        expect(doneEvents[0]).toMatchObject({ type: "done" });
      });
    }
  });

  it("cost is always non-negative", async () => {
    const { AnthropicProvider } = await import("@helix/ai");
    const provider = new AnthropicProvider({ apiKey: "k" });

    for (const fixture of FIXTURES_BY_PROVIDER.anthropic) {
      const response = fixtureToResponse(fixture);
      await withFakeResponse(response, async () => {
        const result = await provider.stream(makeRequest());
        if (!result.ok) return;
        const { response: resp } = await collectStream(result.value);
        if (!resp) return;
        expect(resp.cost.totalCostUsd).toBeGreaterThanOrEqual(0);
        expect(resp.cost.promptCostUsd).toBeGreaterThanOrEqual(0);
        expect(resp.cost.completionCostUsd).toBeGreaterThanOrEqual(0);
      });
    }
  });
});
