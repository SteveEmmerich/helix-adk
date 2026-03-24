/**
 * @helix/ext-memory — Persistent memory for Helix agents
 *
 * Backs the remember/recall/forget tools with SQLite instead of in-memory store.
 * Also adds semantic chunking and FTS5 full-text search.
 *
 * Memory persists across sessions at ~/.hlx/memory.db
 */

import { Database } from "bun:sqlite";
import type { ExtensionContext, HelixExtension } from "@helix/cli/extension";
import { defineTool } from "@helix/core";
import type { MemoryEntry, MemoryStore } from "@helix/core";

// ─── SQLite memory store ──────────────────────────────────────────────────────

class SqliteMemoryStore implements MemoryStore {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath, { create: true });
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id         TEXT PRIMARY KEY,
        content    TEXT NOT NULL,
        tags       TEXT NOT NULL DEFAULT '[]',
        metadata   TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_memories
        USING fts5(id, content, content='memories', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO fts_memories(rowid, id, content) VALUES (new.rowid, new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO fts_memories(fts_memories, rowid, id, content) VALUES ('delete', old.rowid, old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO fts_memories(fts_memories, rowid, id, content) VALUES ('delete', old.rowid, old.id, old.content);
        INSERT INTO fts_memories(rowid, id, content) VALUES (new.rowid, new.id, new.content);
      END;
      PRAGMA journal_mode=WAL;
    `);
  }

  async set(id: string, content: string, tags: string[] = []): Promise<void> {
    const now = Date.now();
    this.#db
      .query(`
      INSERT INTO memories (id, content, tags, metadata, created_at, updated_at)
      VALUES (@id, @content, @tags, @metadata, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        tags = excluded.tags,
        updated_at = excluded.updated_at
    `)
      .run({ id, content, tags: JSON.stringify(tags), metadata: "{}", now });
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    const row = this.#db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | RawRow
      | undefined;
    return row ? this.#toEntry(row) : undefined;
  }

  async search(tags: string[]): Promise<MemoryEntry[]> {
    const rows = this.#db
      .prepare("SELECT * FROM memories ORDER BY updated_at DESC")
      .all() as RawRow[];
    return rows
      .filter((r) => {
        const t: string[] = JSON.parse(r.tags);
        return tags.some((tag) => t.includes(tag));
      })
      .map(this.#toEntry);
  }

  async query(text: string, limit = 10): Promise<MemoryEntry[]> {
    try {
      const rows = this.#db
        .query(`
        SELECT m.* FROM memories m
        JOIN fts_memories fts ON m.id = fts.id
        WHERE fts_memories MATCH ?
        ORDER BY rank
        LIMIT ?
      `)
        .all(text, limit) as RawRow[];
      return rows.map(this.#toEntry);
    } catch {
      // FTS not available — fall back to LIKE
      const rows = this.#db
        .prepare("SELECT * FROM memories WHERE content LIKE ? LIMIT ?")
        .all(`%${text}%`, limit) as RawRow[];
      return rows.map(this.#toEntry);
    }
  }

  async delete(id: string): Promise<void> {
    this.#db.query("DELETE FROM memories WHERE id = ?").run(id);
  }

  async list(): Promise<MemoryEntry[]> {
    const rows = this.#db
      .prepare("SELECT * FROM memories ORDER BY updated_at DESC")
      .all() as RawRow[];
    return rows.map(this.#toEntry);
  }

  #toEntry(row: RawRow): MemoryEntry {
    return {
      id: row.id,
      content: row.content,
      tags: JSON.parse(row.tags) as string[],
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  stats() {
    return (this.#db.query("SELECT COUNT(*) as n FROM memories").get() as { n: number }).n;
  }

  close() {
    this.#db.close();
  }
}

interface RawRow {
  id: string;
  content: string;
  tags: string;
  metadata: string;
  created_at: number;
  updated_at: number;
}

// ─── Extension ────────────────────────────────────────────────────────────────

let store: SqliteMemoryStore | undefined;

const memoryExtension: HelixExtension = {
  name: "@helix/ext-memory",
  version: "0.1.0",
  description: "Persistent SQLite-backed memory (remember/recall/forget)",

  setup(ctx: ExtensionContext) {
    const dbPath = `${process.env.HOME ?? ""}/.hlx/memory.db`;
    store = new SqliteMemoryStore(dbPath);
    ctx.log(`Memory store: ${dbPath} (${store.stats()} entries)`);
    return true;
  },

  teardown() {
    store?.close();
    store = undefined;
  },

  tools() {
    if (!store) return [];
    const s = store;

    const rememberTool = defineTool({
      name: "remember",
      description:
        "Store information in persistent memory. Survives across sessions. " +
        "Use for: user preferences, project facts, decisions, anything worth retaining long-term.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Unique key (e.g. 'user.preferred_language', 'project.db_schema')",
          },
          content: { type: "string", description: "What to remember" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for grouping" },
        },
        required: ["id", "content"],
      },
      execute: async ({ id, content, tags }: { id: string; content: string; tags?: string[] }) => {
        await s.set(id, content, tags);
        return { stored: id };
      },
      formatOutput: ({ stored }) => `Remembered: ${stored}`,
    });

    const recallTool = defineTool({
      name: "recall",
      description: "Retrieve from persistent memory by ID, tag search, or full-text search.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Exact memory ID" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Find memories with these tags",
          },
          query: { type: "string", description: "Full-text search" },
        },
      },
      execute: async ({ id, tags, query }: { id?: string; tags?: string[]; query?: string }) => {
        if (id) {
          const e = await s.get(id);
          return e ? [e] : [];
        }
        if (tags?.length) return s.search(tags);
        if (query) return s.query(query);
        return s.list();
      },
      formatOutput: (entries) => {
        if (!Array.isArray(entries) || entries.length === 0) return "Nothing remembered yet.";
        return (entries as MemoryEntry[]).map((e) => `[${e.id}] ${e.content}`).join("\n");
      },
    });

    const forgetTool = defineTool({
      name: "forget",
      description: "Delete a specific memory by ID.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Memory ID to delete" } },
        required: ["id"],
      },
      execute: async ({ id }: { id: string }) => {
        await s.delete(id);
        return { deleted: id };
      },
      formatOutput: ({ deleted }) => `Forgotten: ${deleted}`,
    });

    return [rememberTool, recallTool, forgetTool];
  },

  commands() {
    return [
      {
        name: "memory",
        aliases: ["mem"],
        description: "Show all stored memories",
        async execute(_args, ctx) {
          if (!store) return { type: "error", message: "Memory store not initialized" };
          const entries = await store.list();
          if (entries.length === 0) {
            ctx.print("  No memories stored yet.\n");
          } else {
            ctx.print(`\n  ${entries.length} memories:\n`);
            for (const e of entries.slice(0, 20)) {
              ctx.print(`  • [${e.id}] ${e.content.slice(0, 80)}\n`);
            }
            if (entries.length > 20) ctx.print(`  ... and ${entries.length - 20} more\n`);
          }
          ctx.print("\n");
          return { type: "handled" };
        },
      },
    ];
  },
};

export default memoryExtension;
