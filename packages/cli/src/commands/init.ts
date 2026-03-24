/**
 * hlx init — scaffolds a new Helix ADK project
 *
 * Creates:
 *   hlx.config.ts              Project config
 *   .hlx/extensions/.gitkeep  Extension directory
 *   .hlx/sessions/.gitkeep    Session storage directory
 *   .gitignore additions        Ignore session DB and secrets
 *
 * Asks: provider, model, whether to add memory/search/browser extensions.
 * Works in an existing project (merges with existing .gitignore etc.)
 */

import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";

// ─── Prompts ──────────────────────────────────────────────────────────────────

async function ask(rl: readline.Interface, question: string, defaultVal: string): Promise<string> {
  const answer = await rl.question(`  ${question} [${defaultVal}]: `);
  return answer.trim() || defaultVal;
}

async function confirm(
  rl: readline.Interface,
  question: string,
  defaultYes = true
): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await rl.question(`  ${question} [${hint}]: `);
  const trimmed = answer.trim().toLowerCase();
  if (!trimmed) return defaultYes;
  return trimmed === "y" || trimmed === "yes";
}

// ─── File generators ──────────────────────────────────────────────────────────

function generateConfig(opts: {
  provider: string;
  model: string;
  extensions: string[];
  systemPrompt?: string;
}): string {
  const extList =
    opts.extensions.length > 0 ? opts.extensions.map((e) => `    "${e}",`).join("\n") : "";

  return `import type { HelixConfig } from "@helix/cli";

const config: HelixConfig = {
  // LLM provider and model
  provider: "${opts.provider}",
  model: "${opts.model}",

  // System prompt — customize this for your project
  systemPrompt: \`${opts.systemPrompt ?? "You are a helpful coding assistant. Use the available tools to complete tasks."}\`,

  // Max agent turns per run (prevents runaway loops)
  maxTurns: 30,

  // Extensions to load
  // Local extensions in .hlx/extensions/ are auto-discovered and hot-reloaded.
  extensions: [
${extList}
  ],
};

export default config;
`;
}

function generateExampleExtension(): string {
  return `/**
 * Example Helix extension — customize this for your project.
 *
 * This file is in .hlx/extensions/ which is auto-discovered.
 * Edit and save — hlx will hot-reload it automatically.
 */

import type { HelixExtension } from "@helix/cli/extension";
import { defineTool } from "@helix/core";

const myExtension: HelixExtension = {
  name: "my-project-extension",
  version: "0.1.0",
  description: "Custom tools and commands for this project",

  setup(ctx) {
    ctx.log("Project extension loaded");
    return true;
  },

  tools() {
    return [
      defineTool({
        name: "project_info",
        description: "Get information about this project",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          return {
            name: "my-project",
            // Add your project-specific info here
          };
        },
        formatOutput: (info) => JSON.stringify(info, null, 2),
      }),
    ];
  },

  commands() {
    return [
      {
        name: "project",
        description: "Show project information",
        execute(_args, ctx) {
          ctx.print("  Project extension is active\\n");
          return { type: "handled" };
        },
      },
    ];
  },
};

export default myExtension;
`;
}

const GITIGNORE_ADDITIONS = `
# Helix ADK
.hlx/sessions/
.hlx/memory.db
*.hlx.db
`;

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runInit(cwd: string): Promise<void> {
  console.log("\n  Helix ADK — Project Setup\n");
  console.log("  This will create hlx.config.ts and .hlx/ in:");
  console.log(`  ${cwd}\n`);

  const rl = readline.createInterface({ input, output, terminal: true });

  try {
    // ── Provider selection ──
    console.log("  Provider options:");
    console.log("    1. anthropic  (Claude — requires ANTHROPIC_API_KEY)");
    console.log("    2. openai     (GPT / o-series — requires OPENAI_API_KEY)");
    console.log("    3. google     (Gemini — requires GOOGLE_API_KEY)");
    const providerChoice = await ask(rl, "Provider", "anthropic");

    const providerDefaults: Record<string, string> = {
      anthropic: "claude-sonnet-4-5",
      openai: "gpt-4o",
      google: "gemini-2.5-flash",
      ollama: "kimi-k2.5:cloud",
    };
    const defaultModel = providerDefaults[providerChoice] ?? "claude-sonnet-4-5";
    const model = await ask(rl, "Model", defaultModel);

    // ── Extensions ──
    console.log("\n  Optional extensions (install separately if needed):");
    const extensions: string[] = [];

    if (await confirm(rl, "Add web search? (@helix/ext-search)", false)) {
      extensions.push("@helix/ext-search");
    }
    if (await confirm(rl, "Add browser automation? (@helix/ext-browser + playwright)", false)) {
      extensions.push("@helix/ext-browser");
    }
    if (await confirm(rl, "Add persistent memory? (@helix/ext-memory)", false)) {
      extensions.push("@helix/ext-memory");
    }

    // ── Example extension ──
    const addExample = await confirm(
      rl,
      "\n  Add example project extension in .hlx/extensions/?",
      true
    );

    console.log("\n  Creating files...\n");

    // ── Create directories ──
    await mkdir(join(cwd, ".hlx", "extensions"), { recursive: true });
    await mkdir(join(cwd, ".hlx", "sessions"), { recursive: true });

    // ── hlx.config.ts ──
    const configPath = join(cwd, "hlx.config.ts");
    const configExists = await access(configPath)
      .then(() => true)
      .catch(() => false);
    if (configExists) {
      const overwrite = await confirm(rl, "  hlx.config.ts already exists — overwrite?", false);
      if (!overwrite) {
        console.log("  Skipped hlx.config.ts");
      } else {
        await writeFile(
          configPath,
          generateConfig({ provider: providerChoice, model, extensions })
        );
        console.log("  ✓ hlx.config.ts");
      }
    } else {
      await writeFile(configPath, generateConfig({ provider: providerChoice, model, extensions }));
      console.log("  ✓ hlx.config.ts");
    }

    // ── Example extension ──
    if (addExample) {
      const extPath = join(cwd, ".hlx", "extensions", "my-extension.ts");
      await writeFile(extPath, generateExampleExtension());
      console.log("  ✓ .hlx/extensions/my-extension.ts");
    }

    // ── .gitkeep files ──
    await writeFile(join(cwd, ".hlx", "sessions", ".gitkeep"), "");
    console.log("  ✓ .hlx/sessions/");

    // ── .gitignore ──
    const gitignorePath = join(cwd, ".gitignore");
    const gitignoreExists = await access(gitignorePath)
      .then(() => true)
      .catch(() => false);
    if (gitignoreExists) {
      const existing = await readFile(gitignorePath, "utf-8");
      if (!existing.includes(".hlx/sessions")) {
        await appendFile(gitignorePath, GITIGNORE_ADDITIONS);
        console.log("  ✓ .gitignore (updated)");
      } else {
        console.log("  ✓ .gitignore (already has hlx entries)");
      }
    } else {
      await writeFile(gitignorePath, `${GITIGNORE_ADDITIONS.trim()}\n`);
      console.log("  ✓ .gitignore");
    }

    // ── Next steps ──
    console.log("\n  ✅ Done!\n");

    const envVar =
      providerChoice === "openai"
        ? "OPENAI_API_KEY"
        : providerChoice === "google"
          ? "GOOGLE_API_KEY"
          : providerChoice === "ollama"
            ? "OLLAMA_BASE_URL"
            : "ANTHROPIC_API_KEY";

    console.log("  Next steps:");
    console.log(`    export ${envVar}=your-key-here`);

    if (extensions.length > 0) {
      console.log(`    npm install ${extensions.join(" ")}`);
      if (extensions.includes("@helix/ext-browser")) {
        console.log("    npx playwright install chromium");
      }
    }

    console.log("    hlx\n");
  } finally {
    rl.close();
  }
}
