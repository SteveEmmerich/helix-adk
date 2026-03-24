/**
 * @helix/core tests
 *
 * Tests agent loop behaviour with a mock provider — no API calls.
 */

import { describe, it, expect, mock, spyOn } from "bun:test"
const vi = { fn: mock, mock, spyOn };
import {
  Agent,
  defineTool,
  withLogging,
  withBudget,
  MemorySessionStorage,
  FileSessionStorage,
  SessionManager,
  InMemoryStore,
  createMemoryTools,
  WindowCompactionStrategy,
} from "../src/index.js";
import { modelId, providerId, requestId, toolCallId, ok, err } from "@helix/ai";
import type { Provider, CompletionResponse, StreamEvent, ModelInfo, CompletionRequest } from "@helix/ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Mock provider ─────────────────────────────────────────────────────────────

function streamFromResponse(resp: CompletionResponse): ReadableStream<StreamEvent> {
  return new ReadableStream<StreamEvent>({
    start(controller) {
      const textParts = resp.message.content.filter((c) => c.type === "text");
      for (const part of textParts) {
        if (part.type === "text") {
          controller.enqueue({ type: "text_delta", delta: part.text });
        }
      }
      controller.enqueue({ type: "done", response: resp });
      controller.close();
    },
  });
}

function makeProvider(responses: Array<() => CompletionResponse>): Provider {
  let callIndex = 0;

  return {
    id: providerId("mock"),
    displayName: "Mock",
    listModels: async () => ok([] as ModelInfo[]),
    complete: async () => {
      const resp = responses[callIndex++]?.();
      return resp ? ok(resp) : err(new Error("No more responses"));
    },
    stream: async () => {
      const resp = responses[callIndex++]?.();
      if (!resp) return err(new Error("No more responses"));
      return ok(streamFromResponse(resp));
    },
  };
}

function makeProviderWithRequests(
  responses: Array<() => CompletionResponse>,
  requests: CompletionRequest[]
): Provider {
  let callIndex = 0;
  return {
    id: providerId("mock"),
    displayName: "Mock",
    listModels: async () => ok([] as ModelInfo[]),
    complete: async () => err(new Error("complete not used")),
    stream: async (request) => {
      requests.push(request);
      const resp = responses[callIndex++]?.();
      if (!resp) return err(new Error("No more responses"));
      return ok(streamFromResponse(resp));
    },
  };
}

function makeTextResponse(text: string): CompletionResponse {
  return {
    id: requestId("resp_1"),
    model: modelId("mock-model"),
    stopReason: "end_turn",
    message: { role: "assistant", content: [{ type: "text", text }] },
    usage: { promptTokens: 10, completionTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 30 },
    cost: { promptCostUsd: 0.001, completionCostUsd: 0.002, cacheReadCostUsd: 0, cacheWriteCostUsd: 0, totalCostUsd: 0.003 },
    durationMs: 100,
  };
}

function makeTextResponseWithStop(text: string, stopReason: CompletionResponse["stopReason"]): CompletionResponse {
  return {
    id: requestId("resp_1"),
    model: modelId("mock-model"),
    stopReason,
    message: { role: "assistant", content: [{ type: "text", text }] },
    usage: { promptTokens: 10, completionTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 30 },
    cost: { promptCostUsd: 0.001, completionCostUsd: 0.002, cacheReadCostUsd: 0, cacheWriteCostUsd: 0, totalCostUsd: 0.003 },
    durationMs: 100,
  };
}

function makeToolResponse(toolName: string, input: unknown): CompletionResponse {
  return {
    id: requestId("resp_tool"),
    model: modelId("mock-model"),
    stopReason: "tool_use",
    message: {
      role: "assistant",
      content: [{ type: "tool_call", id: toolCallId("call_1"), name: toolName, input }],
    },
    usage: { promptTokens: 10, completionTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 30 },
    cost: { promptCostUsd: 0, completionCostUsd: 0, cacheReadCostUsd: 0, cacheWriteCostUsd: 0, totalCostUsd: 0 },
    durationMs: 50,
  };
}

const MOCK_MODEL = modelId("mock-model");

// ─── Agent basic run ──────────────────────────────────────────────────────────

describe("Agent", () => {
  it("runs a simple turn and returns text", async () => {
    const provider = makeProvider([() => makeTextResponse("Hello from helix!")]);
    const agent = new Agent({ provider, model: MOCK_MODEL });
    const result = await agent.run({ input: "Hi" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.finalMessage).toBe("Hello from helix!");
      expect(result.value.stopReason).toBe("end_turn");
    }
  });

  it("executes a tool call and continues", async () => {
    const echoTool = defineTool({
      name: "echo",
      description: "Echoes input",
      inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
      execute: async ({ msg }: { msg: string }) => ({ echo: msg }),
      formatOutput: (out) => out.echo,
    });

    const provider = makeProvider([
      () => makeToolResponse("echo", { msg: "test" }),
      () => makeTextResponse("I echoed: test"),
    ]);

    const toolExecuted = vi.fn();
    const agent = new Agent({ provider, model: MOCK_MODEL, tools: [echoTool] });

    const result = await agent.run({
      input: "Echo 'test'",
      onEvent: async (event) => {
        if (event.type === "tool_result") toolExecuted(event.name);
      },
    });

    expect(result.ok).toBe(true);
    expect(toolExecuted).toHaveBeenCalledWith("echo");
    if (result.ok) expect(result.value.finalMessage).toBe("I echoed: test");
  });

  it("runs research phase before main turn and injects findings", async () => {
    const searchTool = defineTool({
      name: "search",
      description: "Search",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      execute: async ({ q }: { q: string }) => `found:${q}`,
      formatOutput: (out) => String(out),
    });

    const requests: CompletionRequest[] = [];
    const provider = makeProviderWithRequests(
      [
        () => makeToolResponse("search", { q: "helix" }),
        () => makeTextResponse("[research-complete]"),
        () => makeTextResponse("final response"),
      ],
      requests
    );

    const events: string[] = [];
    const agent = new Agent({
      provider,
      model: MOCK_MODEL,
      tools: [searchTool],
      researchPhase: true,
      researchMaxTurns: 2,
    });

    const result = await agent.run({
      input: "Tell me about helix",
      onEvent: async (event) => {
        if (event.type === "research_start") events.push("start");
        if (event.type === "research_tool") events.push(`tool:${event.name}`);
        if (event.type === "research_complete") events.push("complete");
      },
    });

    expect(result.ok).toBeTrue();
    expect(events).toContain("start");
    expect(events).toContain("tool:search");
    expect(events).toContain("complete");
    expect(requests.length).toBe(3);
    const mainRequest = requests[2];
    const researchBlock = mainRequest.messages.find(
      (msg) => msg.role === "system" && String(msg.content).includes("## Research findings")
    );
    expect(researchBlock).toBeTruthy();
  });

  it("skips research phase when disabled", async () => {
    const requests: CompletionRequest[] = [];
    const provider = makeProviderWithRequests([() => makeTextResponse("no research")], requests);
    const agent = new Agent({ provider, model: MOCK_MODEL, researchPhase: false });
    const result = await agent.run({ input: "Hi" });
    expect(result.ok).toBeTrue();
    expect(requests.length).toBe(1);
  });

  it("respects maxTurns limit", async () => {
    // Always returns tool_use → should stop at maxTurns
    const infiniteTool = defineTool({
      name: "loop",
      description: "Loops",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({}),
    });

    // Provide enough responses for 2 turns + 1 (tool result = same turn)
    const provider = makeProvider([
      () => makeToolResponse("loop", {}),
      () => makeToolResponse("loop", {}),
      () => makeToolResponse("loop", {}),
    ]);

    const agent = new Agent({ provider, model: MOCK_MODEL, tools: [infiniteTool], maxTurns: 2 });
    const result = await agent.run({ input: "Loop" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stopReason).toBe("max_turns");
  });

  it("returns Err when provider stream fails", async () => {
    const provider: Provider = {
      id: providerId("mock"),
      displayName: "Mock",
      listModels: async () => ok([] as ModelInfo[]),
      complete: async () => err(new Error("complete not used")),
      stream: async () => err(new Error("stream failed")),
    };

    const agent = new Agent({ provider, model: MOCK_MODEL });
    const result = await agent.run({ input: "Hi" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("stream failed");
    }
  });

  it("accumulates cost across turns", async () => {
    const provider = makeProvider([
      () => makeTextResponse("Turn 1"),
    ]);

    const agent = new Agent({ provider, model: MOCK_MODEL });
    await agent.run({ input: "Go" });

    expect(agent.state.totalCostUsd).toBeGreaterThan(0);
    expect(agent.state.totalTokens).toBeGreaterThan(0);
  });

  it("resets state on reset()", async () => {
    const provider = makeProvider([() => makeTextResponse("Hi"), () => makeTextResponse("Hi again")]);
    const agent = new Agent({ provider, model: MOCK_MODEL, systemPrompt: "You are helpful." });

    await agent.run({ input: "First" });
    agent.reset();

    expect(agent.state.turns).toBe(0);
    expect(agent.state.totalCostUsd).toBe(0);
    // System prompt should still be there
    expect(agent.state.messages.length).toBe(1);
  });

  it("activating the same skill twice is idempotent", async () => {
    const provider = makeProvider([
      () => makeTextResponseWithStop("Use @code-review", "max_tokens"),
      () => makeTextResponse("Again @code-review"),
    ]);
    const activate = vi.fn(async () => ({ instructions: "SKILL: code-review" }));
    const skillLoader = {
      discover: async () => [
        {
          id: "code-review",
          name: "code-review",
          description: "Review",
          tier: "CORE",
          tags: ["review"],
          allowedTools: ["read_file"],
        },
      ],
      activate,
    };

    const agent = new Agent({ provider, model: MOCK_MODEL, skillLoader });
    await agent.run({ input: "Review this" });

    const injected = agent.state.messages.filter(
      (msg) => msg.role === "system" && msg.content.includes("SKILL: code-review")
    );
    expect(injected.length).toBe(1);
  });

  it("passes AbortSignal through to tool execution", async () => {
    const controller = new AbortController();
    let received: AbortSignal | null = null;
    const tool = defineTool({
      name: "signal_echo",
      description: "Echoes the signal object",
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async (_input: Record<string, unknown>, signal: AbortSignal) => {
        received = signal;
        return { ok: true };
      },
    });
    const provider = makeProvider([
      () => makeToolResponse("signal_echo", {}),
      () => makeTextResponse("done"),
    ]);
    const agent = new Agent({ provider, model: MOCK_MODEL, tools: [tool] });
    await agent.run({ input: "Go", signal: controller.signal });

    expect(received).toBe(controller.signal);
  });

  it("uses an email-safe skill mention regex", async () => {
    const activate = vi.fn(async () => ({ instructions: "SKILL" }));
    const skillLoader = {
      discover: async () => [
        {
          id: "code-review",
          name: "code-review",
          description: "Review",
          tier: "CORE",
          tags: ["code"],
          allowedTools: ["read_file"],
        },
        {
          id: "git-workflow",
          name: "git-workflow",
          description: "Git",
          tier: "CORE",
          tags: ["git"],
          allowedTools: ["bash"],
        },
      ],
      activate,
    };

    const provider = makeProvider([
      () => makeTextResponseWithStop("[skill:code-review]", "max_tokens"),
      () => makeTextResponseWithStop("user@example.com", "max_tokens"),
      () => makeTextResponseWithStop("email me at foo@bar.com please", "max_tokens"),
      () => makeTextResponseWithStop("[skill:git-workflow] and [skill:code-review]", "max_tokens"),
      () => makeTextResponse("done"),
    ]);

    const agent = new Agent({ provider, model: MOCK_MODEL, skillLoader });
    await agent.run({ input: "go" });

    const activatedIds = activate.mock.calls.map((call) => String(call[0]));
    expect(activatedIds).toContain("code-review");
    expect(activatedIds).toContain("git-workflow");
    expect(activatedIds).not.toContain("example");
    expect(activatedIds).not.toContain("bar");
  });

  it("activates skills from [skill:id] markers in assistant responses", async () => {
    const activate = vi.fn(async () => ({ instructions: "SKILL" }));
    const skillLoader = {
      discover: async () => [
        {
          id: "code-review",
          name: "code-review",
          description: "Review code",
          tier: "CORE",
          tags: ["review"],
          allowedTools: ["read_file"],
        },
      ],
      activate,
    };

    const provider = makeProvider([
      () => makeTextResponseWithStop("[skill:code-review]", "max_tokens"),
      () => makeTextResponse("done"),
    ]);
    const agent = new Agent({ provider, model: MOCK_MODEL, skillLoader });
    await agent.run({ input: "go" });
    expect(activate).toHaveBeenCalledWith("code-review");
  });

  it("suggests relevant skills based on keyword scoring", async () => {
    const skillLoader = {
      discover: async () => [
        {
          id: "code-review",
          name: "code-review",
          description: "Review code for bugs",
          tier: "CORE",
          tags: ["review", "code"],
          allowedTools: ["read_file"],
        },
      ],
      activate: async () => ({ instructions: "SKILL" }),
    };

    const provider = makeProvider([() => makeTextResponse("done")]);
    const agent = new Agent({ provider, model: MOCK_MODEL, skillLoader });
    await agent.run({ input: "Please review my code" });
    const skillBlock = agent.state.messages.find(
      (msg) => msg.role === "system" && msg.content.startsWith("## Available Skills")
    );
    expect(skillBlock?.content.includes("(suggested)")).toBe(true);
  });

  it("adds an autonomous hint to the skills block when autonomous", async () => {
    const skillLoader = {
      discover: async () => [
        {
          id: "code-review",
          name: "code-review",
          description: "Review code for bugs",
          tier: "CORE",
          tags: ["review"],
          allowedTools: ["read_file"],
        },
      ],
      activate: async () => ({ instructions: "SKILL" }),
    };

    const provider = makeProvider([() => makeTextResponse("done")]);
    const agent = new Agent({ provider, model: MOCK_MODEL, skillLoader });
    await agent.run({ input: "do it", autonomous: true });
    const skillBlock = agent.state.messages.find(
      (msg) => msg.role === "system" && msg.content.startsWith("## Available Skills")
    );
    expect(skillBlock?.content.includes("activate skills proactively")).toBe(true);
  });

  it("moves activated skills from available to active section", async () => {
    const skillLoader = {
      discover: async () => [
        {
          id: "code-review",
          name: "code-review",
          description: "Review code for bugs",
          tier: "CORE",
          tags: ["review"],
          allowedTools: ["read_file"],
        },
      ],
      activate: async () => ({ instructions: "SKILL" }),
    };

    const provider = makeProvider([
      () => makeTextResponseWithStop("[skill:code-review]", "max_tokens"),
      () => makeTextResponse("done"),
    ]);
    const agent = new Agent({ provider, model: MOCK_MODEL, skillLoader });
    await agent.run({ input: "go" });
    const skillBlock = agent.state.messages.find(
      (msg) => msg.role === "system" && msg.content.startsWith("## Available Skills")
    );
    expect(skillBlock?.content.includes("## Active Skills")).toBe(true);
    expect(skillBlock?.content.includes("**code-review**: full instructions loaded")).toBe(true);
    expect(skillBlock?.content.includes("- **code-review** (CORE)")).toBe(false);
  });

  it("keeps backward compatibility for @skill-name", async () => {
    const activate = vi.fn(async () => ({ instructions: "SKILL" }));
    const skillLoader = {
      discover: async () => [
        {
          id: "code-review",
          name: "code-review",
          description: "Review code",
          tier: "CORE",
          tags: ["review"],
          allowedTools: ["read_file"],
        },
      ],
      activate,
    };

    const provider = makeProvider([
      () => makeTextResponseWithStop("@code-review", "max_tokens"),
      () => makeTextResponse("done"),
    ]);
    const agent = new Agent({ provider, model: MOCK_MODEL, skillLoader });
    await agent.run({ input: "go" });
    expect(activate).toHaveBeenCalledWith("code-review");
  });
});

// ─── Tool builder ─────────────────────────────────────────────────────────────

describe("defineTool", () => {
  it("executes and formats output", async () => {
    const tool = defineTool({
      name: "add",
      description: "Adds two numbers",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      execute: async ({ a, b }: { a: number; b: number }) => a + b,
      formatOutput: (result) => `Result: ${result}`,
    });

    const output = await tool.execute({ a: 2, b: 3 }, new AbortController().signal);
    expect(output).toBe(5);
    expect(tool.formatOutput?.(output)).toBe("Result: 5");
  });
});

// ─── Middleware ───────────────────────────────────────────────────────────────

describe("middleware", () => {
  it("withBudget blocks when cost exceeded", async () => {
    const provider = makeProvider([() => makeTextResponse("Hello")]);
    const exceeded = vi.fn();

    const agent = new Agent({
      provider,
      model: MOCK_MODEL,
      middleware: [withBudget({ maxCostUsd: 0.0001, onExceeded: exceeded })],
    });

    // First run works fine
    await agent.run({ input: "Go" });
    // State cost is now 0.003, above 0.0001 — next run should block
    const result = await agent.run({ input: "Go again" });
    expect(result.ok).toBe(false);
  });

  it("withLogging calls log function", async () => {
    const provider = makeProvider([() => makeTextResponse("Logged")]);
    const logs: string[] = [];
    const log = (msg: string) => logs.push(msg);

    const agent = new Agent({
      provider,
      model: MOCK_MODEL,
      middleware: [withLogging({ log })],
    });

    await agent.run({ input: "Test" });
    expect(logs.some((l) => l.includes("turn start"))).toBe(true);
    expect(logs.some((l) => l.includes("turn complete"))).toBe(true);
  });
});

// ─── Session management ───────────────────────────────────────────────────────

describe("SessionManager", () => {
  it("creates and retrieves sessions", async () => {
    const storage = new MemorySessionStorage();
    const manager = new SessionManager(storage);

    const session = await manager.create({ title: "Test session" });
    expect(session.metadata.title).toBe("Test session");

    const loaded = await manager.load(session.metadata.id);
    expect(loaded?.metadata.id).toBe(session.metadata.id);
  });

  it("forks a session", async () => {
    const storage = new MemorySessionStorage();
    const manager = new SessionManager(storage);

    await manager.create({ title: "Original" });
    const forked = await manager.fork();

    expect(forked.parentId).toBeDefined();
    expect(forked.metadata.id).not.toBe(forked.parentId);
  });

  it("lists sessions", async () => {
    const storage = new MemorySessionStorage();
    const manager = new SessionManager(storage);

    await manager.create({ title: "A" });
    await manager.create({ title: "B" });

    const sessions = await manager.list();
    expect(sessions.length).toBe(2);
  });

  it("syncFromAgent assigns totals without double counting", async () => {
    const storage = new MemorySessionStorage();
    const manager = new SessionManager(storage);

    await manager.create({ title: "Totals" });

    const provider = makeProvider([() => makeTextResponse("Hello")]);
    const agent = new Agent({ provider, model: MOCK_MODEL });
    await agent.run({ input: "Go" });

    const state = agent.state;
    await manager.syncFromAgent(state);
    await manager.syncFromAgent(state);

    const current = manager.current;
    expect(current?.metadata.totalCostUsd).toBe(state.totalCostUsd);
    expect(current?.metadata.totalTokens).toBe(state.totalTokens);
  });
});

describe("FileSessionStorage", () => {
  it("filters sessions by tags and workingDirectory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helix-sessions-"));
    const storage = new FileSessionStorage(dir);

    const now = Date.now();
    await storage.save({
      metadata: {
        id: "s1",
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        tags: ["alpha"],
        workingDirectory: "/work/a",
      },
      messages: [],
    });
    await storage.save({
      metadata: {
        id: "s2",
        createdAt: now,
        updatedAt: now + 1,
        messageCount: 0,
        tags: ["beta"],
        workingDirectory: "/work/b",
      },
      messages: [],
    });

    const byTag = await storage.list({ tags: ["alpha"] });
    expect(byTag.map((s) => s.id)).toEqual(["s1"]);

    const byDir = await storage.list({ workingDirectory: "/work/b" });
    expect(byDir.map((s) => s.id)).toEqual(["s2"]);

    await rm(dir, { recursive: true, force: true });
  });
});

// ─── Memory ───────────────────────────────────────────────────────────────────

describe("InMemoryStore", () => {
  it("stores and retrieves by ID", async () => {
    const store = new InMemoryStore();
    await store.set("user.name", "Alice");
    const entry = await store.get("user.name");
    expect(entry?.content).toBe("Alice");
  });

  it("searches by tag", async () => {
    const store = new InMemoryStore();
    await store.set("a", "Alpha", ["greek"]);
    await store.set("b", "Beta", ["greek"]);
    await store.set("c", "Cat", ["animal"]);

    const greek = await store.search(["greek"]);
    expect(greek).toHaveLength(2);
  });

  it("queries by text", async () => {
    const store = new InMemoryStore();
    await store.set("fact.1", "TypeScript is a superset of JavaScript");
    await store.set("fact.2", "Python is great for ML");

    const results = await store.query("TypeScript");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("fact.1");
  });

  it("creates memory tools that agents can call", () => {
    const store = new InMemoryStore();
    const tools = createMemoryTools(store);
    expect(tools.map((t) => t.name)).toEqual(["remember", "recall", "forget"]);
  });
});

// ─── Compaction ───────────────────────────────────────────────────────────────

describe("WindowCompactionStrategy", () => {
  it("triggers compaction when messages exceed threshold", () => {
    const strategy = new WindowCompactionStrategy(5);
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: "user" as const,
      content: `Message ${i}`,
    }));
    const session = { metadata: { id: "x", createdAt: 0, updatedAt: 0, messageCount: 30 }, messages };
    expect(strategy.shouldCompact(session, 200_000)).toBe(true);
  });

  it("keeps last N messages after compaction", async () => {
    const strategy = new WindowCompactionStrategy(3);
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `Message ${i}`,
    }));
    const session = { metadata: { id: "x", createdAt: 0, updatedAt: 0, messageCount: 10 }, messages };
    const compacted = await strategy.compact(session);

    // Should have: summary user msg + summary assistant msg + last 3 messages
    expect(compacted.length).toBe(5);
  });
});
