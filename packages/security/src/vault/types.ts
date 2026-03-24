import type { Database } from "bun:sqlite";
import type { CredentialType } from "../types.js";

export interface Credential {
  readonly id: string;
  readonly name: string;
  readonly type: CredentialType;
  readonly encryptedValue: string;
  readonly description?: string | null;
  readonly tags?: string[] | null;
  readonly allowedTools?: string[] | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastUsed?: number | null;
  readonly useCount: number;
}

export interface VaultConfig {
  readonly dbPath?: string;
  readonly passphrase?: string;
  readonly sharedDb?: Database;
}
