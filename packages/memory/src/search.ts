import type { MemorySearchResult } from "./types.js";

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function normalizeScores<T extends { score: number }>(rows: T[]): T[] {
  if (rows.length === 0) return rows;
  const max = Math.max(...rows.map((r) => r.score));
  const min = Math.min(...rows.map((r) => r.score));
  if (max === min) return rows.map((r) => ({ ...r, score: 1 }));
  return rows.map((r) => ({ ...r, score: (r.score - min) / (max - min) }));
}

export function combineHybridResults(
  vectorResults: Array<{ id: string; score: number }>,
  ftsResults: Array<{ id: string; score: number }>,
  recency: Map<string, number>,
  importance: Map<string, number>
): Array<{ id: string; score: number }> {
  const combined = new Map<string, number>();
  for (const row of vectorResults) {
    combined.set(row.id, (combined.get(row.id) ?? 0) + row.score * 0.7);
  }
  for (const row of ftsResults) {
    combined.set(row.id, (combined.get(row.id) ?? 0) + row.score * 0.3);
  }

  for (const [id, base] of combined) {
    const rec = recency.get(id) ?? 0;
    const imp = importance.get(id) ?? 0;
    combined.set(id, base + rec * 0.15 + imp * 0.15);
  }

  return Array.from(combined.entries()).map(([id, score]) => ({ id, score }));
}

export function formatSearchResults(results: MemorySearchResult[]): string[] {
  return results.map((r) => r.content);
}
