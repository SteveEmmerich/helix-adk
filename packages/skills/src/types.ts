import type { Result } from "@helix/ai";

export type SkillTier = "CORE" | "VERIFIED" | "COMMUNITY" | "UNVERIFIED";

export interface SkillFrontmatter {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  "allowed-tools": string[];
  requires_approval: string[];
  network: boolean;
  tags: string[];
  "min-helix-version": string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  tier: SkillTier;
  version?: string;
  source?: string;
  installedAt?: number;
  lastUsedAt?: number;
  tags?: string[];
  allowedTools?: string[];
  requiresApproval?: string[];
  scripts?: string[];
  scan?: ScanResult;
  verify?: VerifyResult;
}

export interface SkillContext {
  id: string;
  name: string;
  instructions: string;
  allowedTools: string[];
  requiresApproval: string[];
  hasScripts: boolean;
  hasReferences: boolean;
}

export interface SkillLoaderConfig {
  cwd?: string;
  builtinsDir?: string;
  projectDir?: string;
  globalDir?: string;
  registryDir?: string;
}

export interface VerifyResult {
  verified: boolean;
  issuer: string | null;
  sourceRepo: string | null;
  buildTrigger: string | null;
  transparency_log_url: string | null;
  error: string | null;
}

export interface ScanWarning {
  code: string;
  message: string;
  file?: string;
}

export interface ScanError {
  code: string;
  message: string;
  file?: string;
}

export interface ScanResult {
  passed: boolean;
  warnings: ScanWarning[];
  errors: ScanError[];
  filesScanned: number;
}

export interface SandboxCapabilities {
  filesystem?: {
    read: string[];
    write: string[];
  };
  network?: {
    allowedDomains: string[];
    allowedPorts: number[];
  };
  tools?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  memoryMb?: number;
}

export interface SandboxResult {
  success: boolean;
  output: unknown;
  logs: string[];
  error: string | null;
  durationMs: number;
  resourceUsage: {
    memoryMb: number;
    cpuMs: number;
  };
}

export interface InstallOptions {
  tier?: SkillTier;
  force?: boolean;
  cwd?: string;
  registryUrl?: string;
  registryDir?: string;
}

export interface InstallResult {
  ok: boolean;
  skillId: string;
  tier: SkillTier;
  verifyResult: VerifyResult;
  scanResult: ScanResult;
  installedPath: string;
  error: string | null;
}

export interface SkillManifest {
  installedAt: number;
  source: string;
  tier: SkillTier;
  verifyResult: VerifyResult;
  scanResult: ScanResult;
  version: string;
}

export class SkillPermissionError extends Error {
  readonly skillId: string;
  readonly toolName: string;

  constructor(skillId: string, toolName: string) {
    super(`Skill ${skillId} is not allowed to call tool ${toolName}`);
    this.skillId = skillId;
    this.toolName = toolName;
  }
}

export type SkillsResult<T> = Result<T>;
