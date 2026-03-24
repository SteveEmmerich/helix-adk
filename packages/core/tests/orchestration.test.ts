/**
 * Multi-agent orchestration tests — all run with mock providers, no API calls
 */

import { describe, it, expect, vi } from "bun:test";
import { runPipeline, runParallel, runSwarm, runCritiqueLoop } from "../src/orchestration/index.js";
import { modelId, providerId, requestId, ok } from "@helix/ai";
import type { Provider, CompletionResponse, ModelInfo, StreamEvent } from "@helix/ai";

function mockResponse(text: string): CompletionResponse {
  return {
    id: requestId("r1"),
    model: modelId("mock"),
    stopReason: "end_turn",
    message: { role: "assistant", content: [{ type: "text", text }] },
    usage: { promptTokens: 5, completionTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 },
    cost: { promptCostUsd: 0, completionCostUsd: 0.001, cacheReadCostUsd: 0, cacheWriteCostUsd: 0, totalCostUsd: 0.001 },
    durationMs: 50,
  };
}

function responseToStream(text: string): ReadableStream<StreamEvent> {
  const resp = mockResponse(text);
  return new ReadableStream<StreamEvent>({
    start(controller) {
      controller.enqueue({ type: "text_delta", delta: text });
      controller.enqueue({ type: "done", response: resp });
      controller.close();
    },
  });
}

function makeProvider(responses: string[]): Provider {
  let i = 0;
  return {
    id: providerId("mock"),
    displayName: "Mock",
    listModels: async () => ok([] as ModelInfo[]),
    complete: async () => ok(mockResponse(responses[i++] ?? "done")),
    stream: async () => ok(responseToStream(responses[i++] ?? "done")),
  };
}

const MODEL = modelId("mock");

// ─── Pipeline ─────────────────────────────────────────────────────────────────

describe("runPipeline", () => {
  it("passes output of each step as input to the next", async () => {
    const p1 = makeProvider(["Step 1 output"]);
    const p2 = makeProvider(["Step 2 output"]);

    const capturedInputs: string[] = [];

    const result = await runPipeline(
      [
        { id: "step1", config: { provider: p1, model: MODEL } },
        {
          id: "step2",
          config: { provider: p2, model: MODEL },
          transform: (input) => {
            capturedInputs.push(input);
            return input; // pass through
          },
        },
      ],
      "Initial input"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.finalOutput).toBe("Step 2 output");
      expect(result.value.steps).toHaveLength(2);
      expect(capturedInputs[0]).toBe("Step 1 output");
    }
  });

  it("returns error if any step fails", async () => {
    const badProvider: Provider = {
      id: providerId("bad"),
      displayName: "Bad",
      listModels: async () => ok([] as ModelInfo[]),
      complete: async () => ({ ok: false, error: new Error("provider down") }),
      stream: async () => ({ ok: false, error: new Error("provider down") }),
    };

    const result = await runPipeline(
      [{ id: "broken", config: { provider: badProvider, model: MODEL } }],
      "input"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("broken");
  });

  it("accumulates cost across steps", async () => {
    const p1 = makeProvider(["a"]);
    const p2 = makeProvider(["b"]);

    const result = await runPipeline(
      [
        { id: "s1", config: { provider: p1, model: MODEL } },
        { id: "s2", config: { provider: p2, model: MODEL } },
      ],
      "go"
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.totalCostUsd).toBeGreaterThan(0);
  });
});

// ─── Parallel ─────────────────────────────────────────────────────────────────

describe("runParallel", () => {
  it("runs agents concurrently and collects all outputs", async () => {
    const started: string[] = [];

    const result = await runParallel(
      [
        { id: "agent-a", config: { provider: makeProvider(["Output A"]), model: MODEL } },
        { id: "agent-b", config: { provider: makeProvider(["Output B"]), model: MODEL } },
        { id: "agent-c", config: { provider: makeProvider(["Output C"]), model: MODEL } },
      ],
      "shared input",
      async (event) => {
        if (event.type === "agent_start") started.push(event.agentId);
      }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outputs).toHaveLength(3);
      const outputTexts = result.value.outputs.map((o) => o.output);
      expect(outputTexts).toContain("Output A");
      expect(outputTexts).toContain("Output B");
      expect(outputTexts).toContain("Output C");
      expect(started).toHaveLength(3);
    }
  });

  it("allows per-agent input override", async () => {
    const captured: string[] = [];

    const result = await runParallel(
      [
        {
          id: "a",
          config: { provider: makeProvider(["ok"]), model: MODEL },
          input: "custom input for A",
        },
      ],
      "shared input",
      async (event) => {
        if (event.type === "agent_start") captured.push(event.input);
      }
    );

    expect(result.ok).toBe(true);
    expect(captured[0]).toBe("custom input for A");
  });
});

// ─── Swarm ────────────────────────────────────────────────────────────────────

describe("runSwarm", () => {
  it("coordinator can delegate to specialists", async () => {
    // Coordinator: calls delegate_to_researcher tool, then synthesizes
    const researcherProvider = makeProvider(["Research result: TypeScript is great"]);

    // The coordinator needs to produce a tool_call for delegate_to_researcher,
    // then a final text response after getting the result.
    // We'll test this via the event stream rather than verifying tool dispatch
    // (since the mock provider doesn't actually use the swarm tools).

    const coordinatorProvider = makeProvider([
      "Based on research, TypeScript is excellent for large projects.",
    ]);

    const events: string[] = [];

    const result = await runSwarm(
      { provider: coordinatorProvider, model: MODEL },
      [
        {
          id: "researcher",
          description: "Researches technical topics",
          config: { provider: researcherProvider, model: MODEL },
        },
      ],
      "Should we use TypeScript?",
      async (event) => {
        events.push(event.type);
      }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.coordinatorOutput).toBeTruthy();
      expect(events).toContain("agent_start");
      expect(events).toContain("agent_done");
    }
  });
});

// ─── Critique loop ────────────────────────────────────────────────────────────

describe("runCritiqueLoop", () => {
  it("approves on first round if critique returns approval signal", async () => {
    const workerProvider = makeProvider(["My first draft"]);
    const critiqueProvider = makeProvider(["APPROVED"]);

    const result = await runCritiqueLoop("Write a haiku about code", {
      workerConfig: { provider: workerProvider, model: MODEL },
      critiqueConfig: { provider: critiqueProvider, model: MODEL },
      maxRounds: 3,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rounds).toBe(1);
      expect(result.value.finalOutput).toBe("My first draft");
    }
  });

  it("runs multiple rounds until approval", async () => {
    const workerProvider = makeProvider(["Draft 1", "Draft 2"]);
    const critiqueProvider = makeProvider(["Needs improvement", "APPROVED"]);

    const result = await runCritiqueLoop("Write something", {
      workerConfig: { provider: workerProvider, model: MODEL },
      critiqueConfig: { provider: critiqueProvider, model: MODEL },
      maxRounds: 3,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rounds).toBe(2);
      expect(result.value.finalOutput).toBe("Draft 2");
    }
  });

  it("stops at maxRounds if never approved", async () => {
    const workerProvider = makeProvider(["D1", "D2"]);
    const critiqueProvider = makeProvider(["Not good", "Still not good"]);

    const result = await runCritiqueLoop("Write something", {
      workerConfig: { provider: workerProvider, model: MODEL },
      critiqueConfig: { provider: critiqueProvider, model: MODEL },
      maxRounds: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rounds).toBe(2);
  });
});
