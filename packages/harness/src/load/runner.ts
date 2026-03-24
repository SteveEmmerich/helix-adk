#!/usr/bin/env bun
/**
 * Load test runner
 *
 * Simulates production-scale usage against the SQLite storage layer
 * and the agent loop, measuring:
 *
 * 1. Throughput: sessions/sec, messages/sec
 * 2. Latency: p50/p95/p99 per operation
 * 3. Memory: heap growth across 100 sessions (leak detection)
 * 4. Correctness: data integrity after high-volume writes
 *
 * Run with: bun run test:load
 * Typical targets: save p99 < 50ms, 100 sessions in < 5s, no leak > 10MB
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelId, ok, providerId, requestId } from "@helix/ai";
import type { CompletionResponse, ModelInfo, Provider, Session, StreamEvent } from "@helix/ai";
import { Agent, defineTool } from "@helix/core";
import { SqliteSessionStorage } from "@helix/storage-sqlite";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function heapMb(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function stats(samples: number[]): {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: samples.reduce((s, v) => s + v, 0) / samples.length,
  };
}

function makeSession(i: number, messageCount = 10): Session {
  const id = crypto.randomUUID();
  const now = Date.now();
  return {
    parentId: undefined,
    metadata: {
      id,
      title: `Load test session ${i}`,
      tags: ["load-test", i % 2 === 0 ? "even" : "odd"],
      model: "claude-sonnet-4-5",
      workingDirectory: `/tmp/load-test-${i % 5}`,
      createdAt: now,
      updatedAt: now + i,
      messageCount,
      totalCostUsd: i * 0.001,
      totalTokens: i * 100,
    },
    messages: Array.from({ length: messageCount }, (_, j) =>
      j % 2 === 0
        ? {
            role: "user" as const,
            content: `User message ${j} in session ${i} with some realistic content about coding tasks`,
          }
        : {
            role: "assistant" as const,
            content: [
              {
                type: "text" as const,
                text: `Assistant response ${j} — here is the analysis of your code: the function looks correct but could be optimized`,
              },
            ],
          }
    ),
  };
}

function textResponse(text: string): CompletionResponse {
  return {
    id: requestId("r"),
    model: modelId("mock"),
    stopReason: "end_turn",
    message: { role: "assistant", content: [{ type: "text", text }] },
    usage: {
      promptTokens: 50,
      completionTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 70,
    },
    cost: {
      promptCostUsd: 0.0001,
      completionCostUsd: 0.0003,
      cacheReadCostUsd: 0,
      cacheWriteCostUsd: 0,
      totalCostUsd: 0.0004,
    },
    durationMs: 5,
  };
}

function makeFastProvider(): Provider {
  return {
    id: providerId("fast-mock"),
    displayName: "Fast Mock",
    listModels: async () => ok([] as ModelInfo[]),
    complete: async () => ok(textResponse("ok")),
    stream: async () =>
      ok(
        new ReadableStream<StreamEvent>({
          start(ctrl) {
            ctrl.enqueue({ type: "text_delta", delta: "Load test response." });
            ctrl.enqueue({ type: "done", response: textResponse("Load test response.") });
            ctrl.close();
          },
        })
      ),
  };
}

// ─── Test 1: SQLite storage throughput ────────────────────────────────────────

async function testStorageThroughput(sessionCount: number): Promise<void> {
  console.log(`\n  SQLite — ${sessionCount} sessions`);

  const dir = mkdtempSync(join(tmpdir(), "helix-load-"));
  const db = join(dir, "test.db");
  const storage = new SqliteSessionStorage({ path: db });

  const saveTimes: number[] = [];
  const loadTimes: number[] = [];

  const heapBefore = heapMb();
  const wallStart = performance.now();
  const sessionIds: string[] = [];

  // Save phase
  for (let i = 0; i < sessionCount; i++) {
    const session = makeSession(i, 20);
    sessionIds.push(session.metadata.id);

    const t = performance.now();
    await storage.save(session);
    saveTimes.push(performance.now() - t);
  }

  // Load phase (random access)
  for (let i = 0; i < sessionCount; i++) {
    const id = sessionIds[Math.floor(Math.random() * sessionIds.length)];
    if (!id) continue;
    const t = performance.now();
    await storage.load(id);
    loadTimes.push(performance.now() - t);
  }

  const wallMs = performance.now() - wallStart;
  const heapAfter = heapMb();
  const heapGrowthMb = heapAfter - heapBefore;

  const saveStats = stats(saveTimes);
  const loadStats = stats(loadTimes);
  const dbStats = storage.stats();

  console.log(
    `    Save  p50=${saveStats.p50.toFixed(1)}ms  p95=${saveStats.p95.toFixed(1)}ms  p99=${saveStats.p99.toFixed(1)}ms`
  );
  console.log(
    `    Load  p50=${loadStats.p50.toFixed(1)}ms  p95=${loadStats.p95.toFixed(1)}ms  p99=${loadStats.p99.toFixed(1)}ms`
  );
  console.log(
    `    Wall  ${wallMs.toFixed(0)}ms total  (${(sessionCount / (wallMs / 1000)).toFixed(0)} sessions/sec)`
  );
  console.log(
    `    Heap  +${heapGrowthMb.toFixed(1)}MB  DB=${(dbStats.dbSizeBytes / 1024).toFixed(0)}KB`
  );

  // Correctness check
  const allSessions = await storage.list();
  if (allSessions.length !== sessionCount) {
    console.log(
      `    ✗ INTEGRITY FAIL: expected ${sessionCount} sessions, got ${allSessions.length}`
    );
    process.exitCode = 1;
  } else {
    console.log(`    ✓ Integrity OK (${allSessions.length} sessions)`);
  }

  // Leak check — heap growth > 20MB for 100 sessions suggests a leak
  if (heapGrowthMb > 20) {
    console.log(`    ✗ POTENTIAL LEAK: heap grew ${heapGrowthMb.toFixed(1)}MB`);
    process.exitCode = 1;
  }

  // Latency targets
  const saveMissed = saveStats.p99 > 100;
  const loadMissed = loadStats.p99 > 50;
  if (saveMissed) console.log(`    ✗ SLOW: save p99 ${saveStats.p99.toFixed(1)}ms > 100ms target`);
  if (loadMissed) console.log(`    ✗ SLOW: load p99 ${loadStats.p99.toFixed(1)}ms > 50ms target`);
  if (!saveMissed && !loadMissed) console.log("    ✓ Latency targets met");

  storage.close();
  rmSync(dir, { recursive: true, force: true });
}

// ─── Test 2: Agent loop throughput ────────────────────────────────────────────

async function testAgentThroughput(runCount: number): Promise<void> {
  console.log(`\n  Agent loop — ${runCount} runs`);

  const tool = defineTool({
    name: "noop",
    description: "no-op tool",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ ok: true }),
  });

  const provider = makeFastProvider();
  const turnTimes: number[] = [];
  const heapBefore = heapMb();
  const wallStart = performance.now();

  for (let i = 0; i < runCount; i++) {
    const agent = new Agent({ provider, model: modelId("mock"), tools: [tool], maxTurns: 3 });
    const t = performance.now();
    await agent.run({ input: `Run ${i}` });
    turnTimes.push(performance.now() - t);
  }

  const wallMs = performance.now() - wallStart;
  const heapAfter = heapMb();
  const heapGrowth = heapAfter - heapBefore;
  const s = stats(turnTimes);

  console.log(
    `    Run   p50=${s.p50.toFixed(1)}ms  p95=${s.p95.toFixed(1)}ms  p99=${s.p99.toFixed(1)}ms`
  );
  console.log(
    `    Wall  ${wallMs.toFixed(0)}ms  (${(runCount / (wallMs / 1000)).toFixed(0)} runs/sec)`
  );
  console.log(`    Heap  +${heapGrowth.toFixed(1)}MB`);

  if (heapGrowth > 50) {
    console.log(
      `    ✗ POTENTIAL LEAK: heap grew ${heapGrowth.toFixed(1)}MB across ${runCount} runs`
    );
    process.exitCode = 1;
  } else {
    console.log("    ✓ No leak detected");
  }
}

// ─── Test 3: FTS search under load ────────────────────────────────────────────

async function testSearchUnderLoad(): Promise<void> {
  console.log("\n  FTS search under load");

  const dir = mkdtempSync(join(tmpdir(), "helix-load-fts-"));
  const db = join(dir, "fts.db");
  const storage = new SqliteSessionStorage({ path: db });

  // Insert 200 sessions with varied content
  const topics = [
    "TypeScript",
    "Python",
    "Rust",
    "Go",
    "database",
    "networking",
    "machine learning",
    "testing",
  ];
  for (let i = 0; i < 200; i++) {
    const topic = topics[i % topics.length];
    if (!topic) continue;
    await storage.save({
      parentId: undefined,
      metadata: {
        id: crypto.randomUUID(),
        title: `${topic} session ${i}`,
        tags: [topic],
        model: "mock",
        workingDirectory: "/tmp",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 2,
        totalCostUsd: 0,
        totalTokens: 0,
      },
      messages: [
        { role: "user", content: `How do I implement ${topic} in my project?` },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `Here's how to use ${topic}: first you need to understand the fundamentals...`,
            },
          ],
        },
      ],
    });
  }

  const searchTimes: number[] = [];
  for (const topic of topics) {
    const t = performance.now();
    const results = storage.searchMessages(topic);
    searchTimes.push(performance.now() - t);
    if (results.length === 0) {
      console.log(`    ✗ FTS returned 0 results for "${topic}"`);
      process.exitCode = 1;
    }
  }

  const s = stats(searchTimes);
  console.log(`    Search p50=${s.p50.toFixed(1)}ms  p99=${s.p99.toFixed(1)}ms  (200 sessions)`);

  if (s.p99 > 100) {
    console.log(`    ✗ SLOW: search p99 ${s.p99.toFixed(1)}ms > 100ms target`);
    process.exitCode = 1;
  } else {
    console.log("    ✓ FTS latency targets met");
  }

  storage.close();
  rmSync(dir, { recursive: true, force: true });
}

// ─── Run all load tests ───────────────────────────────────────────────────────

console.log("\n  Helix ADK — Load Tests\n");

await testStorageThroughput(100);
await testAgentThroughput(50);
await testSearchUnderLoad();

const code = process.exitCode ?? 0;
console.log(
  `\n  ${code === 0 ? "\x1b[32mAll load tests passed\x1b[0m" : "\x1b[31mSome load tests failed\x1b[0m"}\n`
);
process.exit(code);
