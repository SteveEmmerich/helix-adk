import { err, ok } from "@helix/ai";
import type { Result } from "@helix/ai";
import type { EmbeddingProvider } from "../types.js";

interface OllamaEmbeddingConfig {
  readonly baseUrl?: string;
  readonly model?: string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = "ollama";
  readonly dimensions: number;
  readonly #baseUrl: string;
  readonly #model: string;

  constructor(config: OllamaEmbeddingConfig = {}) {
    this.#baseUrl = config.baseUrl ?? "http://localhost:11434";
    this.#model = config.model ?? "nomic-embed-text";
    this.dimensions = 384;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.#baseUrl}/api/tags`);
      if (!res.ok) return false;
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      return Boolean(data.models?.some((m) => m.name === this.#model));
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<Result<number[]>> {
    return this.#embedInternal([text]).then((r) => {
      if (!r.ok) return r;
      const first = r.value[0];
      if (!first) return err(new Error("Embedding unavailable"));
      return ok(first);
    });
  }

  async embedBatch(texts: string[]): Promise<Result<number[][]>> {
    return this.#embedInternal(texts);
  }

  async #embedInternal(texts: string[]): Promise<Result<number[][]>> {
    try {
      const results: number[][] = [];
      for (const text of texts) {
        const res = await fetch(`${this.#baseUrl}/api/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.#model, prompt: text }),
        });
        if (!res.ok) {
          return err(new Error(`Ollama embedding failed: ${res.status}`));
        }
        const data = (await res.json()) as { embedding?: number[] };
        if (!data.embedding) return err(new Error("Missing embedding"));
        results.push(data.embedding);
      }
      return ok(results);
    } catch (e) {
      return err(e instanceof Error ? e : new Error("Ollama embedding failed"));
    }
  }
}
