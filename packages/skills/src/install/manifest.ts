import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillManifest } from "../types.js";

const MANIFEST = ".helix-skill.json";

export async function writeManifest(skillPath: string, manifest: SkillManifest): Promise<void> {
  const path = join(skillPath, MANIFEST);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

export async function readManifest(skillPath: string): Promise<SkillManifest | null> {
  const path = join(skillPath, MANIFEST);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as SkillManifest;
  } catch {
    return null;
  }
}
