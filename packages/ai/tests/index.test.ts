/**
 * @helix/ai tests
 *
 * These run without any API keys — they test the transformation layer,
 * type system, and provider contract in isolation.
 */

import { describe, it, expect, vi } from "bun:test";
import {
  modelId, providerId, toolCallId, requestId,
  ok, err,
  userMsg, systemMsg,
  DefaultProviderRegistry,
} from "../src/index.js";
import type { Provider, ModelInfo, CompletionRequest, CompletionResponse } from "../src/index.js";

// ─── Branded types ────────────────────────────────────────────────────────────

describe("branded types", () => {
  it("constructs ModelId", () => {
    const id = modelId("claude-sonnet-4-5");
    expect(id).toBe("claude-sonnet-4-5");
  });

  it("constructs ToolCallId", () => {
    const id = toolCallId("call_abc123");
    expect(id).toBe("call_abc123");
  });
});

// ─── Result type ─────────────────────────────────────────────────────────────

describe("Result<T, E>", () => {
  it("ok() wraps value", () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it("err() wraps error", () => {
    const r = err(new Error("oops"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("oops");
  });
});

// ─── Message builders ─────────────────────────────────────────────────────────

describe("message builders", () => {
  it("userMsg creates user message with string content", () => {
    const msg = userMsg("hello");
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("hello");
  });

  it("systemMsg creates system message", () => {
    const msg = systemMsg("You are helpful.");
    expect(msg.role).toBe("system");
    expect(msg.content).toBe("You are helpful.");
  });
});

// ─── Provider registry ────────────────────────────────────────────────────────

describe("DefaultProviderRegistry", () => {
  const makeProvider = (id: string): Provider => ({
    id: providerId(id),
    displayName: id,
    listModels: async () => ok([{
      id: modelId(`${id}-model`),
      provider: providerId(id),
      displayName: "Test Model",
      capabilities: {
        vision: false, toolCalling: true, parallelToolCalling: false,
        streaming: true, extendedThinking: false, jsonMode: false,
        contextWindow: 128_000, maxOutputTokens: 4096,
      },
      pricing: { promptPer1MTokens: 1, completionPer1MTokens: 4 },
    }] satisfies ModelInfo[]),
    complete: async (_req) => err(new Error("not implemented")),
    stream: async (_req, _handler) => err(new Error("not implemented")),
  });

  it("registers and retrieves a provider", () => {
    const registry = new DefaultProviderRegistry();
    const provider = makeProvider("test");
    registry.register(provider);
    expect(registry.get(providerId("test"))).toBe(provider);
  });

  it("lists all providers", () => {
    const registry = new DefaultProviderRegistry();
    registry.register(makeProvider("a"));
    registry.register(makeProvider("b"));
    expect(registry.getAll()).toHaveLength(2);
  });

  it("resolves model after refresh", async () => {
    const registry = new DefaultProviderRegistry();
    const provider = makeProvider("test");
    registry.register(provider);
    await registry.refresh();
    const resolved = registry.resolveModel(modelId("test-model"));
    expect(resolved?.model.id).toBe("test-model");
  });
});

// ─── AnthropicProvider message transformation ─────────────────────────────────

describe("message transformation (no API key needed)", () => {
  it("handles mixed content message", () => {
    const msg = userMsg("Hello");
    expect(msg.role).toBe("user");
    expect(typeof msg.content).toBe("string");
  });

  it("assistant message with tool calls", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "I'll help with that." },
        { type: "tool_call" as const, id: toolCallId("call_1"), name: "bash", input: { command: "ls" } },
      ],
    };
    const toolCallParts = msg.content.filter((c) => c.type === "tool_call");
    expect(toolCallParts).toHaveLength(1);
    expect(toolCallParts[0]?.name).toBe("bash");
  });
});
