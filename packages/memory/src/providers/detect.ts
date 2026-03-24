import type { EmbeddingProvider, EmbeddingProviderConfig } from "../types.js";
import { GoogleEmbeddingProvider } from "./google.js";
import { NullEmbeddingProvider } from "./null.js";
import { OllamaEmbeddingProvider } from "./ollama.js";
import { OpenAIEmbeddingProvider } from "./openai.js";
import { TransformersEmbeddingProvider } from "./transformers.js";

function isExplicitProvider(provider?: string): boolean {
  return Boolean(provider && provider !== "auto");
}

export async function detectEmbeddingProvider(
  config: EmbeddingProviderConfig
): Promise<EmbeddingProvider> {
  if (config.embeddingProvider) return config.embeddingProvider;

  if (config.provider === "ollama") {
    const p = new OllamaEmbeddingProvider({ baseUrl: config.ollamaBaseUrl });
    if (await p.isAvailable()) return p;
    return new NullEmbeddingProvider();
  }

  if (config.provider === "openai") {
    if (config.apiKey) return new OpenAIEmbeddingProvider({ apiKey: config.apiKey });
    return new NullEmbeddingProvider();
  }

  if (config.provider === "google") {
    if (config.apiKey) return new GoogleEmbeddingProvider({ apiKey: config.apiKey });
    return new NullEmbeddingProvider();
  }

  if (isExplicitProvider(config.provider)) {
    return new NullEmbeddingProvider();
  }

  const ollama = new OllamaEmbeddingProvider({ baseUrl: config.ollamaBaseUrl });
  if (await ollama.isAvailable()) return ollama;

  if (config.apiKey) {
    return new OpenAIEmbeddingProvider({ apiKey: config.apiKey });
  }

  const transformers = new TransformersEmbeddingProvider();
  if (await transformers.isAvailable()) return transformers;

  return new NullEmbeddingProvider();
}
