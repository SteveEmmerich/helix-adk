/**
 * @helix/harness — Stress test harness for Helix ADK
 *
 * Test suite layout:
 *
 *   src/fixtures/      Raw SSE fixtures from real API calls
 *     sse.ts           14 fixtures across Anthropic, OpenAI, Google
 *     replay.ts        Turns fixture lines into fake fetch Responses
 *     record.ts        Script to record new fixtures from live APIs
 *
 *   src/providers/     SSE parser tests — runs every fixture through real code
 *     replay.test.ts   30+ tests, zero API calls, catches parsing regressions
 *
 *   src/agent/         Agent loop correctness via property-based testing
 *     properties.test.ts   8 properties, ~150 fast-check cases
 *
 *   src/sqlite/        Storage layer correctness and performance
 *     storage.test.ts  30+ tests: CRUD, fork, concurrency, FTS, large sessions
 *
 *   src/tui/           CLI smoke tests
 *     smoke.ts         5 smoke tests against a local stub server
 *
 *   src/load/          Throughput and leak detection
 *     runner.ts        100-session storage test, 50-run agent test, FTS under load
 *
 * Running the full suite:
 *   bun test                          # unit tests only (fast, no API)
 *   bun run smoke:tui                 # boots hlx, checks output
 *   bun run test:load                 # throughput + leak detection
 *   ANTHROPIC_API_KEY=... bun run fixtures:record  # refresh fixtures from live API
 *
 * CI recommendation:
 *   - bun test on every PR (< 10 seconds)
 *   - bun run smoke:tui + test:load nightly
 *   - bun run fixtures:record weekly or before a release
 */

export * from "./fixtures/sse.js";
export * from "./fixtures/replay.js";
