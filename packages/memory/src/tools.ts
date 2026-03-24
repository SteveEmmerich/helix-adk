import type { ToolDefinition } from "@helix/ai";
import type { MemoryManager } from "./manager.js";
import type { MemorySearchResult, RecallInput, RememberInput } from "./types.js";

export function createMemoryTools(memory: MemoryManager): readonly ToolDefinition[] {
  const rememberTool: ToolDefinition<RememberInput, { ok: boolean; id?: string; error?: string }> =
    {
      name: "remember",
      description:
        "Store important information in long-term memory. " +
        "Use for: user preferences, project facts, lessons learned, how-to procedures, significant events.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Information to store" },
          memoryType: {
            type: "string",
            enum: ["fact", "episode", "procedure"],
            description: "Type of memory",
          },
          importance: { type: "number", description: "Importance (0.0 to 1.0)" },
          title: { type: "string", description: "Title for procedures" },
          outcome: { type: "string", description: "Outcome for episodes" },
        },
        required: ["content", "memoryType", "importance"],
      },
      execute: async (input, _signal) => {
        if (input.memoryType === "fact") {
          const res = await memory.writeFact(input.content, { importance: input.importance });
          return res.ok ? { ok: true, id: res.value } : { ok: false, error: res.error.message };
        }
        if (input.memoryType === "episode") {
          const res = await memory.writeEpisode(input.content, {
            outcome: input.outcome,
            importance: input.importance,
          });
          return res.ok ? { ok: true, id: res.value } : { ok: false, error: res.error.message };
        }
        if (input.memoryType === "procedure") {
          if (!input.title) return { ok: false, error: "title is required for procedure" };
          const res = await memory.writeProcedure(input.title, input.content, {});
          return res.ok ? { ok: true, id: res.value } : { ok: false, error: res.error.message };
        }
        return { ok: false, error: "Unknown memory type" };
      },
    };

  const recallTool: ToolDefinition<RecallInput, MemorySearchResult[]> = {
    name: "recall",
    description:
      "Search long-term memory for relevant information. " +
      "Use when the user references the past or you need context from previous sessions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        memoryTypes: {
          type: "array",
          items: { type: "string", enum: ["fact", "episode", "procedure"] },
          description: "Optional memory types",
        },
        limit: { type: "number", description: "Max results" },
      },
      required: ["query"],
    },
    execute: async ({ query, memoryTypes, limit }, _signal) => {
      const trimmed = query.trim();
      if (!trimmed) return [];
      const allowed = memoryTypes && memoryTypes.length > 0 ? new Set(memoryTypes) : null;
      const cap = limit ?? 5;
      const results: MemorySearchResult[] = [];

      const tokens = trimmed
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2);
      const matchScore = (content: string) => {
        const text = content.toLowerCase();
        let hits = 0;
        for (const token of tokens) {
          if (text.includes(token)) hits += 1;
        }
        return tokens.length > 0 ? hits / tokens.length : 0;
      };
      const scored = <T extends { id: string; content: string; createdAt?: number | null }>(
        list: T[],
        memoryType: MemorySearchResult["memoryType"]
      ) =>
        list
          .map((item) => {
            const score = matchScore(item.content);
            return {
              id: item.id,
              content: item.content,
              memoryType,
              score,
              createdAt: item.createdAt ?? null,
            };
          })
          .filter((item) => item.score > 0);

      const facts = await memory.listFacts();
      const episodes = await memory.listEpisodes();
      const procedures = await memory.listProcedures();

      if (!allowed || allowed.has("fact")) {
        results.push(
          ...scored(
            facts.map((f) => ({ id: f.id, content: f.content, createdAt: f.createdAt })),
            "fact"
          )
        );
      }
      if (!allowed || allowed.has("episode")) {
        results.push(
          ...scored(
            episodes.map((e) => ({
              id: e.id,
              content: `${e.summary}${e.outcome ? ` — ${e.outcome}` : ""}`,
              createdAt: e.createdAt,
            })),
            "episode"
          )
        );
      }
      if (!allowed || allowed.has("procedure")) {
        results.push(
          ...scored(
            procedures.map((p) => ({
              id: p.id,
              content: `${p.title}: ${p.content}`,
              createdAt: p.createdAt,
            })),
            "procedure"
          )
        );
      }

      if (memory.embeddingDimensions() > 0) {
        const tier3 = await memory.search(trimmed, cap);
        for (const item of tier3) {
          if (allowed && !allowed.has(item.memoryType)) continue;
          results.push(item);
        }
      }

      const dedup = new Map<string, MemorySearchResult>();
      for (const item of results) {
        if (!dedup.has(item.id)) dedup.set(item.id, item);
      }
      return Array.from(dedup.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, cap);
    },
  };

  return [rememberTool, recallTool];
}
