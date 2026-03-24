/**
 * Property-based tests for the agent loop
 *
 * Uses fast-check to generate arbitrary sequences of:
 * - Turn counts (1..20)
 * - Tool call patterns (none, one, many, same tool twice)
 * - Error injection points (turn N fails, tool N throws)
 * - Abort timing (signal fires after K events)
 *
 * For each generated scenario we assert invariants that must always hold
 * regardless of input — these are the properties that define correct behavior.
 */

import { describe, expect, it } from "bun:test";
import { err, modelId, ok, providerId, requestId, toolCallId } from "@helix/ai";
import type { CompletionResponse, ModelInfo, Provider, StreamEvent } from "@helix/ai";
import { Agent, defineTool } from "@helix/core";
import * as fc from "fast-check";

// ─── Arbitrary providers ──────────────────────────────────────────────────────

function textResponse(text: string): CompletionResponse {
  return {
    id: requestId("r"),
    model: modelId("mock"),
    stopReason: "end_turn",
    message: { role: "assistant", content: [{ type: "text", text }] },
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
    },
    cost: {
      promptCostUsd: 0.001,
      completionCostUsd: 0.001,
      cacheReadCostUsd: 0,
      cacheWriteCostUsd: 0,
      totalCostUsd: 0.002,
    },
    durationMs: 10,
  };
}

function toolResponse(name: string, input: Record<string, unknown>): CompletionResponse {
  return {
    id: requestId("r"),
    model: modelId("mock"),
    stopReason: "tool_use",
    message: {
      role: "assistant",
      content: [{ type: "tool_call", id: toolCallId("call_1"), name, input }],
    },
    usage: {
      promptTokens: 10,
      completionTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
    },
    cost: {
      promptCostUsd: 0,
      completionCostUsd: 0,
      cacheReadCostUsd: 0,
      cacheWriteCostUsd: 0,
      totalCostUsd: 0,
    },
    durationMs: 10,
  };
}

function responseToStream(resp: CompletionResponse): ReadableStream<StreamEvent> {
  return new ReadableStream({
    start(ctrl) {
      if (resp.stopReason === "tool_use") {
        for (const part of resp.message.content) {
          if (part.type === "tool_call") {
            ctrl.enqueue({ type: "tool_call_start", id: part.id, name: part.name });
            ctrl.enqueue({ type: "tool_call_end", id: part.id, input: part.input });
          }
        }
      } else {
        for (const part of resp.message.content) {
          if (part.type === "text") ctrl.enqueue({ type: "text_delta", delta: part.text });
        }
      }
      ctrl.enqueue({ type: "done", response: resp });
      ctrl.close();
    },
  });
}

function makeScriptedProvider(responses: CompletionResponse[]): Provider {
  let i = 0;
  return {
    id: providerId("scripted"),
    displayName: "Scripted",
    listModels: async () => ok([] as ModelInfo[]),
    complete: async () => ok(responses[i++] ?? textResponse("done")),
    stream: async () => ok(responseToStream(responses[i++] ?? textResponse("done"))),
  };
}

function makeErrorProvider(failOnTurn: number, _totalTurns: number): Provider {
  let i = 0;
  return {
    id: providerId("error"),
    displayName: "Error",
    listModels: async () => ok([] as ModelInfo[]),
    complete: async () => err(new Error("not used")),
    stream: async () => {
      const turn = ++i;
      if (turn === failOnTurn) return err(new Error(`Provider failed on turn ${turn}`));
      return ok(responseToStream(textResponse(`Turn ${turn} ok`)));
    },
  };
}

const MODEL = modelId("mock");

// ─── Invariant helpers ────────────────────────────────────────────────────────

function assertMessageIntegrity(messages: readonly { role: string }[]): void {
  // No two consecutive assistant messages
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]?.role === "assistant" && messages[i - 1]?.role === "assistant") {
      throw new Error(`Two consecutive assistant messages at index ${i}`);
    }
  }
  // Tool results must follow assistant messages with tool calls
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "tool") {
      if (messages[i - 1]?.role !== "assistant") {
        throw new Error(`Tool result at ${i} not preceded by assistant message`);
      }
    }
  }
}

// ─── Properties ───────────────────────────────────────────────────────────────

describe("Agent loop — properties", () => {
  it("P1: message array never has two consecutive assistant messages", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }), // number of tool-use turns before final text
        async (toolTurns) => {
          const responses: CompletionResponse[] = [
            ...Array.from({ length: toolTurns }, () => toolResponse("echo", { msg: "x" })),
            textResponse("done"),
          ];

          const provider = makeScriptedProvider(responses);
          const tool = defineTool({
            name: "echo",
            description: "echo",
            inputSchema: {
              type: "object",
              properties: { msg: { type: "string" } },
              required: ["msg"],
            },
            execute: async ({ msg }: { msg: string }) => msg,
          });

          const agent = new Agent({
            provider,
            model: MODEL,
            tools: [tool],
            maxTurns: toolTurns + 2,
          });
          await agent.run({ input: "go" });

          assertMessageIntegrity(agent.state.messages);
        }
      ),
      { numRuns: 30 }
    );
  });

  it("P2: total cost is monotonically non-decreasing across turns", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (turns) => {
        const responses = Array.from({ length: turns }, (_, i) => textResponse(`turn ${i}`));
        const costs: number[] = [];

        const provider: Provider = {
          id: providerId("cost"),
          displayName: "Cost",
          listModels: async () => ok([] as ModelInfo[]),
          complete: async () => err(new Error("n/a")),
          stream: async () => {
            const resp = responses.shift() ?? textResponse("done");
            return ok(responseToStream(resp));
          },
        };

        const agent = new Agent({ provider, model: MODEL, maxTurns: turns });
        await agent.run({
          input: "go",
          onEvent: (e) => {
            if (e.type === "turn_complete") costs.push(agent.state.totalCostUsd);
          },
        });

        for (let i = 1; i < costs.length; i++) {
          const prev = costs[i - 1] ?? 0;
          expect(costs[i]).toBeGreaterThanOrEqual(prev);
        }
      }),
      { numRuns: 20 }
    );
  });

  it("P3: turns counter never exceeds maxTurns", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }), // maxTurns
        async (maxTurns) => {
          // Provider always returns tool_use — would loop forever without maxTurns
          const provider: Provider = {
            id: providerId("infinite"),
            displayName: "Infinite",
            listModels: async () => ok([] as ModelInfo[]),
            complete: async () => err(new Error("n/a")),
            stream: async () => ok(responseToStream(toolResponse("noop", {}))),
          };

          const tool = defineTool({
            name: "noop",
            description: "does nothing",
            inputSchema: { type: "object", properties: {} },
            execute: async () => ({}),
          });

          const agent = new Agent({ provider, model: MODEL, tools: [tool], maxTurns });
          const result = await agent.run({ input: "go" });

          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value.state.turns).toBeLessThanOrEqual(maxTurns);
            expect(result.value.stopReason).toBe("max_turns");
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it("P4: finalMessage is always a string (never undefined)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant("text only" as const),
          fc.constant("tool then text" as const),
          fc.constant("empty text" as const)
        ),
        async (scenario) => {
          let responses: CompletionResponse[];
          if (scenario === "text only") {
            responses = [textResponse("hello")];
          } else if (scenario === "tool then text") {
            responses = [toolResponse("echo", { msg: "x" }), textResponse("result")];
          } else {
            responses = [textResponse("")];
          }

          const tool = defineTool({
            name: "echo",
            description: "echo",
            inputSchema: {
              type: "object",
              properties: { msg: { type: "string" } },
              required: ["msg"],
            },
            execute: async ({ msg }: { msg: string }) => msg,
          });

          const agent = new Agent({
            provider: makeScriptedProvider(responses),
            model: MODEL,
            tools: [tool],
          });
          const result = await agent.run({ input: "go" });

          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(typeof result.value.finalMessage).toBe("string");
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it("P5: tool execution errors are captured, not thrown to the loop", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }), // which call # throws
        async (throwOn) => {
          let callCount = 0;
          const flaky = defineTool({
            name: "flaky",
            description: "fails sometimes",
            inputSchema: { type: "object", properties: {} },
            execute: async () => {
              if (++callCount === throwOn) throw new Error(`Tool failed on call ${throwOn}`);
              return "ok";
            },
          });

          const responses = [
            ...Array.from({ length: throwOn + 1 }, () => toolResponse("flaky", {})),
            textResponse("recovered"),
          ];

          const agent = new Agent({
            provider: makeScriptedProvider(responses),
            model: MODEL,
            tools: [flaky],
            maxTurns: throwOn + 3,
          });

          const result = await agent.run({ input: "go" });
          // Loop should survive tool errors — result is ok, not crashed
          expect(result.ok).toBe(true);
        }
      ),
      { numRuns: 20 }
    );
  });

  it("P6: provider errors on turn N don't corrupt message state", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }), // fail on this turn
        fc.integer({ min: 2, max: 5 }), // total turns possible
        async (failOn, maxTurns) => {
          const provider = makeErrorProvider(failOn, maxTurns);
          const agent = new Agent({ provider, model: MODEL, maxTurns });
          const result = await agent.run({ input: "go" });

          // Either succeeds or returns Err when provider fails
          if (result.ok) {
            expect(["end_turn", "error", "max_turns"]).toContain(result.value.stopReason);
            assertMessageIntegrity(agent.state.messages);
          } else {
            assertMessageIntegrity(agent.state.messages);
          }
        }
      ),
      { numRuns: 25 }
    );
  });

  it("P7: reset() returns agent to clean state regardless of prior run", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.boolean(), // with or without system prompt
        async (turns, hasSystemPrompt) => {
          const responses = Array.from({ length: turns }, (_, i) => textResponse(`turn ${i}`));
          const agent = new Agent({
            provider: makeScriptedProvider(responses),
            model: MODEL,
            maxTurns: turns,
            systemPrompt: hasSystemPrompt ? "You are helpful." : undefined,
          });

          await agent.run({ input: "go" });
          expect(agent.state.turns).toBeGreaterThan(0);

          agent.reset();

          expect(agent.state.turns).toBe(0);
          expect(agent.state.totalCostUsd).toBe(0);
          expect(agent.state.totalTokens).toBe(0);
          if (hasSystemPrompt) {
            expect(agent.state.messages).toHaveLength(1);
            expect(agent.state.messages[0]?.role).toBe("system");
          } else {
            expect(agent.state.messages).toHaveLength(0);
          }
        }
      ),
      { numRuns: 25 }
    );
  });

  it("P8: aborting mid-run always returns a result (never hangs)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }), // abort after N ms
        async (abortAfterMs) => {
          let resolveStream: (value: ReadableStream<StreamEvent>) => void;
          const provider: Provider = {
            id: providerId("slow"),
            displayName: "Slow",
            listModels: async () => ok([] as ModelInfo[]),
            complete: async () => err(new Error("n/a")),
            stream: async () => {
              // Slow stream — never resolves until aborted
              const stream = new ReadableStream<StreamEvent>({
                start(ctrl) {
                  resolveStream = () => {
                    ctrl.enqueue({ type: "done", response: textResponse("ok") });
                    ctrl.close();
                  };
                },
              });
              return ok(stream);
            },
          };

          const ac = new AbortController();
          const runPromise = new Agent({ provider, model: MODEL }).run({
            input: "go",
            signal: ac.signal,
          });

          setTimeout(() => {
            ac.abort();
            resolveStream?.();
          }, abortAfterMs);

          const result = await Promise.race([
            runPromise,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Hung")), 3000)),
          ]);

          expect(result.ok).toBe(true);
          // stopReason will be aborted or end_turn depending on timing
          expect(["aborted", "end_turn"]).toContain(result.value.stopReason);
        }
      ),
      { numRuns: 15 }
    );
  });
});

// ─── Middleware composition properties ────────────────────────────────────────

describe("Middleware — composition invariants", () => {
  it("middleware executes in registration order", async () => {
    const order: number[] = [];

    const makeMiddleware = (n: number) => async (_ctx: unknown, next: () => Promise<unknown>) => {
      order.push(n);
      const result = await next();
      order.push(-n);
      return result;
    };

    const provider = makeScriptedProvider([textResponse("ok")]);
    const agent = new Agent({
      provider,
      model: MODEL,
      middleware: [makeMiddleware(1), makeMiddleware(2), makeMiddleware(3)],
    });

    await agent.run({ input: "go" });
    expect(order).toEqual([1, 2, 3, -3, -2, -1]);
  });

  it("middleware short-circuit prevents provider call", async () => {
    let providerCalled = false;
    const provider: Provider = {
      id: providerId("unused"),
      displayName: "Unused",
      listModels: async () => ok([] as ModelInfo[]),
      complete: async () => {
        providerCalled = true;
        return err(new Error("should not be called"));
      },
      stream: async () => {
        providerCalled = true;
        return err(new Error("should not be called"));
      },
    };

    const shortCircuit = async (_ctx: unknown, _next: () => Promise<unknown>) => {
      return err(new Error("blocked by middleware"));
    };

    const agent = new Agent({ provider, model: MODEL, middleware: [shortCircuit] });
    await agent.run({ input: "go" });
    expect(providerCalled).toBe(false);
  });
});
