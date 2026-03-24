#!/usr/bin/env bun
/**
 * Fixture recorder — hits real APIs and saves raw SSE streams.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun run fixtures:record
 *   bun run fixtures:record -- --provider openai
 *
 * Outputs TypeScript you paste into sse.ts.
 * Run when the API format changes or you need new scenarios.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const providerArg = args[args.indexOf("--provider") + 1] ?? "all";

interface RecordedFixture {
  provider: string;
  scenario: string;
  lines: string[];
}

async function readSse(res: Response): Promise<string[]> {
  const lines: string[] = [];
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      if (line.trim()) lines.push(line.trim());
    }
  }
  return lines;
}

async function recordAnthropic(): Promise<RecordedFixture[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.log("Skipping Anthropic — no ANTHROPIC_API_KEY");
    return [];
  }
  const fixtures: RecordedFixture[] = [];
  for (const scenario of [
    {
      name: "simple-text",
      body: {
        model: "claude-sonnet-4-5",
        max_tokens: 50,
        stream: true,
        messages: [{ role: "user", content: "Say hello in 5 words." }],
      },
    },
    {
      name: "tool-call",
      body: {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: true,
        tools: [
          {
            name: "bash",
            description: "Run bash",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
        messages: [{ role: "user", content: "Run ls -la." }],
      },
    },
  ]) {
    console.log(`Recording anthropic/${scenario.name}...`);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(scenario.body),
    });
    if (!res.ok) {
      console.error(`  Failed: ${res.status} ${await res.text()}`);
      continue;
    }
    const lines = await readSse(res);
    fixtures.push({ provider: "anthropic", scenario: scenario.name, lines });
    console.log(`  Captured ${lines.length} lines`);
  }
  return fixtures;
}

async function recordOpenAI(): Promise<RecordedFixture[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.log("Skipping OpenAI — no OPENAI_API_KEY");
    return [];
  }
  const fixtures: RecordedFixture[] = [];
  for (const scenario of [
    {
      name: "simple-text",
      body: {
        model: "gpt-4o-mini",
        max_tokens: 50,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "Say hello in 5 words." }],
      },
    },
  ]) {
    console.log(`Recording openai/${scenario.name}...`);
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(scenario.body),
    });
    if (!res.ok) {
      console.error(`  Failed: ${res.status}`);
      continue;
    }
    const lines = await readSse(res);
    fixtures.push({ provider: "openai", scenario: scenario.name, lines });
    console.log(`  Captured ${lines.length} lines`);
  }
  return fixtures;
}

const all: RecordedFixture[] = [];
if (providerArg === "all" || providerArg === "anthropic") all.push(...(await recordAnthropic()));
if (providerArg === "all" || providerArg === "openai") all.push(...(await recordOpenAI()));

if (all.length === 0) {
  console.log("No fixtures recorded.");
  process.exit(0);
}

const ts = all
  .map(
    (f) => `
// Recorded: ${new Date().toISOString()}
export const ${f.provider}_${f.scenario.replace(/-/g, "_")}_live: SseFixture = {
  name: "${f.provider}/${f.scenario}",
  provider: "${f.provider}" as const,
  scenario: "FILL IN",
  lines: [
${f.lines.map((l) => `    ${JSON.stringify(l)},`).join("\n")}
  ],
  expected: { stopReason: "end_turn", hasUsage: true }, // FILL IN
};`
  )
  .join("\n");

const outPath = join(import.meta.dir, "recorded.ts");
await writeFile(outPath, `import type { SseFixture } from "./sse.js";\n${ts}\n`);
console.log(`\nWrote ${all.length} fixtures to ${outPath}`);
