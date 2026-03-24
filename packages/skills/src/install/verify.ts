import { existsSync } from "node:fs";
import { join } from "node:path";
import * as sigstore from "sigstore";
import type { VerifyResult } from "../types.js";

export async function verify(skillPath: string): Promise<VerifyResult> {
  const bundle = ["skill.bundle", "skill.sigstore"].map((f) => join(skillPath, f)).find(existsSync);
  if (!bundle) {
    return {
      verified: false,
      issuer: null,
      sourceRepo: null,
      buildTrigger: null,
      transparency_log_url: null,
      error: null,
    };
  }

  try {
    const result = await sigstore.verify({ bundlePath: bundle, artifactPath: skillPath });
    const cert = result?.verification?.cert || null;
    return {
      verified: true,
      issuer: cert?.issuer ?? null,
      sourceRepo: cert?.sourceRepositoryURI ?? null,
      buildTrigger: cert?.buildTrigger ?? null,
      transparency_log_url: result?.tlogEntry?.logId?.keyId ?? null,
      error: null,
    };
  } catch (e) {
    return {
      verified: false,
      issuer: null,
      sourceRepo: null,
      buildTrigger: null,
      transparency_log_url: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
