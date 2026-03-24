import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "@helix/ai";
import { load as loadYaml } from "js-yaml";
import { readManifest } from "../install/manifest.js";
import { scan } from "../install/scan.js";
import { resolveTier } from "../install/tiers.js";
import type {
  SandboxCapabilities,
  SandboxResult,
  SkillContext,
  SkillFrontmatter,
  SkillLoaderConfig,
  SkillSummary,
} from "../types.js";
import { SkillExecutor, ToolRegistryProxy } from "./executor.js";

function defaultDirs(
  cwd: string,
  overrides?: {
    builtinsDir?: string;
    projectDir?: string;
    globalDir?: string;
    registryDir?: string;
  }
) {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return {
    builtins: overrides?.builtinsDir ?? resolve(currentDir, "..", "builtins"),
    project: overrides?.projectDir ?? resolve(cwd, ".hlx", "skills"),
    global: overrides?.globalDir ?? resolve(homedir(), ".hlx", "skills"),
    registry: overrides?.registryDir ?? resolve(homedir(), ".hlx", "skills", "registry"),
  };
}

function parseFrontmatter(raw: string): SkillFrontmatter | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;
  try {
    const data = loadYaml(match[1]) as SkillFrontmatter;
    return data ?? null;
  } catch (e) {
    console.error("[skills] Failed to parse SKILL.md frontmatter:", e);
    return null;
  }
}

async function loadSkillMd(
  skillPath: string
): Promise<{ frontmatter: SkillFrontmatter | null; content: string } | null> {
  const path = join(skillPath, "SKILL.md");
  try {
    const content = await readFile(path, "utf-8");
    return { frontmatter: parseFrontmatter(content), content };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code && code !== "ENOENT") {
      console.error(`[skills] Failed to read SKILL.md at ${path}:`, e);
    }
    return null;
  }
}

async function listSkillDirs(root: string): Promise<string[]> {
  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) return [];
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code && code !== "ENOENT") {
      console.error(`[skills] Failed to list skill directories: ${root}`, e);
    }
    return [];
  }
}

async function listScripts(skillPath: string): Promise<string[] | undefined> {
  const scriptsDir = join(skillPath, "scripts");
  try {
    const entries = await readdir(scriptsDir, { withFileTypes: true });
    const scripts = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    return scripts.length > 0 ? scripts : [];
  } catch {
    return undefined;
  }
}

function hasDir(path: string): Promise<boolean> {
  return stat(path)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

export class SkillLoader {
  readonly #config: SkillLoaderConfig;
  readonly #executor: SkillExecutor;

  constructor(config: SkillLoaderConfig = {}) {
    this.#config = config;
    this.#executor = new SkillExecutor();
  }

  async discover(): Promise<SkillSummary[]> {
    const cwd = this.#config.cwd ?? process.cwd();
    const dirs = defaultDirs(cwd, this.#config);
    const layers = [dirs.builtins, dirs.project, dirs.global, dirs.registry];
    const summaries = new Map<string, SkillSummary>();

    for (const layer of layers) {
      const skillDirs = await listSkillDirs(layer);
      for (const dir of skillDirs) {
        const skill = await loadSkillMd(dir);
        if (!skill?.frontmatter) continue;
        const id = basename(dir);
        const tier = resolveTier(dir, {
          verified: false,
          issuer: null,
          sourceRepo: null,
          buildTrigger: null,
          transparency_log_url: null,
          error: null,
        });
        const manifest = await readManifest(dir);
        const scripts = await listScripts(dir);
        summaries.set(id, {
          id,
          name: skill.frontmatter.name,
          description: skill.frontmatter.description,
          tier: manifest?.tier ?? tier,
          version: skill.frontmatter.version,
          source: manifest?.source,
          installedAt: manifest?.installedAt,
          lastUsedAt: undefined,
          tags: skill.frontmatter.tags,
          allowedTools: skill.frontmatter["allowed-tools"],
          requiresApproval: skill.frontmatter.requires_approval,
          scripts,
          scan: manifest?.scanResult,
          verify: manifest?.verifyResult,
        });
      }
    }

    return Array.from(summaries.values());
  }

  async activate(skillId: string): Promise<SkillContext> {
    const skillPath = await this.resolveSkillPath(skillId);
    const skill = await loadSkillMd(skillPath);
    if (!skill?.frontmatter) throw new Error(`SKILL.md missing for ${skillId}`);

    const hasScripts = await hasDir(join(skillPath, "scripts"));
    const hasReferences = await hasDir(join(skillPath, "references"));

    return {
      id: skillId,
      name: skill.frontmatter.name,
      instructions: skill.content,
      allowedTools: skill.frontmatter["allowed-tools"],
      requiresApproval: skill.frontmatter.requires_approval,
      hasScripts,
      hasReferences,
    };
  }

  async loadReference(skillId: string, file: string): Promise<string> {
    const skillPath = await this.resolveSkillPath(skillId);
    const refRoot = join(skillPath, "references");
    const resolved = resolve(refRoot, file);
    if (!resolved.startsWith(refRoot)) {
      throw new Error("Invalid reference path");
    }
    return readFile(resolved, "utf-8");
  }

  async execute(args: {
    skillId: string;
    script: string;
    input: unknown;
    tools: readonly ToolDefinition[];
    capabilities?: SandboxCapabilities;
  }): Promise<SandboxResult> {
    const skillPath = await this.resolveSkillPath(args.skillId);
    const context = await this.activate(args.skillId);
    if (args.capabilities?.tools && args.capabilities.tools.length > 0) {
      const proxy = new ToolRegistryProxy(args.skillId, args.tools, context.allowedTools);
      for (const toolName of args.capabilities.tools) {
        proxy.get(toolName);
      }
    }
    return this.#executor.runScript(
      skillPath,
      args.script,
      args.input,
      context,
      args.capabilities ?? {}
    );
  }

  async audit(): Promise<SkillSummary[]> {
    const skills = await this.discover();
    const audited: SkillSummary[] = [];
    for (const skill of skills) {
      try {
        const path = await this.resolveSkillPath(skill.id);
        const scanResult = await scan(path);
        audited.push({ ...skill, scan: scanResult });
      } catch {
        audited.push(skill);
      }
    }
    return audited;
  }

  async resolveSkillPath(skillId: string): Promise<string> {
    const cwd = this.#config.cwd ?? process.cwd();
    const dirs = defaultDirs(cwd, this.#config);
    const candidates = [
      join(dirs.project, skillId),
      join(dirs.global, skillId),
      join(dirs.registry, skillId),
      join(dirs.builtins, skillId),
    ];
    for (const path of candidates) {
      try {
        const statInfo = await stat(path);
        if (statInfo.isDirectory()) return path;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code && code !== "ENOENT") {
          console.error(`[skills] Failed to stat skill path ${path}:`, e);
        }
      }
    }
    throw new Error(`Skill not found: ${skillId}`);
  }
}
