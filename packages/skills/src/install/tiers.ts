import type { SkillTier, VerifyResult } from "../types.js";

export function resolveTier(
  skillPath: string,
  verifyResult: VerifyResult,
  source?: string
): SkillTier {
  if (skillPath.includes("/builtins/")) return "CORE";
  if (verifyResult.verified) return "VERIFIED";
  if (source?.startsWith("github:")) return "UNVERIFIED";
  if (skillPath.includes("/registry/")) return "COMMUNITY";
  return "UNVERIFIED";
}
