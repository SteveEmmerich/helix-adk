import type { Database } from "bun:sqlite";
import { type VecMode, createVecTable } from "./tiers/tier3.js";
import type { EmbeddingProvider } from "./types.js";

export async function migrateEmbeddingDimensions(
  db: Database.Database,
  provider: EmbeddingProvider,
  from: number,
  to: number,
  vecMode: VecMode
): Promise<void> {
  console.log(
    `[memory] Embedding dimensions changed from ${from} to ${to}. Re-embedding memories...`
  );
  const rows = db.prepare("SELECT rowid, id, content FROM memory_knowledge").all() as Array<{
    rowid: number;
    id: string;
    content: string;
  }>;
  db.exec("DROP TABLE IF EXISTS vec_memory");
  createVecTable(db, to, vecMode);
  for (const row of rows) {
    if (provider.dimensions === 0) continue;
    const embed = await provider.embed(row.content);
    if (!embed.ok) continue;
    if (vecMode === "vec0") {
      db.prepare("INSERT OR REPLACE INTO vec_memory (rowid, embedding) VALUES (?, ?)").run(
        row.rowid,
        JSON.stringify(embed.value)
      );
    } else {
      db.prepare(
        "INSERT INTO vec_memory (id, embedding) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET embedding = excluded.embedding"
      ).run(row.id, JSON.stringify(embed.value));
    }
  }
}
