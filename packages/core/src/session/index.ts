/**
 * Session management for @helix/core
 *
 * Improvements over pi-mono:
 * 1. Pluggable storage backend (file, sqlite, memory, remote)
 * 2. Session branching & forking as first-class concepts
 * 3. Typed metadata per session
 * 4. Compaction as a pluggable strategy, not hardcoded
 * 5. Session search/listing
 */

import type { Message } from "@helix/ai";
import type { AgentState } from "../loop/agent.js";

// ─── Session types ────────────────────────────────────────────────────────────

export interface SessionMetadata {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly workingDirectory?: string;
  readonly model?: string;
  /** Total cost accumulated in this session */
  readonly totalCostUsd?: number;
  readonly totalTokens?: number;
  readonly messageCount: number;
}

export interface Session {
  readonly metadata: SessionMetadata;
  readonly messages: readonly Message[];
  /** Parent session ID if this is a fork */
  readonly parentId?: string;
}

// ─── Compaction strategy ──────────────────────────────────────────────────────

export interface CompactionStrategy {
  /** Returns true if the session needs compaction */
  shouldCompact(session: Session, contextLimit: number): boolean;
  /** Returns a compacted version of the messages */
  compact(session: Session): Promise<readonly Message[]>;
}

/** Simple sliding-window compaction: keeps system prompt + last N messages */
export class WindowCompactionStrategy implements CompactionStrategy {
  constructor(private readonly keepMessages: number = 20) {}

  shouldCompact(session: Session, _contextLimit: number): boolean {
    // Simple heuristic: compact if messages exceed keepMessages * 2
    return session.messages.length > this.keepMessages * 2;
  }

  async compact(session: Session): Promise<readonly Message[]> {
    const messages = session.messages;
    const systemMessages = messages.filter((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");
    const kept = nonSystem.slice(-this.keepMessages);

    const summary = `[Context compacted: ${nonSystem.length - kept.length} earlier messages omitted]`;

    return [
      ...systemMessages,
      { role: "user", content: summary },
      { role: "assistant", content: [{ type: "text", text: "Understood." }] },
      ...kept,
    ];
  }
}

// ─── Storage backend interface ────────────────────────────────────────────────

export interface SessionStorage {
  save(session: Session): Promise<void>;
  load(id: string): Promise<Session | undefined>;
  list(filter?: { tags?: string[]; workingDirectory?: string }): Promise<SessionMetadata[]>;
  delete(id: string): Promise<void>;
  /** Fork a session — creates a new session with shared history up to a point */
  fork(id: string, atMessageIndex?: number, metadata?: Partial<SessionMetadata>): Promise<Session>;
}

// ─── In-memory storage (default, useful for testing) ─────────────────────────

export class MemorySessionStorage implements SessionStorage {
  readonly #sessions: Map<string, Session> = new Map();

  async save(session: Session): Promise<void> {
    this.#sessions.set(session.metadata.id, session);
  }

  async load(id: string): Promise<Session | undefined> {
    return this.#sessions.get(id);
  }

  async list(filter?: { tags?: string[]; workingDirectory?: string }): Promise<SessionMetadata[]> {
    const all = Array.from(this.#sessions.values()).map((s) => s.metadata);
    return all.filter((m) => {
      if (filter?.workingDirectory && m.workingDirectory !== filter.workingDirectory) return false;
      if (filter?.tags) {
        const sessionTags = m.tags ?? [];
        return filter.tags.some((t) => sessionTags.includes(t));
      }
      return true;
    });
  }

  async delete(id: string): Promise<void> {
    this.#sessions.delete(id);
  }

  async fork(
    id: string,
    atMessageIndex?: number,
    metadata?: Partial<SessionMetadata>
  ): Promise<Session> {
    const original = this.#sessions.get(id);
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

    this.#sessions.set(newId, forked);
    return forked;
  }
}

// ─── File system storage ──────────────────────────────────────────────────────

export class FileSessionStorage implements SessionStorage {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async #ensureDir(): Promise<void> {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(this.#dir, { recursive: true });
  }

  async save(session: Session): Promise<void> {
    await this.#ensureDir();
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const path = join(this.#dir, `${session.metadata.id}.json`);
    await writeFile(path, JSON.stringify(session, null, 2), "utf-8");
  }

  async load(id: string): Promise<Session | undefined> {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
      const raw = await readFile(join(this.#dir, `${id}.json`), "utf-8");
      return JSON.parse(raw) as Session;
    } catch (e) {
      console.error(`[session] Failed to load session ${id} from ${this.#dir}:`, e);
      return undefined;
    }
  }

  async list(filter?: { tags?: string[]; workingDirectory?: string }): Promise<SessionMetadata[]> {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
      const files = await readdir(this.#dir);
      let sessions = await Promise.all(
        files
          .filter((f) => f.endsWith(".json"))
          .map(async (f) => {
            const raw = await readFile(join(this.#dir, f), "utf-8");
            const session = JSON.parse(raw) as Session;
            return session.metadata;
          })
      );

      if (filter?.workingDirectory) {
        sessions = sessions.filter((m) => m.workingDirectory === filter.workingDirectory);
      }
      if (filter?.tags?.length) {
        sessions = sessions.filter((m) => {
          const sessionTags = m.tags ?? [];
          return filter.tags?.some((t) => sessionTags.includes(t));
        });
      }

      return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (e) {
      console.error(`[session] Failed to list sessions from ${this.#dir}:`, e);
      return [];
    }
  }

  async delete(id: string): Promise<void> {
    const { unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await unlink(join(this.#dir, `${id}.json`));
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
}

// ─── Session manager (high-level) ─────────────────────────────────────────────

export class SessionManager {
  readonly #storage: SessionStorage;
  readonly #compaction: CompactionStrategy;
  #current: Session | undefined;

  constructor(storage: SessionStorage, compaction?: CompactionStrategy) {
    this.#storage = storage;
    this.#compaction = compaction ?? new WindowCompactionStrategy();
  }

  get current(): Session | undefined {
    return this.#current;
  }

  async create(metadata?: Partial<SessionMetadata>): Promise<Session> {
    const now = Date.now();
    const id = metadata?.id ?? crypto.randomUUID();
    const session: Session = {
      metadata: {
        id,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        ...metadata,
      },
      messages: [],
    };
    await this.#storage.save(session);
    this.#current = session;
    return session;
  }

  async load(id: string): Promise<Session | undefined> {
    const session = await this.#storage.load(id);
    if (session) this.#current = session;
    return session;
  }

  async syncFromAgent(state: AgentState): Promise<void> {
    if (!this.#current) return;

    const updated: Session = {
      ...this.#current,
      metadata: {
        ...this.#current.metadata,
        updatedAt: Date.now(),
        messageCount: state.messages.length,
        totalCostUsd: state.totalCostUsd,
        totalTokens: state.totalTokens,
      },
      messages: state.messages,
    };

    this.#current = updated;
    await this.#storage.save(updated);
  }

  async fork(atMessageIndex?: number): Promise<Session> {
    if (!this.#current) throw new Error("No active session to fork");
    const forked = await this.#storage.fork(this.#current.metadata.id, atMessageIndex);
    this.#current = forked;
    return forked;
  }

  list = (filter?: { tags?: string[]; workingDirectory?: string }) => this.#storage.list(filter);

  async maybeCompact(contextLimit: number): Promise<boolean> {
    if (!this.#current) return false;
    if (!this.#compaction.shouldCompact(this.#current, contextLimit)) return false;

    const compacted = await this.#compaction.compact(this.#current);
    const updated: Session = {
      ...this.#current,
      messages: compacted,
      metadata: {
        ...this.#current.metadata,
        messageCount: compacted.length,
        updatedAt: Date.now(),
      },
    };
    this.#current = updated;
    await this.#storage.save(updated);
    return true;
  }
}
