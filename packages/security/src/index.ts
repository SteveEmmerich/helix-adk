export type {
  AllowlistEntry,
  CredentialType,
  DLPApprovalDecision,
  DLPResult,
  LeakApprovalRequest,
  LeakType,
  ScanContext,
  ScanMatch,
  ScanResult,
  VaultAuditEntry,
  VaultEntry,
  SecurityConfig,
} from "./types.js";
export { CredentialVault } from "./vault/vault.js";
export { deriveKey, deriveSalt, encryptValue, decryptValue } from "./vault/encryption.js";
export type { VaultConfig } from "./vault/types.js";
export { LeakScanner } from "./detection/scanner.js";
export { redact } from "./detection/redactor.js";
export { LEAK_PATTERNS, isValidLuhn } from "./detection/patterns.js";
export { AllowlistManager } from "./detection/allowlist.js";
export { DLP } from "./dlp/dlp.js";
export { DEFAULT_DLP_TIMEOUT_MS } from "./dlp/rules.js";
export { createSecurityMiddleware } from "./middleware/core-middleware.js";
export { wrapToolWithSecurity } from "./middleware/tool-wrapper.js";
