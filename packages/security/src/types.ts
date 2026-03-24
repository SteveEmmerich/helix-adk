import type { Database } from "bun:sqlite";
import type { Result } from "@helix/ai";

export type CredentialType =
  | "api_key"
  | "password"
  | "token"
  | "private_key"
  | "certificate"
  | "other";

export type LeakType =
  | "api_key"
  | "bearer_token"
  | "password"
  | "pii_email"
  | "pii_phone"
  | "pii_ssn"
  | "credit_card"
  | "private_key"
  | "certificate"
  | "jwt"
  | "aws_key"
  | "github_token";

export interface VaultEntry {
  readonly id: string;
  readonly name: string;
  readonly type: CredentialType;
  readonly description?: string | null;
  readonly tags?: string[] | null;
  readonly allowedTools?: string[] | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastUsed?: number | null;
  readonly useCount: number;
}

export interface VaultAuditEntry {
  readonly id: string;
  readonly credentialId: string;
  readonly action: "created" | "read" | "updated" | "deleted" | "injected" | "denied";
  readonly toolName?: string | null;
  readonly sessionId?: string | null;
  readonly createdAt: number;
}

export interface CredentialVaultConfig {
  readonly dbPath?: string;
  readonly passphrase?: string;
  readonly sharedDb?: Database;
}

export interface ScanContext {
  readonly toolName?: string;
  readonly sessionId?: string;
  readonly direction: "input" | "output";
}

export interface ScanMatch {
  readonly type: LeakType;
  readonly preview: string;
  readonly position: number;
  readonly pattern: string;
}

export interface ScanResult {
  readonly matches: ScanMatch[];
  readonly hasMatches: boolean;
}

export interface RedactResult {
  readonly redacted: string;
  readonly matches: ScanMatch[];
  readonly wasModified: boolean;
}

export interface AllowlistEntry {
  readonly id: string;
  readonly toolName: string;
  readonly leakType: LeakType;
  readonly patternHint?: string | null;
  readonly createdAt: number;
}

export interface LeakApprovalRequest {
  readonly id: string;
  readonly toolName: string;
  readonly direction: "input" | "output";
  readonly leakTypes: LeakType[];
  readonly preview: string;
  readonly originalHash: string;
  readonly sessionId?: string | null;
  readonly createdAt: number;
  readonly status:
    | "pending"
    | "approved_redacted"
    | "approved_original"
    | "added_to_allowlist"
    | "denied"
    | "timeout";
}

export interface DLPResult {
  readonly clean: boolean;
  readonly redactedValue?: unknown;
  readonly matches: ScanMatch[];
  readonly requiresApproval: boolean;
  readonly approvalRequest?: LeakApprovalRequest;
}

export interface DLPConfig {
  readonly timeoutMs?: number;
}

export interface DLPApprovalDecision {
  readonly useRedacted: boolean;
  readonly status:
    | "approved_redacted"
    | "approved_original"
    | "added_to_allowlist"
    | "denied"
    | "timeout";
}

export interface SecurityConfig {
  readonly vault?: { inject(toolInput: unknown, toolName: string): Promise<unknown> };
  readonly dlp?: {
    scanInput(toolName: string, input: unknown, sessionId: string): Promise<DLPResult>;
    scanOutput(toolName: string, output: unknown, sessionId: string): Promise<DLPResult>;
    waitForApproval(
      request: LeakApprovalRequest,
      redactedValue?: unknown
    ): Promise<DLPApprovalDecision>;
  };
  readonly scanToolInputs?: boolean;
  readonly scanToolOutputs?: boolean;
}

export type SecurityResult<T> = Result<T>;
