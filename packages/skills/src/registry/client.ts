export interface RegistrySkill {
  id: string;
  name: string;
  description: string;
  tier: string;
  version: string;
  downloads?: number;
  updatedAt?: string;
}

export class SkillRegistryClient {
  readonly #baseUrl: string;

  constructor(baseUrl = "https://registry.agentskills.io") {
    this.#baseUrl = baseUrl;
  }

  async search(query: string): Promise<RegistrySkill[]> {
    const res = await fetch(`${this.#baseUrl}/skills?query=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`Registry search failed: ${res.status}`);
    const data = (await res.json()) as { skills: RegistrySkill[] };
    return data.skills ?? [];
  }

  async resolve(id: string): Promise<RegistrySkill> {
    const res = await fetch(`${this.#baseUrl}/skills/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Registry resolve failed: ${res.status}`);
    return (await res.json()) as RegistrySkill;
  }

  async fetchMetadata(id: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.#baseUrl}/skills/${encodeURIComponent(id)}/metadata`);
    if (!res.ok) throw new Error(`Registry metadata failed: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}
