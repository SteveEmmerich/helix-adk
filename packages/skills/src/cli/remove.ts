import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function runRemove(skillId: string) {
  const path = join(homedir(), ".hlx", "skills", "registry", skillId);
  await rm(path, { recursive: true, force: true });
  return { ok: true };
}
