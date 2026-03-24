/**
 * Helix config loader
 *
 * THE BUG: `import(pathToFileURL(path).href)` fails for `.ts` files at runtime
 * because Node.js can't execute TypeScript natively (without --experimental-strip-types
 * in Node 22.6+ or a loader like tsx).
 *
 * THE FIX: A layered strategy:
 * 1. If a compiled `.js` version exists alongside the `.ts`, use that (built project)
 * 2. If `tsx` is available in PATH or node_modules, use it to transpile on-the-fly
 * 3. If running under tsx already (process has tsx loader), direct import works
 * 4. Fall back to JSON config (`hlx.config.json`) which always works
 * 5. If nothing works, return empty config — never hard crash on missing config
 *
 * This means `hlx` works:
 * - In dev:        tsx watches src, config.ts is transpiled on-the-fly
 * - After build:   config.ts → config.js is compiled, direct import
 * - No typescript: hlx.config.json as escape hatch
 * - Global install: tsx peer dep handles transpilation
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HelixConfig } from "../extensions/types.js";

// ─── Detect runtime environment ───────────────────────────────────────────────

function isRunningUnderTsx(): boolean {
  // tsx injects itself into NODE_OPTIONS or sets a specific env var
  const nodeOpts = process.env.NODE_OPTIONS ?? "";
  const execArgv = process.execArgv.join(" ");
  return (
    nodeOpts.includes("tsx") ||
    execArgv.includes("tsx") ||
    // tsx sets this when used as a loader
    typeof (process as Record<string, unknown>).__tsx === "object"
  );
}

function findTsx(cwd: string): string | undefined {
  // Check local node_modules first
  const local = join(cwd, "node_modules", ".bin", "tsx");
  if (existsSync(local)) return local;

  // Check global
  try {
    const which = execSync("which tsx 2>/dev/null", { encoding: "utf-8" }).trim();
    if (which) return which;
  } catch (e) {
    console.error("[hlx:config] Failed to locate tsx:", e);
  }

  return undefined;
}

// ─── Strategy implementations ─────────────────────────────────────────────────

async function tryCompiledJs(tsPath: string): Promise<Partial<HelixConfig> | undefined> {
  // If foo.ts exists, check for foo.js next to it
  const jsPath = tsPath.replace(/\.ts$/, ".js");
  if (!existsSync(jsPath)) return undefined;

  try {
    const mod = (await import(`${pathToFileURL(jsPath).href}?t=${Date.now()}`)) as {
      default?: Partial<HelixConfig>;
    };
    return mod.default ?? {};
  } catch (e) {
    console.error(`[hlx:config] Failed to import compiled config: ${jsPath}`, e);
    return undefined;
  }
}

async function tryDirectImport(path: string): Promise<Partial<HelixConfig> | undefined> {
  // Works when: running under tsx, Node 22.6+ with --experimental-strip-types,
  // or importing a .js file in any case
  try {
    const mod = (await import(`${pathToFileURL(path).href}?t=${Date.now()}`)) as {
      default?: Partial<HelixConfig>;
    };
    return mod.default ?? {};
  } catch (e) {
    console.error(`[hlx:config] Failed to import config: ${path}`, e);
    return undefined;
  }
}

async function tryTsxTranspile(
  tsPath: string,
  cwd: string
): Promise<Partial<HelixConfig> | undefined> {
  const tsx = findTsx(cwd);
  if (!tsx) return undefined;

  // Use tsx to evaluate the config file and print JSON to stdout
  const wrapper = `
    import config from ${JSON.stringify(tsPath)};
    process.stdout.write(JSON.stringify(config ?? {}));
  `;

  try {
    const { execFileSync } = await import("node:child_process");
    const output = execFileSync(tsx, ["--input-type=module"], {
      input: wrapper,
      encoding: "utf-8",
      cwd,
      timeout: 10_000,
      env: { ...process.env, HELIX_CONFIG_EVAL: "1" },
    });
    return JSON.parse(output) as Partial<HelixConfig>;
  } catch (e) {
    console.error(`[hlx:config] Failed to transpile config via tsx: ${tsPath}`, e);
    return undefined;
  }
}

async function tryJsonConfig(jsonPath: string): Promise<Partial<HelixConfig> | undefined> {
  if (!existsSync(jsonPath)) return undefined;
  try {
    const raw = await readFile(jsonPath, "utf-8");
    return JSON.parse(raw) as Partial<HelixConfig>;
  } catch (e) {
    console.error(`[hlx:config] Failed to read JSON config: ${jsonPath}`, e);
    return undefined;
  }
}

// ─── Main loader ──────────────────────────────────────────────────────────────

export async function loadConfig(cwd: string): Promise<Partial<HelixConfig>> {
  const candidates = [
    { ts: join(cwd, "hlx.config.ts"), json: join(cwd, "hlx.config.json") },
    { ts: join(cwd, ".hlx", "config.ts"), json: join(cwd, ".hlx", "config.json") },
  ];

  for (const { ts, json } of candidates) {
    // 1. Try compiled .js alongside the .ts
    if (existsSync(ts)) {
      const compiled = await tryCompiledJs(ts);
      if (compiled !== undefined) {
        debug(`Loaded config from compiled JS: ${ts.replace(".ts", ".js")}`);
        return compiled;
      }
    }

    // 2. If already running under tsx, direct import works
    if (existsSync(ts) && isRunningUnderTsx()) {
      const direct = await tryDirectImport(ts);
      if (direct !== undefined) {
        debug(`Loaded config via tsx runtime: ${ts}`);
        return direct;
      }
    }

    // 3. Node 22.6+ with --experimental-strip-types can import .ts directly
    if (existsSync(ts) && process.version >= "v22.6.0") {
      const direct = await tryDirectImport(ts);
      if (direct !== undefined) {
        debug(`Loaded config via native TS strip: ${ts}`);
        return direct;
      }
    }

    // 4. Use tsx as a child process to evaluate and return JSON
    if (existsSync(ts)) {
      const transpiled = await tryTsxTranspile(ts, cwd);
      if (transpiled !== undefined) {
        debug(`Loaded config via tsx child process: ${ts}`);
        return transpiled;
      }
    }

    // 5. JSON fallback — always works, no TypeScript needed
    const json_ = await tryJsonConfig(json);
    if (json_ !== undefined) {
      debug(`Loaded config from JSON: ${json}`);
      return json_;
    }
  }

  debug("No config file found, using defaults");
  return {};
}

function debug(msg: string): void {
  if (process.env.HELIX_DEBUG) {
    process.stderr.write(`[hlx:config] ${msg}\n`);
  }
}

// ─── Config validation ────────────────────────────────────────────────────────

export function validateConfig(raw: Partial<HelixConfig>): {
  config: HelixConfig;
  warnings: string[];
} {
  const warnings: string[] = [];

  // Warn about unknown providers
  if (raw.provider && !["anthropic", "openai", "google", "ollama"].includes(raw.provider)) {
    warnings.push(`Unknown provider "${raw.provider}" — will attempt to use anyway`);
  }

  // Warn about very high maxTurns
  if (raw.maxTurns && raw.maxTurns > 100) {
    warnings.push(`maxTurns is set to ${raw.maxTurns} — this may allow very long unattended runs`);
  }

  const config: HelixConfig = {
    model: raw.model ?? "claude-sonnet-4-5",
    provider: raw.provider ?? "anthropic",
    systemPrompt: raw.systemPrompt,
    maxTurns: raw.maxTurns ?? 50,
    extensions: raw.extensions ?? [],
    ...raw,
  };

  return { config, warnings };
}
