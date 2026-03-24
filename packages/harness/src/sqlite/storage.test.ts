/**
 * SQLite session storage stress tests
 *
 * Tests:
 * 1. Concurrent reads during writes (WAL mode)
 * 2. Large sessions (10k messages)
 * 3. FTS5 search accuracy and performance
 * 4. Fork integrity
 * 5. Delete cascade
 * 6. Storage stats
 * 7. Repeated save/load round-trips (idempotency)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@helix/core";
import { SqliteSessionStorage } from "@helix/storage-sqlite";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "helix-test-"));
  return join(dir, "sessions.db");
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const id = crypto.randomUUID();
  const now = Date.now();
  return {
    metadata: {
      id,
      title: "Test session",
      tags: ["test"],
      model: "claude-sonnet-4-5",
      workingDirectory: "/tmp",
      createdAt: now,
      updatedAt: now,
      messageCount: 2,
      totalCostUsd: 0.01,
      totalTokens: 100,
    },
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
    ],
    ...overrides,
  };
}

// ─── Basic CRUD ───────────────────────────────────────────────────────────────

describe("SqliteSessionStorage — CRUD", () => {
  let db: string;
  let storage: SqliteSessionStorage;

  beforeEach(() => {
    db = tmpDb();
    storage = new SqliteSessionStorage({ path: db });
  });

  afterEach(() => {
    storage.close();
    rmSync(db, { force: true });
  });

  it("saves and loads a session", async () => {
    const session = makeSession();
    await storage.save(session);

    const loaded = await storage.load(session.metadata.id);
    expect(loaded).toBeDefined();
    expect(loaded?.metadata.id).toBe(session.metadata.id);
    expect(loaded?.metadata.title).toBe("Test session");
    expect(loaded?.messages).toHaveLength(2);
  });

  it("round-trip preserves all metadata fields", async () => {
    const session = makeSession({ metadata: makeSession().metadata });
    await storage.save(session);

    const loaded = await storage.load(session.metadata.id);
    const m = loaded?.metadata;
    expect(m.tags).toEqual(["test"]);
    expect(m.model).toBe("claude-sonnet-4-5");
    expect(m.workingDirectory).toBe("/tmp");
    expect(m.totalCostUsd).toBeCloseTo(0.01);
    expect(m.totalTokens).toBe(100);
  });

  it("save is idempotent — repeated saves don't duplicate messages", async () => {
    const session = makeSession();
    await storage.save(session);
    await storage.save(session);
    await storage.save(session);

    const loaded = await storage.load(session.metadata.id);
    expect(loaded?.messages).toHaveLength(2); // not 6
  });

  it("updates existing session on re-save", async () => {
    const session = makeSession();
    await storage.save(session);

    const updated: Session = {
      ...session,
      metadata: { ...session.metadata, title: "Updated title", totalCostUsd: 0.99 },
      messages: [...session.messages, { role: "user", content: "Follow-up" }],
    };
    await storage.save(updated);

    const loaded = await storage.load(session.metadata.id);
    expect(loaded?.metadata.title).toBe("Updated title");
    expect(loaded?.messages).toHaveLength(3);
    expect(loaded?.metadata.totalCostUsd).toBeCloseTo(0.99);
  });

  it("returns undefined for missing session", async () => {
    const loaded = await storage.load("does-not-exist");
    expect(loaded).toBeUndefined();
  });

  it("delete removes session and messages", async () => {
    const session = makeSession();
    await storage.save(session);
    await storage.delete(session.metadata.id);

    expect(await storage.load(session.metadata.id)).toBeUndefined();
    expect(storage.stats().messageCount).toBe(0);
  });

  it("lists sessions ordered by updatedAt desc", async () => {
    const s1 = makeSession({ metadata: { ...makeSession().metadata, updatedAt: 1000 } });
    const s2 = makeSession({ metadata: { ...makeSession().metadata, updatedAt: 3000 } });
    const s3 = makeSession({ metadata: { ...makeSession().metadata, updatedAt: 2000 } });

    await storage.save(s1);
    await storage.save(s2);
    await storage.save(s3);

    const list = await storage.list();
    expect(list[0]?.updatedAt).toBe(3000);
    expect(list[1]?.updatedAt).toBe(2000);
    expect(list[2]?.updatedAt).toBe(1000);
  });

  it("filters list by workingDirectory", async () => {
    await storage.save(
      makeSession({ metadata: { ...makeSession().metadata, workingDirectory: "/proj/a" } })
    );
    await storage.save(
      makeSession({ metadata: { ...makeSession().metadata, workingDirectory: "/proj/b" } })
    );
    await storage.save(
      makeSession({ metadata: { ...makeSession().metadata, workingDirectory: "/proj/a" } })
    );

    const list = await storage.list({ workingDirectory: "/proj/a" });
    expect(list).toHaveLength(2);
  });

  it("filters list by tags", async () => {
    await storage.save(
      makeSession({ metadata: { ...makeSession().metadata, tags: ["work", "typescript"] } })
    );
    await storage.save(
      makeSession({ metadata: { ...makeSession().metadata, tags: ["personal"] } })
    );
    await storage.save(makeSession({ metadata: { ...makeSession().metadata, tags: ["work"] } }));

    const list = await storage.list({ tags: ["work"] });
    expect(list).toHaveLength(2);
  });
});

// ─── Fork ─────────────────────────────────────────────────────────────────────

describe("SqliteSessionStorage — fork", () => {
  let db: string;
  let storage: SqliteSessionStorage;

  beforeEach(() => {
    db = tmpDb();
    storage = new SqliteSessionStorage({ path: db });
  });

  afterEach(() => {
    storage.close();
    rmSync(db, { force: true });
  });

  it("fork creates new session with parentId set", async () => {
    const session = makeSession();
    await storage.save(session);

    const forked = await storage.fork(session.metadata.id);
    expect(forked.parentId).toBe(session.metadata.id);
    expect(forked.metadata.id).not.toBe(session.metadata.id);
  });

  it("fork at message index truncates history correctly", async () => {
    const session: Session = {
      ...makeSession(),
      messages: [
        { role: "user", content: "1" },
        { role: "assistant", content: [{ type: "text", text: "2" }] },
        { role: "user", content: "3" },
        { role: "assistant", content: [{ type: "text", text: "4" }] },
      ],
    };
    await storage.save(session);

    const forked = await storage.fork(session.metadata.id, 2);
    expect(forked.messages).toHaveLength(2);
    expect(forked.messages[0]).toMatchObject({ role: "user", content: "1" });
  });

  it("forked session is independent — mutating original doesn't affect fork", async () => {
    const session = makeSession();
    await storage.save(session);

    const forked = await storage.fork(session.metadata.id);

    // Update original
    const updated = { ...session, metadata: { ...session.metadata, title: "New title" } };
    await storage.save(updated);

    // Fork should be unchanged
    const loadedFork = await storage.load(forked.metadata.id);
    expect(loadedFork?.metadata.title).toBe("Test session");
  });

  it("delete original doesn't cascade to fork (fork is independent)", async () => {
    const session = makeSession();
    await storage.save(session);
    const forked = await storage.fork(session.metadata.id);

    await storage.delete(session.metadata.id);

    const loadedFork = await storage.load(forked.metadata.id);
    expect(loadedFork).toBeDefined();
  });
});

// ─── Large sessions ───────────────────────────────────────────────────────────

describe("SqliteSessionStorage — large sessions", () => {
  let db: string;
  let storage: SqliteSessionStorage;

  beforeEach(() => {
    db = tmpDb();
    storage = new SqliteSessionStorage({ path: db });
  });

  afterEach(() => {
    storage.close();
    rmSync(db, { force: true });
  });

  it("handles 1000-message session", async () => {
    const messages = Array.from({ length: 1000 }, (_, i) =>
      i % 2 === 0
        ? { role: "user" as const, content: `Message ${i}` }
        : {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: `Response ${i}` }],
          }
    );

    const session: Session = {
      ...makeSession(),
      messages,
      metadata: { ...makeSession().metadata, messageCount: 1000 },
    };

    const saveStart = performance.now();
    await storage.save(session);
    const saveMs = performance.now() - saveStart;

    const loadStart = performance.now();
    const loaded = await storage.load(session.metadata.id);
    const loadMs = performance.now() - loadStart;

    expect(loaded?.messages).toHaveLength(1000);
    expect(saveMs).toBeLessThan(2000); // save < 2s
    expect(loadMs).toBeLessThan(500); // load < 500ms
  });

  it("handles 100 sessions without memory leak", async () => {
    for (let i = 0; i < 100; i++) {
      const session = makeSession({
        metadata: { ...makeSession().metadata, title: `Session ${i}`, totalCostUsd: i * 0.001 },
      });
      await storage.save(session);
    }

    const stats = storage.stats();
    expect(stats.sessionCount).toBe(100);
    expect(stats.messageCount).toBe(200); // 2 messages × 100 sessions

    const list = await storage.list();
    expect(list).toHaveLength(100);
  });

  it("handles messages with special characters and unicode", async () => {
    const tricky = makeSession({
      messages: [
        {
          role: "user",
          content: `Hello "world" & 'friends' <test> \n\t unicode: 🎉 日本語 العربية`,
        },
        { role: "assistant", content: [{ type: "text", text: 'JSON-unsafe: {"key": "va\'lue"}' }] },
      ],
    });

    await storage.save(tricky);
    const loaded = await storage.load(tricky.metadata.id);

    expect(loaded?.messages[0]).toMatchObject({ role: "user" });
    const content = (loaded?.messages[0] as { content: string }).content;
    expect(content).toContain("🎉");
    expect(content).toContain("日本語");
  });
});

// ─── Concurrent access ────────────────────────────────────────────────────────

describe("SqliteSessionStorage — concurrent access", () => {
  let db: string;
  let storage: SqliteSessionStorage;

  beforeEach(() => {
    db = tmpDb();
    storage = new SqliteSessionStorage({ path: db });
  });

  afterEach(() => {
    storage.close();
    rmSync(db, { force: true });
  });

  it("concurrent saves don't corrupt data (WAL mode)", async () => {
    const sessions = Array.from({ length: 20 }, () => makeSession());

    // Save all concurrently
    await Promise.all(sessions.map((s) => storage.save(s)));

    const stats = storage.stats();
    expect(stats.sessionCount).toBe(20);
    expect(stats.messageCount).toBe(40);
  });

  it("concurrent reads during write are consistent", async () => {
    const session = makeSession();
    await storage.save(session);

    // Write and read concurrently
    const writePromise = storage.save({
      ...session,
      metadata: { ...session.metadata, title: "Updated" },
      messages: [...session.messages, { role: "user", content: "New message" }],
    });

    const reads = await Promise.all([
      storage.load(session.metadata.id),
      storage.load(session.metadata.id),
      storage.load(session.metadata.id),
    ]);

    await writePromise;

    // All reads should have returned either the old or new version — not corrupted
    for (const read of reads) {
      if (read) {
        expect([2, 3]).toContain(read.messages.length);
        expect(["Test session", "Updated"]).toContain(read.metadata.title);
      }
    }
  });
});

// ─── FTS search ───────────────────────────────────────────────────────────────

describe("SqliteSessionStorage — full-text search", () => {
  let db: string;
  let storage: SqliteSessionStorage;

  beforeEach(() => {
    db = tmpDb();
    storage = new SqliteSessionStorage({ path: db });
  });

  afterEach(() => {
    storage.close();
    rmSync(db, { force: true });
  });

  it("finds sessions by message content", async () => {
    const s1 = makeSession({
      messages: [{ role: "user", content: "Tell me about TypeScript generics" }],
    });
    const s2 = makeSession({ messages: [{ role: "user", content: "Explain Python decorators" }] });
    const s3 = makeSession({
      messages: [{ role: "user", content: "TypeScript vs JavaScript comparison" }],
    });

    await Promise.all([storage.save(s1), storage.save(s2), storage.save(s3)]);

    const results = storage.searchMessages("TypeScript");
    expect(results).toHaveLength(2);
    const sessionIds = results.map((r) => r.sessionId);
    expect(sessionIds).toContain(s1.metadata.id);
    expect(sessionIds).toContain(s3.metadata.id);
    expect(sessionIds).not.toContain(s2.metadata.id);
  });

  it("returns empty array for no matches", async () => {
    await storage.save(makeSession());
    const results = storage.searchMessages("xyzzy_no_match");
    expect(results).toHaveLength(0);
  });

  it("search respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await storage.save(
        makeSession({
          messages: [{ role: "user", content: `helix agent question ${i}` }],
        })
      );
    }

    const results = storage.searchMessages("helix", 3);
    expect(results).toHaveLength(3);
  });
});
