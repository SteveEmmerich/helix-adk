# Changelog

## 0.1.0 — Initial POC release

### Helix ADK
- @helix/ai: Anthropic, OpenAI, Google, Ollama providers
- @helix/core: agent loop, tools, middleware, orchestration,
  research phase, memory integration
- @helix/skills: agentskills.io standard, 4-layer security
  (Sigstore, AST analysis, WASM sandbox, trust tiers)
- @helix/memory: 4-tier memory (semantic facts, episodic,
  deep knowledge with hybrid search, procedural)
- @helix/security: credential vault (AES-256-GCM), DLP,
  leak detection with per-tool allowlists
- @helix/mcp: Model Context Protocol adapter
- @helix/storage-sqlite: session persistence with FTS5
- @helix/cli: hlx CLI — skills, vault, migrate, doctor,
  service, init

### HelixClaw
- @helixclaw/gateway: Hono REST + WebSocket, pluggable
  transports, config hot-reload, session queue
- @helixclaw/scheduler: cron/interval/event/window,
  HEARTBEAT.md driven, skip-on-overlap
- @helixclaw/safety: dry-run approval gates, rollback,
  WebhookNotifier
- apps/dashboard: Next.js 15 control center — chat,
  approvals, scheduler, sessions, skills, memory,
  security vault, system health

### Transports
- REST (NDJSON streaming)
- WebSocket (real-time bidirectional)
- Telegram (grammy, approval buttons)
- Discord (discord.js, slash commands, approval buttons)

### Infrastructure
- GitHub Actions CI (bun test + Playwright)
- Codecov coverage
- Docker + docker-compose
- Cloudflare/ngrok tunnel support
- launchd/systemd service installer
- SOUL.md, AGENTS.md, HEARTBEAT.md identity files
- OpenClaw memory migration
- 215 tests passing
