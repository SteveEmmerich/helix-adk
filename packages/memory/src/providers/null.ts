import { err } from "@helix/ai";
import type { Result } from "@helix/ai";
import type { EmbeddingProvider } from "../types.js";

let warned = false;

export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly id = "null";
  readonly dimensions = 0;

  async embed(): Promise<Result<number[]>> {
    this.#warnOnce();
    return err(new Error("Embedding unavailable"));
  }

  async embedBatch(): Promise<Result<number[][]>> {
    this.#warnOnce();
    return err(new Error("Embedding unavailable"));
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }

  #warnOnce(): void {
    if (warned) return;
    warned = true;
    console.warn(
      "[memory] No embedding provider available.\n" +
        "Tier 3 semantic search disabled.\n" +
        "Install Ollama and pull nomic-embed-text for full capabilities:\n" +
        "  ollama pull nomic-embed-text"
    );
  }
}
