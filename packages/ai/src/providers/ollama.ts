/**
 * Ollama provider for @helix/ai (OpenAI-compatible API)
 */

import type {
  CompletionRequest,
  CompletionResponse,
  ModelInfo,
  Provider,
  ProviderId,
  Result,
  StreamEvent,
} from "../types/index.js";
import { modelId, ok, providerId } from "../types/index.js";
import { OpenAIProvider } from "./openai.js";

const PROVIDER_ID: ProviderId = providerId("ollama");

const DEFAULT_MODEL = "kimi-k2.5:cloud";

function normalizeBaseUrl(input: string): string {
  if (input.endsWith("/v1")) return input;
  return `${input.replace(/\/$/, "")}/v1`;
}

export interface OllamaConfig {
  readonly baseUrl?: string;
  readonly model?: string;
}

export class OllamaProvider implements Provider {
  readonly id = PROVIDER_ID;
  readonly displayName = "Ollama";

  readonly #inner: OpenAIProvider;
  readonly #models: readonly ModelInfo[];

  constructor(config: OllamaConfig = {}) {
    const baseUrl = normalizeBaseUrl(
      config.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"
    );
    const model = config.model ?? DEFAULT_MODEL;

    this.#models = [
      {
        id: modelId(model),
        provider: PROVIDER_ID,
        displayName: model,
        capabilities: {
          vision: false,
          toolCalling: true,
          parallelToolCalling: false,
          streaming: true,
          extendedThinking: false,
          jsonMode: true,
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
        },
        pricing: { promptPer1MTokens: 0, completionPer1MTokens: 0 },
      },
    ];

    this.#inner = new OpenAIProvider({
      apiKey: "ollama",
      baseUrl,
      extraModels: this.#models,
    });
  }

  async listModels(): Promise<Result<readonly ModelInfo[]>> {
    return ok(this.#models);
  }

  async complete(request: CompletionRequest): Promise<Result<CompletionResponse>> {
    const result = await this.#inner.complete(request);
    if (result.ok || !request.tools?.length) return result;

    // Graceful fallback: retry without tools if the backend rejects tool calling.
    const retry: CompletionRequest = {
      ...request,
      tools: undefined,
      toolChoice: "none",
    };
    return this.#inner.complete(retry);
  }

  async stream(request: CompletionRequest): Promise<Result<ReadableStream<StreamEvent>>> {
    const result = await this.#inner.stream(request);
    if (result.ok || !request.tools?.length) return result;

    const retry: CompletionRequest = {
      ...request,
      tools: undefined,
      toolChoice: "none",
    };
    return this.#inner.stream(retry);
  }
}
