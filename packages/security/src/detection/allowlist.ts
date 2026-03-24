import type { Database } from "bun:sqlite";
import type { AllowlistEntry, LeakType } from "../types.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS leak_allowlist (
    id TEXT PRIMARY KEY,
    tool_name TEXT NOT NULL,
    leak_type TEXT NOT NULL,
    pattern_hint TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_allowlist_tool ON leak_allowlist(tool_name);
`;

function now(): number {
  return Date.now();
}

export class AllowlistManager {
  readonly #db: Database;

  constructor(config: { db: Database }) {
    this.#db = config.db;
    this.#db.exec(SCHEMA);
  }

  isAllowed(toolName: string, leakType: LeakType): boolean {
    const row = this.#db
      .query("SELECT id FROM leak_allowlist WHERE tool_name = ? AND leak_type = ?")
      .get(toolName, leakType) as { id: string } | undefined;
    return Boolean(row?.id);
  }

  allow(toolName: string, leakType: LeakType, patternHint: string): void {
    const existing = this.#db
      .query("SELECT id FROM leak_allowlist WHERE tool_name = ? AND leak_type = ?")
      .get(toolName, leakType) as { id: string } | undefined;
    if (existing) return;
    this.#db
      .query(
        "INSERT INTO leak_allowlist (id, tool_name, leak_type, pattern_hint, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(crypto.randomUUID(), toolName, leakType, patternHint, now());
  }

  revoke(id: string): void {
    this.#db.query("DELETE FROM leak_allowlist WHERE id = ?").run(id);
  }

  list(): AllowlistEntry[] {
    const rows = this.#db
      .query("SELECT * FROM leak_allowlist ORDER BY created_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      toolName: String(row.tool_name),
      leakType: row.leak_type as LeakType,
      patternHint: (row.pattern_hint as string | null) ?? null,
      createdAt: Number(row.created_at),
    }));
  }
}
