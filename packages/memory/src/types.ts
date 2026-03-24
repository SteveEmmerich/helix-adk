import type { Result } from "@helix/ai";

export type MemoryFactCategory = "person" | "preference" | "project" | "rule" | "fact";

export interface MemoryFact {
  readonly id: string;
  readonly content: string;
  readonly category: MemoryFactCategory;
  readonly hotScore: number;
  readonly importance: number;
  readonly source: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastAccessed?: number | null;
}

export interface MemoryEpisode {
  readonly id: string;
  readonly summary: string;
  readonly outcome?: string | null;
  readonly sessionId?: string | null;
  readonly date: string; // YYYY-MM-DD
  readonly importance: number;
  readonly tags: readonly string[];
  readonly channel?: string | null;
  readonly createdAt: number;
}

export interface MemoryProcedure {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly context?: string | null;
  readonly usageCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MemorySearchResult {
  readonly id: string;
  readonly content: string;
  readonly memoryType: "fact" | "episode" | "procedure" | "knowledge";
  readonly source?: string | null;
  readonly score: number;
  readonly createdAt?: number | null;
}

export interface MemoryStats {
  readonly facts: number;
  readonly factHot: number;
  readonly episodes: number;
  readonly episodesRecent: number;
  readonly procedures: number;
  readonly knowledge: number;
  readonly providerId: string;
  readonly dimensions: number;
  readonly dbPath: string;
  readonly dbSizeKb: number;
}

export interface MemoryContext {
  readonly facts: string[];
  readonly recentEpisodes: string[];
  readonly procedures: string[];
  readonly searchResults?: string[];
}

export interface MemoryConfig {
  readonly dbPath?: string;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly tier1Limit?: number;
  readonly tier2Days?: number;
  readonly tier3Threshold?: number;
  readonly decayIntervalDays?: number;
  readonly poisoningProtection?: boolean;
  readonly provider?: "ollama" | "openai" | "google" | string;
  readonly ollamaBaseUrl?: string;
  readonly apiKey?: string | null;
}

export interface MemoryLoadOptions {
  readonly channel?: "telegram" | "dashboard" | "scheduler" | string;
  readonly sessionId?: string;
  readonly includeSearch?: string;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(text: string): Promise<Result<number[]>>;
  embedBatch(texts: string[]): Promise<Result<number[][]>>;
  isAvailable(): Promise<boolean>;
}

export interface MigrationResult {
  readonly factsImported: number;
  readonly episodesImported: number;
  readonly filesProcessed: number;
  readonly skipped: readonly string[];
  readonly errors: readonly string[];
}

export interface HeartbeatSchedule {
  readonly prompt: string;
  readonly interval?: number;
  readonly cron?: string;
  readonly description: string;
}

export interface ProtectionResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface InstallAuditEntry {
  readonly id: string;
  readonly contentHash: string;
  readonly action: string;
  readonly source: string;
  readonly result: "allowed" | "blocked";
  readonly reason?: string | null;
  readonly createdAt: number;
}

export interface RememberInput {
  readonly content: string;
  readonly memoryType: "fact" | "episode" | "procedure";
  readonly importance: number;
  readonly title?: string;
  readonly outcome?: string;
}

export interface RecallInput {
  readonly query: string;
  readonly memoryTypes?: Array<"fact" | "episode" | "procedure">;
  readonly limit?: number;
}

export interface EmbeddingProviderConfig {
  readonly provider?: "ollama" | "openai" | "google" | string;
  readonly ollamaBaseUrl?: string;
  readonly apiKey?: string | null;
  readonly embeddingProvider?: EmbeddingProvider;
}

export interface MemoryManagerLike {
  init(): Promise<void>;
}

export type MemoryWriteResult = Result<string>;

export type MemorySearchResponse = Result<MemorySearchResult[]>;

export type MemoryLoadResponse = Result<MemoryContext>;

export type MemoryProviderResult = Result<EmbeddingProvider>;
