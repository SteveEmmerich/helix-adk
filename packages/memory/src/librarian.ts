import { modelId } from "@helix/ai";
import type { Message, Provider } from "@helix/ai";
import type { MemoryManager } from "./manager.js";

interface LibrarianEntryFact {
  content: string;
  category?: string;
  importance?: number;
}

interface LibrarianEntryEpisode {
  summary: string;
  outcome?: string;
  importance?: number;
  tags?: string[];
}

interface LibrarianEntryProcedure {
  title: string;
  content: string;
  context?: string;
}

interface ExtractionResult {
  facts?: LibrarianEntryFact[];
  episodes?: LibrarianEntryEpisode[];
  procedures?: LibrarianEntryProcedure[];
}

export class LibrarianSkill {
  readonly #memory: MemoryManager;
  readonly #provider: Provider;
  readonly #model: string;

  constructor(memory: MemoryManager, provider: Provider, model: string) {
    this.#memory = memory;
    this.#provider = provider;
    this.#model = model;
  }

  async processSession(sessionId: string, messages: readonly Message[]): Promise<void> {
    if (messages.length < 3) return;
    const recent = messages.slice(-20).map(formatMessage).join("\n");
    const prompt = `Extract from this conversation in JSON:\n{
  "facts": [{"content": "...", "category": "preference|project|rule|fact|person", "importance": 0.5}],
  "episodes": [{"summary": "...", "outcome": "...", "importance": 0.5, "tags": ["..."]}],
  "procedures": [{"title": "...", "content": "...", "context": "..."}]
}\nOnly extract genuinely new or important information.\nFacts: user preferences, project details, rules learned.\nEpisodes: what happened and the outcome.\nProcedures: repeatable patterns, how-to knowledge.\n\nConversation:\n${recent}`;

    const result = await this.#provider.complete({
      model: modelId(this.#model),
      messages: [{ role: "user", content: prompt }],
    });

    if (!result.ok) return;

    const content = extractAssistantText(result.value.message.content);
    const json = extractJson(content);
    if (!json) return;

    let data: ExtractionResult | null = null;
    try {
      data = JSON.parse(json) as ExtractionResult;
    } catch {
      return;
    }

    let factCount = 0;
    let episodeCount = 0;
    let procedureCount = 0;

    for (const fact of data.facts ?? []) {
      const res = await this.#memory.writeFact(fact.content, {
        category: coerceCategory(fact.category),
        importance: fact.importance ?? 0.5,
        source: sessionId,
      });
      if (res.ok) factCount += 1;
    }

    for (const episode of data.episodes ?? []) {
      const res = await this.#memory.writeEpisode(episode.summary, {
        outcome: episode.outcome,
        importance: episode.importance ?? 0.5,
        tags: episode.tags ?? [],
        sessionId,
      });
      if (res.ok) episodeCount += 1;
    }

    for (const proc of data.procedures ?? []) {
      const res = await this.#memory.writeProcedure(proc.title, proc.content, {
        context: proc.context,
        source: sessionId,
      });
      if (res.ok) procedureCount += 1;
    }

    await this.#memory.decay();
    console.log(
      `[memory] Session ${sessionId}: +${factCount} facts, +${episodeCount} episodes, +${procedureCount} procedures`
    );
  }
}

function formatMessage(message: Message): string {
  if (message.role === "user") return `User: ${stringifyContent(message.content)}`;
  if (message.role === "assistant") return `Assistant: ${extractAssistantText(message.content)}`;
  if (message.role === "system") return `System: ${message.content}`;
  if (message.role === "tool") return "Tool result";
  return "";
}

function stringifyContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "document") return part.text;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function extractAssistantText(content: Message["content"]): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("");
}

function extractJson(text: string): string | null {
  const fenced = text.match(/```json\n([\s\S]*?)```/i);
  if (fenced) return fenced[1]?.trim() ?? null;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return null;
}

function coerceCategory(
  value: string | undefined
): "person" | "preference" | "project" | "rule" | "fact" {
  if (!value) return "fact";
  const normalized = value.toLowerCase();
  if (normalized === "person") return "person";
  if (normalized === "preference") return "preference";
  if (normalized === "project") return "project";
  if (normalized === "rule") return "rule";
  return "fact";
}
