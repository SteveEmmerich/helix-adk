import type { ModelId, ModelInfo, Provider, ProviderId, ProviderRegistry } from "../types/index.js";

export class DefaultProviderRegistry implements ProviderRegistry {
  readonly #providers: Map<ProviderId, Provider> = new Map();
  // Lazily populated model cache
  readonly #modelCache: Map<ModelId, { provider: Provider; model: ModelInfo }> = new Map();

  register(provider: Provider): void {
    this.#providers.set(provider.id, provider);
    // Invalidate cache for this provider
    for (const [key, val] of this.#modelCache) {
      if (val.provider.id === provider.id) this.#modelCache.delete(key);
    }
  }

  get(id: ProviderId): Provider | undefined {
    return this.#providers.get(id);
  }

  getAll(): readonly Provider[] {
    return Array.from(this.#providers.values());
  }

  resolveModel(modelId: ModelId): { provider: Provider; model: ModelInfo } | undefined {
    return this.#modelCache.get(modelId);
  }

  /** Eagerly populate the model cache from all registered providers */
  async refresh(): Promise<void> {
    for (const provider of this.#providers.values()) {
      const result = await provider.listModels();
      if (!result.ok) continue;
      for (const model of result.value) {
        this.#modelCache.set(model.id, { provider, model });
      }
    }
  }
}

/** Global singleton registry */
export const registry = new DefaultProviderRegistry();
