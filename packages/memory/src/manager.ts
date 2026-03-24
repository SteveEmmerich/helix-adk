import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { err, ok } from "@helix/ai";
import type { Result } from "@helix/ai";
import { migrateEmbeddingDimensions } from "./migration.js";
import { checkPoisoning, hashContent } from "./protection.js";
import { combineHybridResults, cosineSimilarity, normalizeScores } from "./search.js";
import { type VecMode, createVecTable, getVecTableKind, tryLoadSqliteVec } from "./tiers/tier3.js";
import type {
  EmbeddingProvider,
  MemoryConfig,
  MemoryContext,
  MemoryEpisode,
  MemoryFact,
  MemoryFactCategory,
  MemoryLoadOptions,
  MemoryProcedure,
  MemorySearchResult,
  MemoryStats,
} from "./types.js";

interface KnowledgeRow {
  rowid: number;
  id: string;
  content: string;
  memory_type: "fact" | "episode";
  original_id: string | null;
  source: string | null;
  importance: number;
  created_at: number;
}

interface VecRow {
  id: string;
  embedding: string;
}

interface FactRow {
  id: string;
  content: string;
  category: MemoryFactCategory;
  hot_score: number;
  importance: number;
  source: string;
  created_at: number;
  updated_at: number;
  last_accessed: number | null;
}

interface EpisodeRow {
  id: string;
  summary: string;
  outcome: string | null;
  session_id: string | null;
  date: string;
  importance: number;
  tags: string | null;
  channel: string | null;
  created_at: number;
}

interface ProcedureRow {
  id: string;
  title: string;
  content: string;
  context: string | null;
  usage_count: number;
  created_at: number;
  updated_at: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_facts (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    hot_score REAL NOT NULL DEFAULT 1.0,
    importance REAL NOT NULL DEFAULT 0.5,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_accessed INTEGER
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts
    USING fts5(content, content='memory_facts', content_rowid='rowid');

  CREATE TRIGGER IF NOT EXISTS memory_facts_ai AFTER INSERT ON memory_facts BEGIN
    INSERT INTO memory_facts_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS memory_facts_ad AFTER DELETE ON memory_facts BEGIN
    INSERT INTO memory_facts_fts(memory_facts_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS memory_facts_au AFTER UPDATE ON memory_facts BEGIN
    INSERT INTO memory_facts_fts(memory_facts_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO memory_facts_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TABLE IF NOT EXISTS memory_episodes (
    id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    outcome TEXT,
    session_id TEXT,
    date TEXT NOT NULL,
    importance REAL DEFAULT 0.5,
    tags TEXT DEFAULT '[]',
    channel TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_episodes_fts
    USING fts5(summary, outcome, content='memory_episodes', content_rowid='rowid');

  CREATE TRIGGER IF NOT EXISTS memory_episodes_ai AFTER INSERT ON memory_episodes BEGIN
    INSERT INTO memory_episodes_fts(rowid, summary, outcome) VALUES (new.rowid, new.summary, new.outcome);
  END;
  CREATE TRIGGER IF NOT EXISTS memory_episodes_ad AFTER DELETE ON memory_episodes BEGIN
    INSERT INTO memory_episodes_fts(memory_episodes_fts, rowid, summary, outcome)
    VALUES ('delete', old.rowid, old.summary, old.outcome);
  END;
  CREATE TRIGGER IF NOT EXISTS memory_episodes_au AFTER UPDATE ON memory_episodes BEGIN
    INSERT INTO memory_episodes_fts(memory_episodes_fts, rowid, summary, outcome)
    VALUES ('delete', old.rowid, old.summary, old.outcome);
    INSERT INTO memory_episodes_fts(rowid, summary, outcome) VALUES (new.rowid, new.summary, new.outcome);
  END;

  CREATE TABLE IF NOT EXISTS memory_procedures (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    context TEXT,
    usage_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_knowledge (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    original_id TEXT,
    source TEXT,
    importance REAL DEFAULT 0.5,
    created_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_knowledge_fts
    USING fts5(content, content='memory_knowledge', content_rowid='rowid');

  CREATE TRIGGER IF NOT EXISTS memory_knowledge_ai AFTER INSERT ON memory_knowledge BEGIN
    INSERT INTO memory_knowledge_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS memory_knowledge_ad AFTER DELETE ON memory_knowledge BEGIN
    INSERT INTO memory_knowledge_fts(memory_knowledge_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS memory_knowledge_au AFTER UPDATE ON memory_knowledge BEGIN
    INSERT INTO memory_knowledge_fts(memory_knowledge_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
    INSERT INTO memory_knowledge_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TABLE IF NOT EXISTS memory_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_audit (
    id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    action TEXT NOT NULL,
    source TEXT NOT NULL,
    result TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL
  );

  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
`;

export class MemoryManager {
  readonly #db: Database.Database;
  readonly #provider: EmbeddingProvider;
  readonly #dbPath: string;
  readonly #tier1Limit: number;
  readonly #tier2Days: number;
  readonly #tier3Threshold: number;
  readonly #decayIntervalDays: number;
  readonly #poisoningProtection: boolean;
  #vecMode: VecMode = "json";
  #vecWarned = false;

  constructor(config: MemoryConfig) {
    const dbPath = config.dbPath ?? join(homedir(), ".hlx", "memory.db");
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.#dbPath = dbPath;
    this.#db = new Database(dbPath, { create: true });
    this.#provider = config.embeddingProvider ?? {
      id: "null",
      dimensions: 0,
      embed: async () => err(new Error("Embedding unavailable")),
      embedBatch: async () => err(new Error("Embedding unavailable")),
      isAvailable: async () => false,
    };

    this.#tier1Limit = config.tier1Limit ?? 20;
    this.#tier2Days = config.tier2Days ?? 7;
    this.#tier3Threshold = config.tier3Threshold ?? 0.6;
    this.#decayIntervalDays = config.decayIntervalDays ?? 30;
    this.#poisoningProtection = config.poisoningProtection ?? true;
  }

  async init(): Promise<void> {
    this.#db.exec(SCHEMA);
    const vecAvailable = await tryLoadSqliteVec(this.#db);
    const desiredMode: VecMode = vecAvailable ? "vec0" : "json";
    const existingMode = getVecTableKind(this.#db);
    let rebuildVec = false;

    if (existingMode === "none") {
      createVecTable(this.#db, this.#provider.dimensions, desiredMode);
      rebuildVec = desiredMode === "vec0";
    } else if (existingMode !== desiredMode) {
      this.#db.exec("DROP TABLE IF EXISTS vec_memory");
      createVecTable(this.#db, this.#provider.dimensions, desiredMode);
      rebuildVec = true;
    }

    this.#vecMode = desiredMode;
    this.#setMeta("vec_mode", desiredMode);
    if (!vecAvailable && !this.#vecWarned) {
      console.warn(
        "[memory] sqlite-vec not found — using JS similarity. For better performance: brew install sqlite-vec"
      );
      this.#vecWarned = true;
    }

    const storedDim = this.#getMeta("dimensions");
    const storedProvider = this.#getMeta("provider");
    const currentDim = this.#provider.dimensions;
    if (
      storedDim &&
      Number(storedDim) !== currentDim &&
      Number(storedDim) !== 0 &&
      currentDim !== 0
    ) {
      await migrateEmbeddingDimensions(
        this.#db,
        this.#provider,
        Number(storedDim),
        currentDim,
        this.#vecMode
      );
      rebuildVec = false;
    }
    if (!storedProvider) this.#setMeta("provider", this.#provider.id);
    this.#setMeta("dimensions", String(currentDim));

    if (rebuildVec) {
      await this.#rebuildVecIndex();
    }
  }

  async writeFact(
    content: string,
    opts: {
      category?: MemoryFactCategory;
      importance?: number;
      source?: string;
    } = {}
  ): Promise<Result<string>> {
    const category = opts.category ?? "fact";
    const importance = opts.importance ?? 0.5;
    const source = opts.source ?? "user";

    const blocked = this.#checkAndAudit("write_fact", content, source);
    if (!blocked.ok) return err(new Error(blocked.reason ?? "blocked"));

    const now = Date.now();
    const existing = this.#db
      .prepare("SELECT id, hot_score FROM memory_facts WHERE lower(content) = lower(?) LIMIT 1")
      .get(content) as { id: string; hot_score: number } | undefined;

    if (existing) {
      const newScore = Math.min(1, existing.hot_score + 0.1);
      this.#db
        .prepare("UPDATE memory_facts SET hot_score = ?, updated_at = ? WHERE id = ?")
        .run(newScore, now, existing.id);
      return ok(existing.id);
    }

    const id = `fact_${now}_${Math.random().toString(36).slice(2, 8)}`;
    this.#db
      .prepare(
        "INSERT INTO memory_facts (id, content, category, hot_score, importance, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, content, category, importance, importance, source, now, now);
    return ok(id);
  }

  async writeEpisode(
    summary: string,
    opts: {
      outcome?: string;
      sessionId?: string;
      importance?: number;
      tags?: string[];
      channel?: string;
      date?: string;
      source?: string;
    } = {}
  ): Promise<Result<string>> {
    const importance = opts.importance ?? 0.5;
    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    const source = opts.source ?? opts.sessionId ?? "user";

    const blocked = this.#checkAndAudit("write_episode", summary, source);
    if (!blocked.ok) return err(new Error(blocked.reason ?? "blocked"));

    const id = `episode_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.#db
      .prepare(
        "INSERT INTO memory_episodes (id, summary, outcome, session_id, date, importance, tags, channel, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        id,
        summary,
        opts.outcome ?? null,
        opts.sessionId ?? null,
        date,
        importance,
        JSON.stringify(opts.tags ?? []),
        opts.channel ?? null,
        Date.now()
      );
    return ok(id);
  }

  async writeProcedure(
    title: string,
    content: string,
    opts: { context?: string; source?: string } = {}
  ): Promise<Result<string>> {
    const source = opts.source ?? "user";
    const blocked = this.#checkAndAudit("write_procedure", content, source);
    if (!blocked.ok) return err(new Error(blocked.reason ?? "blocked"));

    const now = Date.now();
    const existing = this.#db
      .prepare("SELECT id FROM memory_procedures WHERE lower(title) = lower(?)")
      .get(title) as { id: string } | undefined;

    if (existing) {
      this.#db
        .prepare(
          "UPDATE memory_procedures SET content = ?, context = ?, updated_at = ? WHERE id = ?"
        )
        .run(content, opts.context ?? null, now, existing.id);
      return ok(existing.id);
    }

    const id = `procedure_${now}_${Math.random().toString(36).slice(2, 8)}`;
    this.#db
      .prepare(
        "INSERT INTO memory_procedures (id, title, content, context, usage_count, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)"
      )
      .run(id, title, content, opts.context ?? null, now, now);
    return ok(id);
  }

  async loadContext(opts: MemoryLoadOptions = {}): Promise<MemoryContext> {
    const facts = this.#db
      .prepare(
        "SELECT content FROM memory_facts WHERE hot_score > 0.1 ORDER BY (hot_score * 0.6 + importance * 0.4) DESC LIMIT ?"
      )
      .all(this.#tier1Limit) as Array<{ content: string }>;

    const episodes = this.#db
      .prepare(
        "SELECT summary, outcome, date FROM memory_episodes WHERE date >= date('now', ?) ORDER BY importance DESC, date DESC LIMIT ?"
      )
      .all(`-${this.#tier2Days} days`, 10) as Array<{
      summary: string;
      outcome: string | null;
      date: string;
    }>;

    const procedures = this.#db
      .prepare("SELECT title, content FROM memory_procedures ORDER BY usage_count DESC LIMIT ?")
      .all(10) as Array<{ title: string; content: string }>;

    const context: MemoryContext = {
      facts: facts.map((f) => `- ${f.content}`),
      recentEpisodes: episodes.map(
        (e) => `- [${e.date}] ${e.summary}${e.outcome ? ` — ${e.outcome}` : ""}`
      ),
      procedures: procedures.map((p) => `- ${p.title}: ${p.content}`),
    };

    if (opts.channel === "telegram") {
      return {
        facts: context.facts,
        recentEpisodes: [],
        procedures: context.procedures,
      };
    }

    if (opts.includeSearch) {
      const search = await this.search(opts.includeSearch);
      if (search.length > 0) {
        context.searchResults = search.map((r) => `- ${r.content}`);
      }
    }

    return context;
  }

  async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
    const providerAvailable = this.#provider.dimensions > 0;
    if (!providerAvailable) return [];
    const vectorResults: Array<{ id: string; score: number }> = [];
    const ftsResults: Array<{ id: string; score: number }> = [];

    if (providerAvailable) {
      const embedRes = await this.#provider.embed(query);
      if (embedRes.ok) {
        if (this.#vecMode === "vec0") {
          const rows = this.#db
            .prepare(
              "SELECT rowid, distance FROM vec_memory WHERE embedding MATCH ? ORDER BY distance LIMIT 20"
            )
            .all(JSON.stringify(embedRes.value)) as Array<{ rowid: number; distance: number }>;
          for (const row of rows) {
            const sim = 1 / (1 + row.distance);
            vectorResults.push({ id: String(row.rowid), score: sim });
          }
        } else {
          const vecRows = this.#db
            .prepare("SELECT id, embedding FROM vec_memory")
            .all() as VecRow[];
          for (const row of vecRows) {
            const vec = JSON.parse(row.embedding) as number[];
            const sim = cosineSimilarity(embedRes.value, vec);
            vectorResults.push({ id: row.id, score: sim });
          }
        }
      }
    }

    try {
      const rows = this.#db
        .prepare(
          "SELECT id, bm25(memory_knowledge_fts) as score FROM memory_knowledge_fts WHERE memory_knowledge_fts MATCH ? LIMIT 20"
        )
        .all(query) as Array<{ id: string; score: number }>;
      for (const row of rows) {
        ftsResults.push({ id: row.id, score: 1 / (1 + row.score) });
      }
    } catch {
      const rows = this.#db
        .prepare("SELECT id FROM memory_knowledge WHERE content LIKE ? LIMIT 20")
        .all(`%${query}%`) as Array<{ id: string }>;
      for (const row of rows) ftsResults.push({ id: row.id, score: 0.5 });
    }

    const normalizedVec = normalizeScores(vectorResults);
    const normalizedFts = normalizeScores(ftsResults);

    const knowledgeRows = this.#db
      .prepare("SELECT rowid, * FROM memory_knowledge")
      .all() as KnowledgeRow[];
    const recency = new Map<string, number>();
    const importance = new Map<string, number>();
    const now = Date.now();

    for (const row of knowledgeRows) {
      const days = (now - row.created_at) / (1000 * 60 * 60 * 24);
      recency.set(row.id, 1 / (1 + days / 30));
      importance.set(row.id, row.importance ?? 0.5);
    }

    const rowidToId = new Map<number, string>();
    for (const row of knowledgeRows) {
      rowidToId.set(row.rowid, row.id);
    }

    const vecNormalized =
      this.#vecMode === "vec0"
        ? normalizedVec
            .map((r) => ({ id: rowidToId.get(Number(r.id)) ?? "", score: r.score }))
            .filter((r) => r.id.length > 0)
        : normalizedVec;

    const combined = combineHybridResults(vecNormalized, normalizedFts, recency, importance)
      .filter((r) => r.score >= this.#tier3Threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (combined.length === 0 && !providerAvailable) return [];

    const resultRows: KnowledgeRow[] = [];
    const byId = new Map(knowledgeRows.map((r) => [r.id, r]));
    for (const row of combined) {
      const data = byId.get(row.id);
      if (data) resultRows.push(data);
    }

    return resultRows.map((row, idx) => ({
      id: row.id,
      content: row.content,
      memoryType: row.memory_type,
      source: row.source,
      score: combined[idx]?.score ?? 0,
      createdAt: row.created_at,
    }));
  }

  async decay(): Promise<void> {
    const cutoff = Date.now() - this.#decayIntervalDays * 24 * 60 * 60 * 1000;
    this.#db
      .prepare(
        "UPDATE memory_facts SET hot_score = hot_score * 0.9 WHERE last_accessed IS NULL OR last_accessed < ?"
      )
      .run(cutoff);

    const factsToPromote = this.#db
      .prepare("SELECT * FROM memory_facts WHERE hot_score < 0.1")
      .all() as MemoryFact[];
    for (const fact of factsToPromote) {
      await this.#promoteFact(fact);
    }

    const oldEpisodes = this.#db
      .prepare("SELECT * FROM memory_episodes WHERE date < date('now', '-90 days')")
      .all() as MemoryEpisode[];
    for (const episode of oldEpisodes) {
      await this.#promoteEpisode(episode);
    }

    const auditCutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    this.#db.prepare("DELETE FROM memory_audit WHERE created_at < ?").run(auditCutoff);
  }

  async export(): Promise<string> {
    const facts = (
      this.#db.prepare("SELECT * FROM memory_facts ORDER BY updated_at DESC").all() as FactRow[]
    ).map((row) => this.#mapFact(row));
    const episodes = (
      this.#db.prepare("SELECT * FROM memory_episodes ORDER BY date DESC").all() as EpisodeRow[]
    ).map((row) => this.#mapEpisode(row));
    const procedures = (
      this.#db
        .prepare("SELECT * FROM memory_procedures ORDER BY usage_count DESC")
        .all() as ProcedureRow[]
    ).map((row) => this.#mapProcedure(row));

    const now = new Date().toISOString();
    const lines: string[] = [];
    lines.push("# HelixClaw Memory");
    lines.push(`Last updated: ${now}`);
    lines.push("");
    lines.push("## What I know about you");

    const groupFacts = (category: MemoryFactCategory) =>
      facts.filter((f) => f.category === category).map((f) => `- ${f.content}`);

    lines.push("### Preferences");
    lines.push(...groupFacts("preference"));
    lines.push("### Projects");
    lines.push(...groupFacts("project"));
    lines.push("### Rules");
    lines.push(...groupFacts("rule"));
    lines.push("");
    lines.push("## How we do things here");
    for (const proc of procedures) {
      lines.push(`### ${proc.title}`);
      lines.push(proc.content);
      if (proc.context) lines.push(`Context: ${proc.context}`);
      lines.push(`Used ${proc.usageCount} times`);
      lines.push("");
    }

    lines.push("## Recent history (last 14 days)");
    for (const episode of episodes) {
      lines.push(`### ${episode.date}`);
      lines.push(`- ${episode.summary}${episode.outcome ? ` → ${episode.outcome}` : ""}`);
    }

    const stats = await this.stats();
    lines.push("");
    lines.push("## Memory stats");
    lines.push(`Facts: ${stats.facts} (active: ${stats.factHot})`);
    lines.push(`Episodes: ${stats.episodes} (recent: ${stats.episodesRecent})`);
    lines.push(`Procedures: ${stats.procedures}`);
    lines.push(`Deep knowledge: ${stats.knowledge} items`);
    lines.push(`Embedding provider: ${stats.providerId}`);
    lines.push(`Database: ${stats.dbPath} (${stats.dbSizeKb}KB)`);

    return `${lines.join("\n")}\n`;
  }

  async stats(): Promise<MemoryStats> {
    const facts = (
      this.#db.prepare("SELECT COUNT(*) as n FROM memory_facts").get() as { n: number }
    ).n;
    const factHot = (
      this.#db.prepare("SELECT COUNT(*) as n FROM memory_facts WHERE hot_score > 0.5").get() as {
        n: number;
      }
    ).n;
    const episodes = (
      this.#db.prepare("SELECT COUNT(*) as n FROM memory_episodes").get() as { n: number }
    ).n;
    const episodesRecent = (
      this.#db
        .prepare("SELECT COUNT(*) as n FROM memory_episodes WHERE date >= date('now', '-7 days')")
        .get() as { n: number }
    ).n;
    const procedures = (
      this.#db.prepare("SELECT COUNT(*) as n FROM memory_procedures").get() as { n: number }
    ).n;
    const knowledge = (
      this.#db.prepare("SELECT COUNT(*) as n FROM memory_knowledge").get() as { n: number }
    ).n;

    const dbFile = Bun.file(this.#dbPath);
    const size = (await dbFile.exists()) ? dbFile.size : 0;
    return {
      facts,
      factHot,
      episodes,
      episodesRecent,
      procedures,
      knowledge,
      providerId: this.#provider.id,
      dimensions: this.#provider.dimensions,
      dbPath: this.#dbPath,
      dbSizeKb: Math.round(size / 1024),
    };
  }

  embeddingDimensions(): number {
    return this.#provider.dimensions;
  }

  async listFacts(): Promise<MemoryFact[]> {
    const rows = this.#db
      .prepare("SELECT * FROM memory_facts ORDER BY updated_at DESC")
      .all() as FactRow[];
    return rows.map((row) => this.#mapFact(row));
  }

  async listEpisodes(): Promise<MemoryEpisode[]> {
    const rows = this.#db
      .prepare("SELECT * FROM memory_episodes ORDER BY date DESC")
      .all() as EpisodeRow[];
    return rows.map((row) => this.#mapEpisode(row));
  }

  async listProcedures(): Promise<MemoryProcedure[]> {
    const rows = this.#db
      .prepare("SELECT * FROM memory_procedures ORDER BY usage_count DESC")
      .all() as ProcedureRow[];
    return rows.map((row) => this.#mapProcedure(row));
  }

  async audit(
    limit = 50
  ): Promise<Array<{ id: string; action: string; result: string; reason?: string | null }>> {
    return this.#db
      .prepare(
        "SELECT id, action, result, reason FROM memory_audit ORDER BY created_at DESC LIMIT ?"
      )
      .all(limit) as Array<{ id: string; action: string; result: string; reason?: string | null }>;
  }

  async deleteById(id: string): Promise<void> {
    const rowid = this.#vecMode === "vec0" ? this.#getRowidForId(id) : undefined;
    this.#db.prepare("DELETE FROM memory_facts WHERE id = ?").run(id);
    this.#db.prepare("DELETE FROM memory_episodes WHERE id = ?").run(id);
    this.#db.prepare("DELETE FROM memory_procedures WHERE id = ?").run(id);
    if (this.#vecMode === "vec0" && rowid !== undefined) {
      this.#db.prepare("DELETE FROM vec_memory WHERE rowid = ?").run(rowid);
    } else {
      this.#db.prepare("DELETE FROM vec_memory WHERE id = ?").run(id);
    }
    this.#db.prepare("DELETE FROM memory_knowledge WHERE id = ?").run(id);
  }

  #mapFact(row: FactRow): MemoryFact {
    return {
      id: row.id,
      content: row.content,
      category: row.category,
      hotScore: row.hot_score,
      importance: row.importance,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessed: row.last_accessed,
    };
  }

  #mapEpisode(row: EpisodeRow): MemoryEpisode {
    return {
      id: row.id,
      summary: row.summary,
      outcome: row.outcome ?? null,
      sessionId: row.session_id ?? null,
      date: row.date,
      importance: row.importance ?? 0.5,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
      channel: row.channel ?? null,
      createdAt: row.created_at,
    };
  }

  #mapProcedure(row: ProcedureRow): MemoryProcedure {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      context: row.context ?? null,
      usageCount: row.usage_count ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #getMeta(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  #setMeta(key: string, value: string): void {
    this.#db
      .prepare(
        "INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, value);
  }

  #checkAndAudit(
    action: string,
    content: string,
    source: string
  ): { ok: boolean; reason?: string } {
    if (!this.#poisoningProtection) return { ok: true };
    const result = checkPoisoning(content);
    const id = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.#db
      .prepare(
        "INSERT INTO memory_audit (id, content_hash, action, source, result, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        id,
        hashContent(content),
        action,
        source,
        result.ok ? "allowed" : "blocked",
        result.reason ?? null,
        Date.now()
      );
    return result;
  }

  async #promoteFact(fact: MemoryFact): Promise<void> {
    const id = `knowledge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.#db
      .prepare(
        "INSERT INTO memory_knowledge (id, content, memory_type, original_id, source, importance, created_at) VALUES (?, ?, 'fact', ?, ?, ?, ?)"
      )
      .run(id, fact.content, fact.id, fact.source, fact.importance, Date.now());
    await this.#storeEmbedding(id, fact.content);
    this.#db.prepare("DELETE FROM memory_facts WHERE id = ?").run(fact.id);
  }

  async #promoteEpisode(episode: MemoryEpisode): Promise<void> {
    const id = `knowledge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const content = `${episode.summary}${episode.outcome ? ` — ${episode.outcome}` : ""}`;
    this.#db
      .prepare(
        "INSERT INTO memory_knowledge (id, content, memory_type, original_id, source, importance, created_at) VALUES (?, ?, 'episode', ?, ?, ?, ?)"
      )
      .run(id, content, episode.id, episode.sessionId ?? null, episode.importance, Date.now());
    await this.#storeEmbedding(id, content);
    this.#db.prepare("DELETE FROM memory_episodes WHERE id = ?").run(episode.id);
  }

  async #storeEmbedding(id: string, content: string): Promise<void> {
    if (this.#provider.dimensions === 0) return;
    const embed = await this.#provider.embed(content);
    if (!embed.ok) return;
    if (this.#vecMode === "vec0") {
      const rowid = this.#getRowidForId(id);
      if (rowid === undefined) return;
      this.#db
        .prepare("INSERT OR REPLACE INTO vec_memory (rowid, embedding) VALUES (?, ?)")
        .run(rowid, JSON.stringify(embed.value));
      return;
    }
    this.#db
      .prepare(
        "INSERT INTO vec_memory (id, embedding) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET embedding = excluded.embedding"
      )
      .run(id, JSON.stringify(embed.value));
  }

  #getRowidForId(id: string): number | undefined {
    const row = this.#db.prepare("SELECT rowid FROM memory_knowledge WHERE id = ?").get(id) as
      | { rowid: number }
      | undefined;
    return row?.rowid;
  }

  async #rebuildVecIndex(): Promise<void> {
    const rows = this.#db.prepare("SELECT id, content FROM memory_knowledge").all() as Array<{
      id: string;
      content: string;
    }>;
    for (const row of rows) {
      await this.#storeEmbedding(row.id, row.content);
    }
  }

  // migration handled in migration.ts
}
