# AGENTS.md — Helix ADK

## Project Overview
Helix ADK is a TypeScript monorepo — an agent development kit (library) plus HelixClaw (a proof-of-concept autonomous agent product built on it).

## Monorepo Structure
packages/ai          @helix/ai — provider abstraction (Anthropic/OpenAI/Google/Ollama)
packages/core        @helix/core — agent loop, tools, middleware, orchestration
packages/mcp         @helix/mcp — Model Context Protocol adapter
packages/storage-sqlite  @helix/storage-sqlite — SQLite session persistence
packages/skills      @helix/skills — agentskills.io standard, 4-layer security
packages/cli         @helix/cli — hlx CLI
packages/gateway     @helixclaw/gateway — Hono REST+WebSocket, transport architecture
packages/scheduler   @helixclaw/scheduler — autonomous agent waking
packages/safety      @helixclaw/safety — dry-run approval gates
apps/dashboard       Next.js 15 control center

## Runtime
Bun only. Never use Node.js APIs. Use:
  bun:sqlite not better-sqlite3
  bun test not vitest or jest
  Bun.spawn not child_process
  Bun.file not fs.readFile

## Commands
  bun install          Install all dependencies
  bun test             Run all tests (expect 139+ passing)
  bun run check        Biome lint/format check
  bun run launch       Start gateway + dashboard
  bun run hlx          Run hlx CLI

## Key Architectural Decisions
- Result<T,E> pattern everywhere — never throw for recoverable errors
- ReadableStream<StreamEvent> for streaming — never callbacks
- Branded types: ModelId, ToolCallId, RequestId (never plain strings)
- Transport pattern in gateway: RestTransport/WebSocketTransport implement Transport interface
- Skills are model-driven via [skill:id] activation in assistant responses
- Safety layer wraps tools transparently — never modifies agent loop internals
- All SQLite uses bun:sqlite — no WAL issues, positional params only

## TypeScript Standards
- strict mode always
- exactOptionalPropertyTypes: true
- noUncheckedIndexedAccess: true
- verbatimModuleSyntax: true
- No @ts-ignore or any types in production code
- All exported functions must have explicit return types

## Testing Standards
- bun test for all tests
- Property-based tests use fast-check
- E2E gateway tests use in-memory Hono fetch (not real ports)
- Never skip tests — if port binding needed, use in-memory mock instead
- Tests for Result<T,E>: always test both ok and err paths

## Adding a New Transport
Create packages/gateway/src/transports/your-transport.ts implementing Transport:
  readonly id: string
  start(bridge: AgentBridge): Promise<void>
  stop(): Promise<void>
Register with server.use(new YourTransport())
No other files need to change.

## Adding a New Provider
Create packages/ai/src/providers/your-provider.ts implementing Provider:
  id: ProviderId
  complete(): Promise<Result<CompletionResponse>>
  stream(): Promise<Result<ReadableStream<StreamEvent>>>
Export from packages/ai/src/index.ts

## Security Model for Skills
Layer 1: Sigstore provenance
Layer 2: Static AST analysis (@babel/parser)
Layer 3: WASM sandbox (wasmtime CLI, subprocess fallback)
Layer 4: Trust tiers CORE/VERIFIED/COMMUNITY/UNVERIFIED
Never bypass the tier check. Never skip static analysis for non-CORE skills.

## Common Gotchas
- Bun WebSocket: upgrade must happen BEFORE app.fetch() — see transports/websocket.ts
- bun:sqlite: use positional params ($1, $2) not named (:name)
- Next.js env vars need NEXT_PUBLIC_ prefix to reach the browser
- Skills system prompt injection happens in agent.ts before main system prompt
- SafetyLayer.wrapAll() must be called AFTER tools are defined, not before
