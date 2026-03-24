/**
 * Memory system for @helix/core
 *
 * Unlike pi-mono which lacks first-class memory support, Helix provides:
 * 1. Key-value store (episodic/fact memory)
 * 2. Vector-compatible interface (for semantic search via embeddings)
 * 3. Memory tool that agents can call natively
 */

import type { ToolDefinition } from "@helix/ai";
import { defineTool } from "../tools/index.js";

// ─── Memory entry ─────────────────────────────────────────────────────────────

export interface MemoryEntry {
  readonly id: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadata: Record<string, unknown>;
}

// ─── Memory store interface ───────────────────────────────────────────────────

export interface MemoryStore {
  /** Store a fact or piece of knowledge */
  set(id: string, content: string, tags?: string[]): Promise<void>;
  /** Retrieve by exact ID */
  get(id: string): Promise<MemoryEntry | undefined>;
  /** Search by tags */
  search(tags: string[]): Promise<MemoryEntry[]>;
  /** Full-text search (exact match) */
  query(text: string, limit?: number): Promise<MemoryEntry[]>;
  /** Delete entry */
  delete(id: string): Promise<void>;
  /** List all entries */
  list(): Promise<MemoryEntry[]>;
}

// ─── In-memory store ──────────────────────────────────────────────────────────

export class InMemoryStore implements MemoryStore {
  readonly #entries: Map<string, MemoryEntry> = new Map();

  async set(id: string, content: string, tags: string[] = []): Promise<void> {
    const now = Date.now();
    const existing = this.#entries.get(id);
    this.#entries.set(id, {
      id,
      content,
      tags,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      metadata: {},
    });
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    return this.#entries.get(id);
  }

  async search(tags: string[]): Promise<MemoryEntry[]> {
    return Array.from(this.#entries.values()).filter((e) => tags.some((t) => e.tags.includes(t)));
  }

  async query(text: string, limit = 10): Promise<MemoryEntry[]> {
    const lower = text.toLowerCase();
    return Array.from(this.#entries.values())
      .filter((e) => e.content.toLowerCase().includes(lower))
      .slice(0, limit);
  }

  async delete(id: string): Promise<void> {
    this.#entries.delete(id);
  }

  async list(): Promise<MemoryEntry[]> {
    return Array.from(this.#entries.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

// ─── Memory tools for agents ──────────────────────────────────────────────────

export function createMemoryTools(store: MemoryStore): readonly ToolDefinition[] {
  const rememberTool = defineTool({
    name: "remember",
    description:
      "Store a piece of information in long-term memory for future reference. " +
      "Use for facts, user preferences, project context, or anything worth retaining.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Unique key for this memory (e.g. 'user.name', 'project.stack')",
        },
        content: { type: "string", description: "The information to remember" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for grouping/searching",
        },
      },
      required: ["id", "content"],
    },
    execute: async ({
      id,
      content,
      tags,
    }: {
      id: string;
      content: string;
      tags?: string[];
    }) => {
      await store.set(id, content, tags);
      return { stored: id };
    },
    formatOutput: ({ stored }) => `Stored memory: ${stored}`,
  });

  const recallTool = defineTool({
    name: "recall",
    description:
      "Retrieve stored memories by ID, tags, or text search. " +
      "Call this when you need to remember something from a previous conversation.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Look up by exact ID" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Find memories with any of these tags",
        },
        query: { type: "string", description: "Full-text search" },
      },
    },
    execute: async ({
      id,
      tags,
      query,
    }: {
      id?: string;
      tags?: string[];
      query?: string;
    }) => {
      if (id) {
        const entry = await store.get(id);
        return entry ? [entry] : [];
      }
      if (tags && tags.length > 0) return store.search(tags);
      if (query) return store.query(query);
      return store.list();
    },
    formatOutput: (entries) => {
      if (!Array.isArray(entries) || entries.length === 0) return "No memories found.";
      return entries.map((e: MemoryEntry) => `[${e.id}] ${e.content}`).join("\n");
    },
  });

  const forgetTool = defineTool({
    name: "forget",
    description: "Delete a stored memory by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The memory ID to delete" },
      },
      required: ["id"],
    },
    execute: async ({ id }: { id: string }) => {
      await store.delete(id);
      return { deleted: id };
    },
    formatOutput: ({ deleted }) => `Deleted memory: ${deleted}`,
  });

  return [rememberTool, recallTool, forgetTool];
}
