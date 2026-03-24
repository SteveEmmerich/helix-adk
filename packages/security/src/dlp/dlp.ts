import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { AllowlistManager } from "../detection/allowlist.js";
import { redact } from "../detection/redactor.js";
import type { LeakScanner } from "../detection/scanner.js";
import type {
  DLPApprovalDecision,
  DLPConfig,
  DLPResult,
  LeakApprovalRequest,
  LeakType,
} from "../types.js";

export interface LeakNotifier {
  readonly id: string;
  notify(request: LeakApprovalRequest): Promise<void>;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS leak_approvals (
    id TEXT PRIMARY KEY,
    tool_name TEXT NOT NULL,
    direction TEXT NOT NULL,
    leak_types TEXT NOT NULL,
    preview TEXT NOT NULL,
    original_hash TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_leak_status ON leak_approvals(status);
  CREATE INDEX IF NOT EXISTS idx_leak_created ON leak_approvals(created_at DESC);
`;

function now(): number {
  return Date.now();
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value).redacted;
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const next: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      next[key] = redactValue(item);
    }
    return next;
  }
  return value;
}

function stringifyForScan(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class DLP {
  readonly #scanner: LeakScanner;
  readonly #allowlist: AllowlistManager;
  readonly #db: Database;
  readonly #timeoutMs: number;
  readonly #notifiers: LeakNotifier[] = [];
  readonly #pending = new Map<string, { resolve: (value: DLPApprovalDecision) => void }>();
  readonly #preResolved = new Map<string, DLPApprovalDecision>();

  constructor(
    scanner: LeakScanner,
    allowlist: AllowlistManager,
    config: DLPConfig & { db: Database }
  ) {
    this.#scanner = scanner;
    this.#allowlist = allowlist;
    this.#db = config.db;
    this.#timeoutMs = config.timeoutMs ?? 120_000;
    this.#db.exec(SCHEMA);
  }

  addNotifier(notifier: LeakNotifier): void {
    this.#notifiers.push(notifier);
  }

  pending(): LeakApprovalRequest[] {
    const rows = this.#db
      .query("SELECT * FROM leak_approvals WHERE status = 'pending' ORDER BY created_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.#rowToRequest(row));
  }

  history(limit = 50): LeakApprovalRequest[] {
    const rows = this.#db
      .query("SELECT * FROM leak_approvals ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.#rowToRequest(row));
  }

  async scanInput(toolName: string, input: unknown, sessionId: string): Promise<DLPResult> {
    return this.#scan(toolName, input, sessionId, "input");
  }

  async scanOutput(toolName: string, output: unknown, sessionId: string): Promise<DLPResult> {
    return this.#scan(toolName, output, sessionId, "output");
  }

  async waitForApproval(
    request: LeakApprovalRequest,
    redactedValue?: unknown
  ): Promise<DLPApprovalDecision> {
    const preResolved = this.#preResolved.get(request.id);
    if (preResolved) return preResolved;

    const result = await new Promise<DLPApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        const decision: DLPApprovalDecision = {
          useRedacted: true,
          status: "timeout",
        };
        this.#markResolved(request.id, "timeout");
        resolve(decision);
      }, this.#timeoutMs);

      this.#pending.set(request.id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });

    if (result.status === "timeout") {
      // prefer redacted when timing out
      if (redactedValue !== undefined) {
        return result;
      }
    }
    return result;
  }

  approveRedacted(id: string): void {
    this.#resolve(id, { useRedacted: true, status: "approved_redacted" });
  }

  approveOriginal(id: string): void {
    this.#resolve(id, { useRedacted: false, status: "approved_original" });
  }

  addToAllowlist(id: string): void {
    const request = this.#loadRequest(id);
    for (const leakType of request.leakTypes) {
      this.#allowlist.allow(request.toolName, leakType, request.preview);
    }
    this.#resolve(id, { useRedacted: false, status: "added_to_allowlist" });
  }

  deny(id: string): void {
    this.#resolve(id, { useRedacted: true, status: "denied" });
  }

  #resolve(id: string, decision: DLPApprovalDecision): void {
    this.#markResolved(id, decision.status);
    const pending = this.#pending.get(id);
    if (pending) {
      pending.resolve(decision);
      this.#pending.delete(id);
      return;
    }
    this.#preResolved.set(id, decision);
  }

  async #scan(
    toolName: string,
    value: unknown,
    sessionId: string,
    direction: "input" | "output"
  ): Promise<DLPResult> {
    const text = stringifyForScan(value);
    const scan = this.#scanner.scan(text, { toolName, sessionId, direction });
    if (!scan.hasMatches) {
      return { clean: true, matches: [], requiresApproval: false };
    }

    const leakTypes = Array.from(new Set(scan.matches.map((m) => m.type)));
    const allAllowed = leakTypes.every((type) => this.#allowlist.isAllowed(toolName, type));
    if (allAllowed) {
      return { clean: true, matches: scan.matches, requiresApproval: false };
    }

    const redactedValue = redactValue(value);
    const preview = this.#buildPreview(text);
    const approval = this.#createRequest(toolName, direction, leakTypes, preview, text, sessionId);
    await this.#notify(approval);

    return {
      clean: false,
      redactedValue,
      matches: scan.matches,
      requiresApproval: true,
      approvalRequest: approval,
    };
  }

  #buildPreview(text: string): string {
    const redacted = redact(text).redacted;
    return redacted.slice(0, 200);
  }

  #createRequest(
    toolName: string,
    direction: "input" | "output",
    leakTypes: LeakType[],
    preview: string,
    original: string,
    sessionId: string
  ): LeakApprovalRequest {
    const id = crypto.randomUUID();
    const createdAt = now();
    const originalHash = createHash("sha256").update(original).digest("hex");
    const request: LeakApprovalRequest = {
      id,
      toolName,
      direction,
      leakTypes,
      preview,
      originalHash,
      sessionId,
      createdAt,
      status: "pending",
    };

    this.#db
      .query(
        "INSERT INTO leak_approvals (id, tool_name, direction, leak_types, preview, original_hash, session_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        request.id,
        request.toolName,
        request.direction,
        JSON.stringify(request.leakTypes),
        request.preview,
        request.originalHash,
        request.sessionId,
        request.status,
        request.createdAt
      );

    return request;
  }

  #markResolved(id: string, status: LeakApprovalRequest["status"]): void {
    this.#db.query("UPDATE leak_approvals SET status = ? WHERE id = ?").run(status, id);
  }

  #loadRequest(id: string): LeakApprovalRequest {
    const row = this.#db.query("SELECT * FROM leak_approvals WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error("Leak approval not found");
    return this.#rowToRequest(row);
  }

  async #notify(request: LeakApprovalRequest): Promise<void> {
    await Promise.allSettled(this.#notifiers.map((n) => n.notify(request)));
  }

  #rowToRequest(row: Record<string, unknown>): LeakApprovalRequest {
    return {
      id: String(row.id),
      toolName: String(row.tool_name),
      direction: row.direction as LeakApprovalRequest["direction"],
      leakTypes: JSON.parse(String(row.leak_types ?? "[]")) as LeakType[],
      preview: String(row.preview),
      originalHash: String(row.original_hash),
      sessionId: (row.session_id as string | null) ?? null,
      createdAt: Number(row.created_at),
      status: row.status as LeakApprovalRequest["status"],
    };
  }
}
