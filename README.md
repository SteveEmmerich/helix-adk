# helix-adk

Helix ADK is a TypeScript monorepo for building AI agents, plus HelixClaw — a proof-of-concept autonomous agent product built on the kit.

## Why?

Pi-mono is brilliant in its minimalism. Helix extends that philosophy with the things the framework *should* provide but doesn't: a proper type system, first-class testing/evals, a middleware pipeline, pluggable memory, and a clean extension model.

## Package Structure

```
packages/
  ai/             — @helix/ai           Unified LLM API (Anthropic, OpenAI, Google, Ollama)
  core/           — @helix/core         Agent loop, sessions, tools, middleware, orchestration
  mcp/            — @helix/mcp          Model Context Protocol adapter
  storage-sqlite/ — @helix/storage-sqlite  SQLite session persistence + FTS5
  skills/         — @helix/skills       agentskills.io standard + 4-layer security
  memory/         — @helix/memory       4-tier persistent memory with hybrid search
  security/       — @helix/security     Vault + DLP + leak detection
  cli/            — @helix/cli          hlx CLI
  gateway/        — @helixclaw/gateway  Hono REST + WebSocket gateway
  scheduler/      — @helixclaw/scheduler  Autonomous scheduling engine
  safety/         — @helixclaw/safety   Dry-run approvals + rollback
  evals/          — @helix/evals        Evaluation & testing framework
  harness/        — @helix/harness      Replay fixtures + property tests
  ext-*           — @helix/ext-*        Optional extensions

apps/
  dashboard/      — HelixClaw control center (Next.js 15)
```

## Key Improvements Over pi-mono

### 1. Branded Types everywhere

```ts
// pi-mono: string IDs that can be confused
toolCall.id // string — could accidentally pass a model id here

// helix: branded types prevent this class of bug at compile time
import { type ToolCallId, toolCallId } from "@helix/ai";
const id: ToolCallId = toolCallId("call_abc123");
```

### 2. Result<T, E> instead of throw

```ts
// pi-mono: errors thrown, no way to know from signature
const result = await provider.complete(request); // might throw!

// helix: errors are values — handle them explicitly
const result = await provider.complete(request);
if (!result.ok) {
  console.error("Failed:", result.error.message);
  return;
}
console.log(result.value.usage.totalTokens);
```

### 3. Middleware pipeline

```ts
import { Agent } from "@helix/core";
import { withLogging, withBudget, withTimeout } from "@helix/core";

const agent = new Agent({
  provider,
  model: "claude-sonnet-4-5",
  middleware: [
    withLogging({ includeMessages: false }),
    withBudget({ maxCostUsd: 1.00, onExceeded: (cost) => notify(cost) }),
    withTimeout(30_000),
  ],
});
```

### 4. Type-safe tool definitions

```ts
import { defineTool } from "@helix/core";

const searchTool = defineTool({
  name: "search",
  description: "Search the web for current information",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      maxResults: { type: "number", description: "Max results to return" }
    },
    required: ["query"]
  },
  // input is typed as { query: string; maxResults?: number }
  execute: async ({ query, maxResults = 5 }, signal) => {
    const results = await webSearch(query, { maxResults, signal });
    return results;
  },
  // return value is included in context as formatted string
  formatOutput: (results) => results.map(r => `- ${r.title}: ${r.url}`).join("\n")
});
```

### 5. First-class Evals (completely absent from pi-mono)

```ts
import { EvalRunner, EvalSuite, containsMatch, llmJudge } from "@helix/evals";

const suite = {
  name: "coding-agent-basic",
  cases: [
    {
      id: "hello-world",
      input: "Write a hello world function in TypeScript",
      assertions: [
        (output) => output.includes("function") || "Should contain a function",
        (output) => output.includes("Hello") || "Should contain 'Hello'",
      ]
    },
    // ...
  ],
  scorer: containsMatch, // or llmJudge(judgeAgent, "Is the code correct and idiomatic?")
};

const runner = new EvalRunner({
  agentConfig: { provider, model: "claude-haiku-4-5", tools: codingTools },
  onResult: (r) => console.log(`${r.caseId}: ${r.passed ? "✅" : "❌"} (${r.score.value.toFixed(2)})`),
});

const results = await runner.runSuite(suite);
console.log(EvalRunner.formatResult(results));
```

### 6. Pluggable Memory

```ts
import { createMemoryTools, InMemoryStore } from "@helix/core";

const memory = new InMemoryStore();
const agent = new Agent({
  provider,
  model: "claude-sonnet-4-5",
  systemPrompt: "You have access to a persistent memory. Use remember/recall/forget tools.",
  tools: [...codingTools, ...createMemoryTools(memory)],
});

// Agent can now autonomously remember and recall information across turns
```

### 7. Proper Session Management with Forking

```ts
import { SessionManager, FileSessionStorage } from "@helix/core";

const sessions = new SessionManager(new FileSessionStorage("~/.hlx/sessions"));

const session = await sessions.create({ title: "My project", tags: ["typescript"] });
// ... run agent, auto-syncs state ...
await sessions.syncFromAgent(agent.state);

// Fork from any point in history
const fork = await sessions.fork(20); // fork at message 20
```

## Quick Start

### HelixClaw (Ollama)

```bash
ollama serve
bun run launch
# Opens at http://localhost:3001, login token: helixclaw
```

## hlx CLI (reference)

```bash
hlx doctor
hlx init
hlx vault add <name>
hlx vault list
hlx skills search <query>
hlx migrate openclaw
hlx service install
```

## Docker

Copy `.env.example` to `.env` and fill in your values, then:

```bash
docker compose up -d
```

Gateway: `http://localhost:3000`  
Dashboard: `http://localhost:3001`

With Ollama running locally, set:

```bash
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

View logs:

```bash
docker compose logs -f
```

## Contributing

```bash
bun install
bun test
bun run check
```

Open a PR with a clear description of the change and any testing notes.

```ts
import { AnthropicProvider } from "@helix/ai";
import { Agent, codingTools, withLogging } from "@helix/core";

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const agent = new Agent({
  provider,
  model: "claude-sonnet-4-5",
  systemPrompt: "You are a helpful coding assistant.",
  tools: codingTools,
  maxTurns: 20,
  middleware: [withLogging()],
});

const result = await agent.run({
  input: "What files are in the current directory?",
  onEvent: (event) => {
    if (event.type === "stream_event" && event.event.type === "text_delta") {
      process.stdout.write(event.event.delta);
    }
  },
});

if (result.ok) {
  console.log("\n\nDone:", result.value.stopReason);
  console.log("Cost: $" + result.value.state.totalCostUsd.toFixed(6));
}
```

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  Your Application                     │
├────────────────────────────┬─────────────────────────┤
│        @helix/core          │      @helix/evals         │
│  Agent, Session, Tools,    │  EvalRunner, Scorers,    │
│  Memory, Middleware        │  EvalSuite               │
├────────────────────────────┴─────────────────────────┤
│                    @helix/ai                           │
│  Provider interface, types, Anthropic/OpenAI impl    │
└──────────────────────────────────────────────────────┘
```

## Design Principles

1. **Errors are values** — `Result<T, E>` everywhere, no surprise throws
2. **Types prevent bugs** — Branded IDs, discriminated unions, `exactOptionalPropertyTypes`
3. **Composable over monolithic** — Small orthogonal packages, no god objects
4. **Testable by default** — Every component accepts interfaces, not concrete classes
5. **Minimal by default** — No magic, no global state, no hidden behavior
6. **Observable** — Rich event streams for every agent turn

## Development

```bash
bun install          # Install all dependencies
bun run build        # Build all packages
bun run check        # Lint + type check
bun run test         # Run tests
```

## Used By

- [HelixClaw](https://github.com/SteveEmmerich/helix-claw) — autonomous agent product built on Helix ADK

## License

MIT
