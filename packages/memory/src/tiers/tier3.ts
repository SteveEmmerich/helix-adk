import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TIER3_TABLE = "memory_knowledge";
export const TIER3_FTS = "memory_knowledge_fts";
export const TIER3_VEC = "vec_memory";

export type VecMode = "vec0" | "json";

export async function tryLoadSqliteVec(db: Database.Database): Promise<boolean> {
  try {
    db.prepare("SELECT vec_version()").get();
    return true;
  } catch {
    try {
      const paths = [
        "/usr/local/lib/vec0.dylib",
        "/usr/lib/vec0.so",
        join(homedir(), ".hlx", "vec0.so"),
      ];
      for (const p of paths) {
        if (existsSync(p)) {
          db.loadExtension(p);
          db.prepare("SELECT vec_version()").get();
          return true;
        }
      }
    } catch {
      // ignore
    }
    return false;
  }
}

export function getVecTableKind(db: Database.Database): VecMode | "none" {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ?")
    .get(TIER3_VEC) as { sql?: string } | undefined;
  if (!row?.sql) return "none";
  if (row.sql.toLowerCase().includes("vec0")) return "vec0";
  return "json";
}

export function createVecTable(db: Database.Database, dimensions: number, mode: VecMode): void {
  if (mode === "vec0") {
    const dim = Math.max(1, dimensions);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${TIER3_VEC} USING vec0(embedding float[${dim}])`);
    return;
  }
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${TIER3_VEC} (
      id TEXT PRIMARY KEY,
      embedding TEXT NOT NULL
    )`
  );
}
