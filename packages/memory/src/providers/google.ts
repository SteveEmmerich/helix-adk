import { err, ok } from "@helix/ai";
import type { Result } from "@helix/ai";
import type { EmbeddingProvider } from "../types.js";

interface GoogleEmbeddingConfig {
  readonly apiKey: string;
  readonly model?: "text-embedding-004" | string;
}

export class GoogleEmbeddingProvider implements EmbeddingProvider {
  readonly id = "google";
  readonly dimensions: number = 768;
  readonly #apiKey: string;
  readonly #model: string;

  constructor(config: GoogleEmbeddingConfig) {
    this.#apiKey = config.apiKey;
    this.#model = config.model ?? "text-embedding-004";
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.#apiKey);
  }

  async embed(text: string): Promise<Result<number[]>> {
    const res = await this.embedBatch([text]);
    if (!res.ok) return res as Result<number[]>;
    const first = res.value[0];
    if (!first) return err(new Error("Embedding unavailable"));
    return ok(first);
  }

  async embedBatch(texts: string[]): Promise<Result<number[][]>> {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.#model}:embedContent?key=${this.#apiKey}`;
      const results: number[][] = [];
      for (const text of texts) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: { parts: [{ text }] } }),
        });
        if (!res.ok) return err(new Error(`Google embedding failed: ${res.status}`));
        const data = (await res.json()) as { embedding?: { values?: number[] } };
        const values = data.embedding?.values;
        if (!values) return err(new Error("Missing embeddings"));
        results.push(values);
      }
      return ok(results);
    } catch (e) {
      return err(e instanceof Error ? e : new Error("Google embedding failed"));
    }
  }
}
