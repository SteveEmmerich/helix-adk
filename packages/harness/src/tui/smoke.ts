#!/usr/bin/env bun
/**
 * TUI smoke test
 *
 * Boots hlx in pipe mode (non-interactive) with a fake provider,
 * asserts clean startup + output, asserts clean exit.
 *
 * This catches Ink/Bun compatibility issues before any user runs the CLI.
 * Run with: bun run smoke:tui
 *
 * Uses a local "stub" server that mimics Anthropic SSE responses
 * so no real API key is needed.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { spawn } from "bun";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const HELIX_BIN = join(REPO_ROOT, "packages", "cli", "src", "bin", "hlx.ts");

// ─── Stub SSE server ──────────────────────────────────────────────────────────

const SIMPLE_RESPONSE = `${[
  `data: {"type":"message_start","message":{"id":"msg_smoke","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Smoke test passed."}}`,
  `data: {"type":"content_block_stop","index":0}`,
  `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}`,
  `data: {"type":"message_stop"}`,
].join("\n\n")}\n\n`;

function startStubServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url?.includes("/v1/messages")) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        res.write(SIMPLE_RESPONSE);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => server.close(),
      });
    });
  });
}

// ─── Test cases ───────────────────────────────────────────────────────────────

interface SmokeResult {
  name: string;
  passed: boolean;
  output: string;
  error?: string;
  exitCode: number;
  durationMs: number;
}

async function runSmoke(
  name: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 10_000
): Promise<SmokeResult> {
  const start = performance.now();

  const proc = spawn({
    cmd: ["bun", "run", HELIX_BIN, ...args],
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  clearTimeout(timer);

  const durationMs = performance.now() - start;
  const output = stdout + stderr;

  return { name, passed: exitCode === 0, output, exitCode, durationMs };
}

// ─── Run all smoke tests ──────────────────────────────────────────────────────

const { port, close } = await startStubServer();
console.log(`\n  Helix TUI Smoke Tests (stub server on :${port})\n`);

const BASE_ENV = {
  ANTHROPIC_API_KEY: "sk-smoke-test",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  NO_COLOR: "1",
  TERM: "dumb",
};

const tests: SmokeResult[] = [];

// 1. --help exits 0 and contains expected text
tests.push(await runSmoke("--help flag", ["--help"], BASE_ENV));
const helpTest = tests.at(-1);
if (helpTest && !helpTest.output.includes("Helix ADK")) {
  helpTest.passed = false;
  helpTest.error = "Expected 'Helix ADK' in --help output";
}

// 2. --version exits 0
tests.push(await runSmoke("--version flag", ["--version"], BASE_ENV));
const versionTest = tests.at(-1);
if (versionTest && !versionTest.output.match(/^\d+\.\d+\.\d+/m)) {
  versionTest.passed = false;
  versionTest.error = "Expected semver in --version output";
}

// 3. Single-turn pipe mode (most important smoke test)
tests.push(await runSmoke("single-turn pipe mode", ["--no-picker", "Say hello"], BASE_ENV, 15_000));
const pipeTest = tests.at(-1);
if (pipeTest && !pipeTest.output.includes("Smoke test passed")) {
  pipeTest.passed = false;
  pipeTest.error = `Expected 'Smoke test passed' in output. Got: ${pipeTest.output.slice(0, 200)}`;
}

// 4. Missing API key exits non-zero with helpful error
tests.push(
  await runSmoke("missing API key", ["--no-picker", "hello"], {
    ...BASE_ENV,
    ANTHROPIC_API_KEY: "",
  })
);
const missingKeyTest = tests.at(-1);
if (missingKeyTest) {
  missingKeyTest.passed =
    missingKeyTest.exitCode !== 0 && missingKeyTest.output.includes("ANTHROPIC_API_KEY");
  if (!missingKeyTest.passed) {
    missingKeyTest.error = "Expected non-zero exit + key name in output for missing API key";
  }
}

// 5. Unknown model flag doesn't crash (graceful error)
tests.push(
  await runSmoke(
    "unknown model flag",
    ["--no-picker", "--model", "not-a-real-model", "hello"],
    BASE_ENV,
    10_000
  )
);
// This might succeed (if the stub responds to any model) or fail — just not panic
const unknownModelTest = tests.at(-1);
if (unknownModelTest) {
  unknownModelTest.passed =
    !unknownModelTest.output.includes("panic") &&
    !unknownModelTest.output.includes("unhandledRejection");
}

// ─── Report ───────────────────────────────────────────────────────────────────

close();

let allPassed = true;
for (const test of tests) {
  const icon = test.passed ? "✓" : "✗";
  const color = test.passed ? "\x1b[32m" : "\x1b[31m";
  const reset = "\x1b[0m";
  console.log(`  ${color}${icon}${reset} ${test.name} (${test.durationMs.toFixed(0)}ms)`);
  if (!test.passed) {
    console.log(`      Exit code: ${test.exitCode}`);
    if (test.error) console.log(`      Error: ${test.error}`);
    if (test.output) console.log(`      Output: ${test.output.slice(0, 300)}`);
    allPassed = false;
  }
}

console.log();
if (allPassed) {
  console.log("  \x1b[32mAll smoke tests passed\x1b[0m\n");
  process.exit(0);
} else {
  const failed = tests.filter((t) => !t.passed).length;
  console.log(`  \x1b[31m${failed}/${tests.length} smoke tests failed\x1b[0m\n`);
  process.exit(1);
}
