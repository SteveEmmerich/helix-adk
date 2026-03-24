import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { InstallOptions, InstallResult, SkillManifest } from "../types.js";
import { cleanupTemp, fetchSkill } from "./fetch.js";
import { writeManifest } from "./manifest.js";
import { scan } from "./scan.js";
import { resolveTier } from "./tiers.js";
import { verify } from "./verify.js";

function registryDir(): string {
  return resolve(homedir(), ".hlx", "skills", "registry");
}

export async function install(source: string, opts: InstallOptions = {}): Promise<InstallResult> {
  const fetchResult = await fetchSkill(source);
  const tempDir = fetchResult.tempDir;
  const verifyResult = await verify(tempDir);
  const scanResult = await scan(tempDir);
  const tier = resolveTier(tempDir, verifyResult, source);

  if ((tier === "CORE" || tier === "VERIFIED") && !verifyResult.verified) {
    await cleanupTemp(tempDir);
    return {
      ok: false,
      skillId: fetchResult.skillId,
      tier,
      verifyResult,
      scanResult,
      installedPath: "",
      error: "Verification required for CORE/VERIFIED tiers",
    };
  }

  if (!scanResult.passed && !opts.force) {
    await cleanupTemp(tempDir);
    return {
      ok: false,
      skillId: fetchResult.skillId,
      tier,
      verifyResult,
      scanResult,
      installedPath: "",
      error: "Static analysis failed",
    };
  }

  if (tier === "UNVERIFIED" && opts.tier !== "UNVERIFIED") {
    await cleanupTemp(tempDir);
    return {
      ok: false,
      skillId: fetchResult.skillId,
      tier,
      verifyResult,
      scanResult,
      installedPath: "",
      error: "UNVERIFIED tier requires --tier=unverified",
    };
  }

  const destRoot = opts.registryDir ? resolve(opts.registryDir) : registryDir();
  await mkdir(destRoot, { recursive: true });
  const dest = join(destRoot, fetchResult.skillId);
  await cp(tempDir, dest, { recursive: true });

  const manifest: SkillManifest = {
    installedAt: Date.now(),
    source,
    tier,
    verifyResult,
    scanResult,
    version: fetchResult.version ?? "0.0.0",
  };
  await writeManifest(dest, manifest);

  await cleanupTemp(tempDir);

  return {
    ok: true,
    skillId: fetchResult.skillId,
    tier,
    verifyResult,
    scanResult,
    installedPath: dest,
    error: null,
  };
}
