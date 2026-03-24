import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface FetchResult {
  tempDir: string;
  source: string;
  skillId: string;
  version?: string;
}

function isRegistrySource(source: string): boolean {
  return source.startsWith("@") && !source.includes(":") && !source.startsWith("./");
}

function isGitHubSource(source: string): boolean {
  return source.startsWith("github:");
}

function isLocalPath(source: string): boolean {
  return source.startsWith("./") || source.startsWith("/");
}

export async function fetchSkill(source: string): Promise<FetchResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "helix-skill-"));

  if (isLocalPath(source)) {
    const resolved = resolve(source);
    await cp(resolved, tempDir, { recursive: true });
    return { tempDir, source, skillId: resolve(resolved).split("/").pop() ?? "local" };
  }

  if (isGitHubSource(source)) {
    const ref = source.replace("github:", "");
    const [repo, hash] = ref.split("#");
    const repoUrl = `https://github.com/${repo}.git`;
    const cloneDir = join(tempDir, "repo");
    const args = ["git", "clone", "--depth", "1", repoUrl, cloneDir];
    await Bun.spawn(args, { stdout: "ignore", stderr: "ignore" }).exited;
    if (hash) {
      await Bun.spawn(["git", "-C", cloneDir, "checkout", hash], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    }
    await cp(cloneDir, tempDir, { recursive: true });
    return { tempDir, source, skillId: repo.split("/").pop() ?? "github" };
  }

  if (isRegistrySource(source)) {
    // Placeholder for registry fetch — create dir and assume skillId is source without version
    const skillId = source.split("@")[0]?.replace("@", "") ?? source;
    return { tempDir, source, skillId };
  }

  return { tempDir, source, skillId: source };
}

export async function cleanupTemp(path: string): Promise<void> {
  if (existsSync(path)) await rm(path, { recursive: true, force: true });
}
