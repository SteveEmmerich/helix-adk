import { homedir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@helix/ai";
import type { Result } from "@helix/ai";
import type { EmbeddingProvider } from "../types.js";

interface TransformersConfig {
  readonly model?: string;
}

type PipelineFn = (
  task: string,
  model: string,
  options?: Record<string, unknown>
) => Promise<unknown>;

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly id = "transformers";
  readonly dimensions = 384;
  readonly #model: string;
  #pipelinePromise: Promise<unknown> | null = null;

  constructor(config: TransformersConfig = {}) {
    this.#model = config.model ?? "Xenova/all-MiniLM-L6-v2";
    if (!process.env.TRANSFORMERS_CACHE) {
      process.env.TRANSFORMERS_CACHE = join(homedir(), ".hlx", "models");
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await import("@xenova/transformers");
      return true;
    } catch {
      return false;
    }
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
      const pipeline = (await this.#getPipeline()) as (
        input: string,
        opts: Record<string, unknown>
      ) => Promise<unknown>;
      const embeddings: number[][] = [];
      for (const text of texts) {
        const output = await pipeline(text, { pooling: "mean", normalize: true });
        const vector = extractVector(output);
        if (!vector) return err(new Error("Embedding unavailable"));
        embeddings.push(vector);
      }
      return ok(embeddings);
    } catch (e) {
      return err(e instanceof Error ? e : new Error("Transformers embedding failed"));
    }
  }

  async #getPipeline(): Promise<unknown> {
    if (!this.#pipelinePromise) {
      this.#pipelinePromise = (async () => {
        const mod = (await import("@xenova/transformers")) as { pipeline: PipelineFn };
        return mod.pipeline("feature-extraction", this.#model, {
          quantized: true,
        });
      })();
    }
    return this.#pipelinePromise;
  }
}

function extractVector(output: unknown): number[] | null {
  if (Array.isArray(output)) return output as number[];
  if (typeof output === "object" && output !== null) {
    const data = (output as { data?: unknown }).data;
    if (Array.isArray(data)) return data as number[];
  }
  return null;
}
