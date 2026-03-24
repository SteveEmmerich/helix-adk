import { Database } from "bun:sqlite";
import { hostname } from "node:os";
import { type Result, err, ok } from "@helix/ai";
import type { VaultAuditEntry, VaultEntry } from "../types.js";
import { decryptValue, deriveKey, deriveSalt, encryptValue } from "./encryption.js";
import type { VaultConfig } from "./types.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS vault_credentials (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    description TEXT,
    tags TEXT,
    allowed_tools TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used INTEGER,
    use_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS vault_audit (
    id TEXT PRIMARY KEY,
    credential_id TEXT NOT NULL,
    action TEXT NOT NULL,
    tool_name TEXT,
    session_id TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_vault_name ON vault_credentials(name);
  CREATE INDEX IF NOT EXISTS idx_vault_audit_created ON vault_audit(created_at DESC);
`;

function now(): number {
  return Date.now();
}

function defaultPassphrase(): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "0";
  return `${hostname()}:${uid}`;
}

function parseJsonArray(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    return null;
  }
  return null;
}

function toJsonArray(value?: string[] | null): string | null {
  if (!value) return null;
  return JSON.stringify(value);
}

function walkAndReplace(value: unknown, replacer: (input: string) => string): unknown {
  if (typeof value === "string") return replacer(value);
  if (Array.isArray(value)) return value.map((item) => walkAndReplace(item, replacer));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const next: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      next[key] = walkAndReplace(item, replacer);
    }
    return next;
  }
  return value;
}

export class CredentialVault {
  readonly #db: Database;
  readonly #passphrase: string;
  #key: CryptoKey | null = null;
  #salt: string | null = null;

  constructor(config: VaultConfig = {}) {
    this.#db =
      config.sharedDb ??
      new Database(config.dbPath ?? `${process.env.HOME ?? ""}/.hlx/vault.db`, { create: true });
    this.#passphrase =
      config.passphrase ?? process.env.HELIX_VAULT_PASSPHRASE ?? defaultPassphrase();
  }

  get db(): Database {
    return this.#db;
  }

  async init(): Promise<void> {
    this.#db.exec(SCHEMA);
    const salt = deriveSalt(this.#passphrase);
    this.#salt = salt;
    this.#key = (await deriveKey(this.#passphrase, salt)).key;
    const test = await encryptValue(this.#key, "vault-test");
    const roundTrip = await decryptValue(this.#key, test);
    if (roundTrip !== "vault-test") {
      throw new Error("Vault encryption check failed");
    }
  }

  async store(
    name: string,
    value: string,
    opts: {
      type?: string;
      description?: string | null;
      tags?: string[] | null;
      allowedTools?: string[] | null;
    } = {}
  ): Promise<Result<string>> {
    if (!this.#key) return err(new Error("Vault not initialized"));
    const existing = this.#db.query("SELECT id FROM vault_credentials WHERE name = ?").get(name) as
      | { id: string }
      | undefined;
    if (existing) return err(new Error("Credential already exists"));
    const blob = await encryptValue(this.#key, value);
    const id = crypto.randomUUID();
    const createdAt = now();
    this.#db
      .query(
        "INSERT INTO vault_credentials (id, name, type, encrypted_value, description, tags, allowed_tools, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        id,
        name,
        opts.type ?? "other",
        JSON.stringify(blob),
        opts.description ?? null,
        toJsonArray(opts.tags),
        toJsonArray(opts.allowedTools),
        createdAt,
        createdAt
      );
    this.#audit(id, "created");
    return ok(id);
  }

  async retrieve(name: string, toolName?: string): Promise<Result<string>> {
    if (!this.#key) return err(new Error("Vault not initialized"));
    const row = this.#db.query("SELECT * FROM vault_credentials WHERE name = ?").get(name) as
      | Record<string, unknown>
      | undefined;
    if (!row) return err(new Error("Credential not found"));

    const allowed = parseJsonArray((row.allowed_tools as string | null) ?? null);
    if (allowed && toolName && !allowed.includes(toolName)) {
      this.#audit(String(row.id), "denied", toolName);
      return err(new Error(`Credential not allowed for tool ${toolName}`));
    }

    const blob = JSON.parse(String(row.encrypted_value)) as {
      iv: string;
      ciphertext: string;
      authTag: string;
    };
    let value: string;
    try {
      value = await decryptValue(this.#key, blob);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
    const lastUsed = now();
    const useCount = Number(row.use_count ?? 0) + 1;
    this.#db
      .query(
        "UPDATE vault_credentials SET last_used = ?, use_count = ?, updated_at = ? WHERE id = ?"
      )
      .run(lastUsed, useCount, lastUsed, row.id as string);
    this.#audit(String(row.id), "injected", toolName);
    return ok(value);
  }

  async delete(name: string): Promise<Result<void>> {
    const row = this.#db.query("SELECT id FROM vault_credentials WHERE name = ?").get(name) as
      | { id: string }
      | undefined;
    if (!row) return err(new Error("Credential not found"));
    this.#db.query("DELETE FROM vault_credentials WHERE id = ?").run(row.id);
    this.#audit(row.id, "deleted");
    return ok(undefined);
  }

  async rotate(name: string, newValue: string): Promise<Result<void>> {
    if (!this.#key) return err(new Error("Vault not initialized"));
    const row = this.#db.query("SELECT id FROM vault_credentials WHERE name = ?").get(name) as
      | { id: string }
      | undefined;
    if (!row) return err(new Error("Credential not found"));
    const blob = await encryptValue(this.#key, newValue);
    const updatedAt = now();
    this.#db
      .query("UPDATE vault_credentials SET encrypted_value = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(blob), updatedAt, row.id);
    this.#audit(row.id, "updated");
    return ok(undefined);
  }

  list(): VaultEntry[] {
    const rows = this.#db
      .query(
        "SELECT id, name, type, description, tags, allowed_tools, created_at, updated_at, last_used, use_count FROM vault_credentials ORDER BY name ASC"
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      type: row.type as VaultEntry["type"],
      description: (row.description as string | null) ?? null,
      tags: parseJsonArray((row.tags as string | null) ?? null),
      allowedTools: parseJsonArray((row.allowed_tools as string | null) ?? null),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastUsed: row.last_used ? Number(row.last_used) : null,
      useCount: Number(row.use_count ?? 0),
    }));
  }

  async inject(toolInput: unknown, toolName: string): Promise<unknown> {
    if (!this.#key) return toolInput;
    const pattern = /\{\{([a-zA-Z0-9_-]+)\}\}/g;
    const names = new Set<string>();

    const collect = (value: unknown) => {
      if (typeof value === "string") {
        for (const match of value.matchAll(pattern)) {
          const name = match[1];
          if (name) names.add(name);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          collect(item);
        }
        return;
      }
      if (value && typeof value === "object") {
        for (const item of Object.values(value as Record<string, unknown>)) {
          collect(item);
        }
      }
    };

    collect(toolInput);
    if (names.size === 0) return toolInput;

    const replacements = new Map<string, string>();
    for (const name of names) {
      const result = await this.retrieve(name, toolName);
      if (result.ok) replacements.set(name, result.value);
    }

    const replaced = walkAndReplace(toolInput, (input) =>
      input.replace(pattern, (match, name) => replacements.get(String(name)) ?? match)
    );
    return replaced;
  }

  audit(limit = 50): VaultAuditEntry[] {
    const rows = this.#db
      .query("SELECT * FROM vault_audit ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      credentialId: String(row.credential_id),
      action: row.action as VaultAuditEntry["action"],
      toolName: (row.tool_name as string | null) ?? null,
      sessionId: (row.session_id as string | null) ?? null,
      createdAt: Number(row.created_at),
    }));
  }

  #audit(
    credentialId: string,
    action: VaultAuditEntry["action"],
    toolName?: string | null,
    sessionId?: string | null
  ) {
    this.#db
      .query(
        "INSERT INTO vault_audit (id, credential_id, action, tool_name, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(crypto.randomUUID(), credentialId, action, toolName ?? null, sessionId ?? null, now());
  }
}
