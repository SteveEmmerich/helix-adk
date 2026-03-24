import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { MemoryManager } from "../manager.js";
import type { MigrationResult } from "../types.js";

export async function migrateFromOpenClaw(
  openclawDir: string,
  memory: MemoryManager,
  opts: { dryRun?: boolean; confirm?: boolean } = {}
): Promise<MigrationResult> {
  const result: MigrationResult = {
    factsImported: 0,
    episodesImported: 0,
    filesProcessed: 0,
    skipped: [],
    errors: [],
  };

  if (!existsSync(openclawDir)) {
    return { ...result, errors: [`Directory not found: ${openclawDir}`] };
  }

  const memoryMd = join(openclawDir, "MEMORY.md");
  if (existsSync(memoryMd)) {
    const content = readFileSync(memoryMd, "utf-8");
    const facts = content
      .split("\n")
      .filter((line) => line.trim().startsWith("- "))
      .map((line) => line.replace(/^\s*-\s+/, "").trim())
      .filter(Boolean);
    result.filesProcessed += 1;
    if (opts.confirm) {
      for (const fact of facts) {
        const res = await memory.writeFact(fact, { importance: 0.7, source: "openclaw" });
        if (res.ok) result.factsImported += 1;
      }
    } else {
      result.factsImported += facts.length;
    }
  } else {
    result.skipped.push("MEMORY.md");
  }

  const dailyDir = join(openclawDir, "memory");
  if (existsSync(dailyDir)) {
    const files = readdirSync(dailyDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const date = basename(file, ".md");
      const content = readFileSync(join(dailyDir, file), "utf-8");
      const episodes = parseDailyLog(content);
      result.filesProcessed += 1;
      if (opts.confirm) {
        for (const episode of episodes) {
          const res = await memory.writeEpisode(episode.summary, {
            outcome: episode.outcome,
            date,
            importance: 0.7,
            source: "openclaw",
          });
          if (res.ok) result.episodesImported += 1;
        }
      } else {
        result.episodesImported += episodes.length;
      }
    }
  } else {
    result.skipped.push("memory/");
  }

  const soul = join(openclawDir, "SOUL.md");
  if (existsSync(soul) && opts.confirm) {
    const dest = join(homedir(), ".hlx", "SOUL.md");
    try {
      writeFileSync(dest, readFileSync(soul, "utf-8"));
    } catch (e) {
      result.errors.push(`Failed to copy SOUL.md: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const agents = join(openclawDir, "AGENTS.md");
  const repoAgents = join(process.cwd(), "AGENTS.md");
  if (existsSync(agents) && opts.confirm && !existsSync(repoAgents)) {
    try {
      writeFileSync(repoAgents, readFileSync(agents, "utf-8"));
    } catch (e) {
      result.errors.push(`Failed to copy AGENTS.md: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

function parseDailyLog(content: string): Array<{ summary: string; outcome?: string }> {
  const lines = content.split("\n");
  const episodes: Array<{ summary: string; outcome?: string }> = [];
  let current: { summary: string; outcome: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    episodes.push({
      summary: current.summary,
      outcome: current.outcome.join("\n").trim() || undefined,
    });
    current = null;
  };

  for (const line of lines) {
    const heading = line.match(/^#+\s+(.*)$/);
    if (heading) {
      flush();
      current = { summary: heading[1] ?? "", outcome: [] };
      continue;
    }
    if (!current) continue;
    current.outcome.push(line);
  }
  flush();
  return episodes;
}
