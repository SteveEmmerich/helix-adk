/**
 * @helix/storage-sqlite
 *
 * SQLite-backed session storage for Helix ADK.
 *
 * Why SQLite over JSON files:
 * 1. Indexed queries — list sessions by tag, working directory, date range
 * 2. Atomic writes — no partial-write corruption on crash
 * 3. Single file — easy to backup, sync, or inspect with any SQLite tool
 * 4. Full-text search — find sessions by message content
 * 5. Scales to 100k+ sessions without reading all files at startup
 *
 * Schema:
 *   sessions    — metadata (id, title, tags, model, timestamps, cost, tokens)
 *   messages    — denormalized message storage (one row per message)
 *   fts_messages — FTS5 virtual table for full-text search
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Message } from "@helix/ai";
import type { Session, SessionMetadata, SessionStorage } from "@helix/core";

interface SessionRow {
  id: string;
  title: string | null;
  tags: string | null; // JSON array
  model: string | null;
  working_directory: string | null;
  parent_id: string | null;
  created_at: number;
  updated_at: number;
  message_count: number;
  total_cost_usd: number;
  total_tokens: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id                TEXT PRIMARY KEY,
    title             TEXT,
    tags              TEXT DEFAULT '[]',
    model             TEXT,
    working_directory TEXT,
    parent_id         TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    message_count     INTEGER DEFAULT 0,
    total_cost_usd    REAL DEFAULT 0,
    total_tokens      INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_working_directory ON sessions(working_directory);

  CREATE TABLE IF NOT EXISTS session_messages (
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,   -- JSON serialized
    PRIMARY KEY (session_id, position)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages
    USING fts5(session_id, content);

  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA foreign_keys=ON;
`;

export interface SqliteStorageOptions {
  /** Path to the SQLite database file. Default: ~/.hlx/sessions.db */
  readonly path?: string;
  /** Whether to enable verbose logging. Default: false */
  readonly verbose?: boolean;
}

export class SqliteSessionStorage implements SessionStorage {
  readonly #db: Database.Database;

  constructor(options: SqliteStorageOptions = {}) {
    const dbPath = options.path ?? `${process.env.HOME ?? ""}/.hlx/sessions.db`;

    // Ensure directory exists — bun:sqlite needs the directory to exist
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.#db = new Database(dbPath, { create: true });
    this.#db.exec(SCHEMA);
  }

  async save(session: Session): Promise<void> {
    const saveSession = this.#db.transaction(() => {
      const now = Date.now();
      const createdAt = session.metadata.createdAt ?? now;
      const updatedAt = session.metadata.updatedAt ?? now;
      const messageCount = session.metadata.messageCount ?? session.messages.length;
      const totalCostUsd = session.metadata.totalCostUsd ?? 0;
      const totalTokens = session.metadata.totalTokens ?? 0;
      const meta = {
        ...session.metadata,
        createdAt,
        updatedAt,
        messageCount,
        totalCostUsd,
        totalTokens,
      };

      // Upsert session metadata
      this.#db
        .query(`
        INSERT INTO sessions
          (id, title, tags, model, working_directory, parent_id, created_at, updated_at, message_count, total_cost_usd, total_tokens)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          tags = excluded.tags,
          model = excluded.model,
          working_directory = excluded.working_directory,
          updated_at = excluded.updated_at,
          message_count = excluded.message_count,
          total_cost_usd = excluded.total_cost_usd,
          total_tokens = excluded.total_tokens
      `)
        .run(
          meta.id,
          meta.title ?? null,
          JSON.stringify(meta.tags ?? []),
          meta.model ?? null,
          meta.workingDirectory ?? null,
          session.parentId ?? null,
          createdAt,
          updatedAt,
          messageCount,
          totalCostUsd,
          totalTokens
        );

      // Replace all messages (delete + insert in transaction = atomic)
      this.#db.query("DELETE FROM session_messages WHERE session_id = ?").run(meta.id);
      this.#db.query("DELETE FROM fts_messages WHERE session_id = ?").run(meta.id);

      const insertMsg = this.#db.query(`
        INSERT INTO session_messages (session_id, position, role, content)
        VALUES (?, ?, ?, ?)
      `);
      const insertFts = this.#db.query(`
        INSERT INTO fts_messages (session_id, content)
        VALUES (?, ?)
      `);

      for (let i = 0; i < session.messages.length; i++) {
        const msg = session.messages[i];
        if (!msg) continue;
        const serialized = JSON.stringify(msg);
        insertMsg.run(meta.id, i, msg.role, serialized);
        insertFts.run(meta.id, serialized);
      }
    });

    saveSession();
  }

  async load(id: string): Promise<Session | undefined> {
    const row = this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;

    if (!row) return undefined;

    const messages = this.#db
      .prepare("SELECT role, content FROM session_messages WHERE session_id = ? ORDER BY position")
      .all(id) as Array<{ role: string; content: string }>;

    return {
      metadata: this.#rowToMetadata(row),
      messages: messages.map((m) => JSON.parse(m.content) as Message),
      parentId: row.parent_id ?? undefined,
    };
  }

  async list(filter?: { tags?: string[]; workingDirectory?: string }): Promise<SessionMetadata[]> {
    let query = "SELECT * FROM sessions";
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.workingDirectory) {
      conditions.push("working_directory = ?");
      params.push(filter.workingDirectory);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }

    query += " ORDER BY updated_at DESC";

    let rows = this.#db.query(query).all(...params) as SessionRow[];

    // Tag filtering in JS (SQLite JSON functions vary by version)
    if (filter?.tags?.length) {
      rows = rows.filter((row) => {
        const sessionTags: string[] = JSON.parse(row.tags ?? "[]");
        return filter.tags?.some((t) => sessionTags.includes(t));
      });
    }

    return rows.map(this.#rowToMetadata);
  }

  async delete(id: string): Promise<void> {
    this.#db.query("DELETE FROM sessions WHERE id = ?").run(id);
  }

  async fork(
    id: string,
    atMessageIndex?: number,
    metadata?: Partial<SessionMetadata>
  ): Promise<Session> {
    const original = await this.load(id);
    if (!original) throw new Error(`Session not found: ${id}`);

    const messages =
      atMessageIndex !== undefined ? original.messages.slice(0, atMessageIndex) : original.messages;

    const newId = crypto.randomUUID();
    const now = Date.now();
    const forked: Session = {
      metadata: {
        ...original.metadata,
        ...metadata,
        id: newId,
        createdAt: now,
        updatedAt: now,
        messageCount: messages.length,
      },
      messages,
      parentId: id,
    };

    await this.save(forked);
    return forked;
  }

  /** Full-text search across all session messages */
  searchMessages(query: string, limit = 10): Array<{ sessionId: string; snippet: string }> {
    try {
      const rows = this.#db
        .query(`
        SELECT session_id, snippet(fts_messages, 1, '<b>', '</b>', '...', 20) as snippet
        FROM fts_messages
        WHERE content MATCH ?
        LIMIT ?
      `)
        .all(query, limit) as Array<{ session_id: string; snippet: string }>;

      return rows.map((r) => ({ sessionId: r.session_id, snippet: r.snippet }));
    } catch {
      return [];
    }
  }

  /** Get storage stats */
  stats(): { sessionCount: number; messageCount: number; dbSizeBytes: number } {
    const sessionCount = (
      this.#db.query("SELECT COUNT(*) as n FROM sessions").get() as { n: number }
    ).n;
    const messageCount = (
      this.#db.query("SELECT COUNT(*) as n FROM session_messages").get() as { n: number }
    ).n;
    const dbSizeBytes = (
      this.#db
        .query("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()")
        .get() as { size: number }
    ).size;
    return { sessionCount, messageCount, dbSizeBytes };
  }

  close(): void {
    this.#db.close();
  }

  #rowToMetadata(row: SessionRow): SessionMetadata {
    return {
      id: row.id,
      title: row.title ?? undefined,
      tags: JSON.parse(row.tags ?? "[]") as string[],
      model: row.model ?? undefined,
      workingDirectory: row.working_directory ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
      totalCostUsd: row.total_cost_usd,
      totalTokens: row.total_tokens,
    };
  }
}
