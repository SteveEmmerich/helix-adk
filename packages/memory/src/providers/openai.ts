import { err, ok } from "@helix/ai";
import type { Result } from "@helix/ai";
import type { EmbeddingProvider } from "../types.js";

interface OpenAIEmbeddingConfig {
  readonly apiKey: string;
  readonly model?: "text-embedding-3-small" | "text-embedding-3-large" | string;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai";
  readonly dimensions: number;
  readonly #apiKey: string;
  readonly #model: string;

  constructor(config: OpenAIEmbeddingConfig) {
    this.#apiKey = config.apiKey;
    this.#model = config.model ?? "text-embedding-3-small";
    this.dimensions = this.#model === "text-embedding-3-large" ? 3072 : 1536;
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
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({ model: this.#model, input: texts }),
      });
      if (!res.ok) return err(new Error(`OpenAI embedding failed: ${res.status}`));
      const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
      if (!data.data) return err(new Error("Missing embeddings"));
      return ok(data.data.map((d) => d.embedding));
    } catch (e) {
      return err(e instanceof Error ? e : new Error("OpenAI embedding failed"));
    }
  }
}
