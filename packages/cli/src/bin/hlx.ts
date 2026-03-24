#!/usr/bin/env bun
/**
 * hlx — the Helix ADK terminal agent
 *
 * Usage:
 *   hlx                          # Interactive TUI
 *   hlx "your prompt here"       # Single-turn (pipe-friendly)
 *   hlx --resume <session-id>    # Resume a specific session
 *   hlx --model claude-haiku-4-5 # Override model
 *   hlx --no-picker              # Skip session picker
 *   hlx --help                   # Show help
 *   hlx init                     # Scaffold a new project
 *   hlx doctor                   # Diagnose setup
 */

import { mkdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";
import { AnthropicProvider, GoogleProvider, OllamaProvider, OpenAIProvider } from "@helix/ai";
import { loadConfig, validateConfig } from "../config/loader.js";
import type { HelixConfig } from "../extensions/types.js";
import { HelixRuntime } from "../runtime.js";
import { launchdPath, launchdPlist, systemdPath, systemdUnit } from "../service.js";

// ─── Parse args ───────────────────────────────────────────────────────────────

interface ParsedArgs {
  command?: "init" | "doctor";
  input?: string;
  model?: string;
  provider?: string;
  resumeSessionId?: string;
  skipSessionPicker?: boolean;
  help?: boolean;
  version?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const result: ParsedArgs = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "init") {
      result.command = "init";
      continue;
    }
    if (arg === "doctor") {
      result.command = "doctor";
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      result.version = true;
      continue;
    }
    if (arg === "--no-picker") {
      result.skipSessionPicker = true;
      continue;
    }
    if ((arg === "--model" || arg === "-m") && args[i + 1]) {
      result.model = args[++i];
      continue;
    }
    if ((arg === "--provider" || arg === "-p") && args[i + 1]) {
      result.provider = args[++i];
      continue;
    }
    if ((arg === "--resume" || arg === "-r") && args[i + 1]) {
      result.resumeSessionId = args[++i];
      continue;
    }
    if (!arg.startsWith("-")) positional.push(arg);
  }

  if (positional.length > 0) result.input = positional.join(" ");
  return result;
}

let stdinLines: string[] | null = null;
let stdinLoaded: Promise<void> | null = null;

async function loadStdinLines(): Promise<void> {
  if (stdinLoaded) return stdinLoaded;
  stdinLines = [];
  stdinLoaded = new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      stdinLines?.push(line);
    });
    rl.on("close", () => resolve());
  });
  return stdinLoaded;
}

export async function readSecret(promptText: string): Promise<string> {
  if (process.stdin.isTTY) {
    return await new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });

      process.stderr.write(promptText);
      process.stdin.setRawMode(true);
      process.stdin.setEncoding("utf8");

      let value = "";
      const onData = (char: string) => {
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.removeListener("data", onData);
          process.stderr.write("\n");
          rl.close();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          process.stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(1);
        }
        if (char === "\u007f") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write("\b \b");
          }
          return;
        }
        value += char;
        process.stderr.write("*");
      };

      process.stdin.on("data", onData);
    });
  }

  process.stderr.write(`${promptText} (reading from stdin)\n`);
  await loadStdinLines();
  const next = stdinLines?.shift() ?? "";
  return next.trim();
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

// ─── Provider factory ─────────────────────────────────────────────────────────

function makeProvider(config: HelixConfig) {
  const providerName = config.provider ?? "anthropic";

  switch (providerName) {
    case "openai": {
      const key = process.env.OPENAI_API_KEY;
      if (!key) {
        console.error("Error: OPENAI_API_KEY required for OpenAI provider");
        process.exit(1);
      }
      return new OpenAIProvider({ apiKey: key });
    }
    case "google": {
      const key = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
      if (!key) {
        console.error("Error: GOOGLE_API_KEY or GEMINI_API_KEY required for Google provider");
        process.exit(1);
      }
      return new GoogleProvider({ apiKey: key });
    }
    case "ollama": {
      return new OllamaProvider({
        baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
        model: config.model ?? "kimi-k2.5:cloud",
      });
    }
    default: {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) {
        console.error("Error: ANTHROPIC_API_KEY required");
        process.exit(1);
      }
      return new AnthropicProvider({ apiKey: key });
    }
  }
}

// ─── Help ─────────────────────────────────────────────────────────────────────

const HELP = `
Helix ADK — Agent Development Kit

USAGE
  hlx [options] [prompt]
  hlx init

COMMANDS
  init                   Scaffold hlx.config.ts and .hlx/ in current directory
  doctor                 Diagnose environment and dependencies
  service install        Install HelixClaw as a background service
  service uninstall      Remove the HelixClaw service
  service start          Start the background service
  service stop           Stop the background service
  service status         Show service status
  service logs           Tail service logs
  vault add <name>       Store a credential in the vault
  vault list             List stored credentials (metadata only)
  vault remove <name>    Remove a credential
  vault rotate <name>    Rotate a credential value
  vault audit            Show recent vault access

OPTIONS
  -m, --model <id>       Model to use (default: claude-sonnet-4-5)
  -p, --provider <name>  Provider: anthropic | openai | google | ollama (default: anthropic)
  -r, --resume <id>      Resume a specific session by ID
      --no-picker        Skip the session picker on startup
  -h, --help             Show this help
  -v, --version          Show version

EXAMPLES
  hlx                                       # Interactive TUI
  hlx "List TypeScript files here"         # Single-turn
  hlx --model gpt-4o --provider openai     # Use OpenAI
  hlx --model gemini-2.5-flash -p google   # Use Gemini
  hlx --resume abc123                      # Resume session
  hlx init                                 # New project setup
  hlx doctor                               # Diagnostics

  ENVIRONMENT
  ANTHROPIC_API_KEY     For Anthropic/Claude models
  OPENAI_API_KEY        For OpenAI models
  GOOGLE_API_KEY        For Google Gemini models
  OLLAMA_BASE_URL       For Ollama (default http://localhost:11434)
  HELIX_DEBUG            Enable debug logging
  HELIX_SHOW_COST        Show cost after pipe-mode runs

CONFIG
  hlx.config.ts | hlx.config.json | .hlx/config.ts

EXTENSIONS
  .hlx/extensions/*.ts     Auto-discovered, hot-reloaded on /reload
  ~/.hlx/extensions/*.ts   Global extensions
  hlx.config extensions[]  npm packages

`;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === "vault") {
    const sub = rawArgs[1];
    const { CredentialVault } = await import("@helix/security");
    const vaultDir = join(homedir(), ".hlx");
    mkdirSync(vaultDir, { recursive: true });
    const vault = new CredentialVault({
      dbPath: join(vaultDir, "vault.db"),
    });
    await vault.init();

    if (sub === "add") {
      const name = rawArgs[2];
      if (!name) {
        console.error(
          "Usage: hlx vault add <name> [--type api_key] [--tools bash,http_post] [--value secret]"
        );
        process.exit(1);
      }
      const type = flagValue(rawArgs, "--type") ?? "api_key";
      const tools = flagValue(rawArgs, "--tools");
      const valueFromFlag = flagValue(rawArgs, "--value");
      const value = valueFromFlag ?? (await readSecret("Enter value: "));
      if (!value) {
        console.error("Value cannot be empty");
        process.exit(1);
      }
      if (!valueFromFlag) {
        const confirm = await readSecret("Confirm value: ");
        if (value !== confirm) {
          console.error("Values do not match");
          process.exit(1);
        }
      }
      const result = await vault.store(name, value, {
        type,
        allowedTools: tools
          ? tools
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined,
      });
      if (!result.ok) {
        console.error(result.error.message);
        process.exit(1);
      }
      console.log(`✓ Stored ${name}`);
      process.exit(0);
    }

    if (sub === "list") {
      const entries = vault.list();
      if (entries.length === 0) {
        console.log("No credentials stored.");
        process.exit(0);
      }
      for (const entry of entries) {
        console.log(
          `${entry.name} (${entry.type}) · used ${entry.useCount}x · last used ${entry.lastUsed ?? "never"}`
        );
      }
      process.exit(0);
    }

    if (sub === "remove") {
      const name = rawArgs[2];
      if (!name) {
        console.error("Usage: hlx vault remove <name>");
        process.exit(1);
      }
      const result = await vault.delete(name);
      if (!result.ok) {
        console.error(result.error.message);
        process.exit(1);
      }
      console.log(`✓ Removed ${name}`);
      process.exit(0);
    }

    if (sub === "rotate") {
      const name = rawArgs[2];
      if (!name) {
        console.error("Usage: hlx vault rotate <name>");
        process.exit(1);
      }
      const value = await readSecret("Enter new value: ");
      const result = await vault.rotate(name, value);
      if (!result.ok) {
        console.error(result.error.message);
        process.exit(1);
      }
      console.log(`✓ Rotated ${name}`);
      process.exit(0);
    }

    if (sub === "audit") {
      const limit = Number(flagValue(rawArgs, "--limit") ?? "20");
      const entries = vault.audit(limit);
      for (const entry of entries) {
        console.log(
          `${new Date(entry.createdAt).toLocaleString()} · ${entry.action} · ${entry.credentialId} · ${entry.toolName ?? "-"}`
        );
      }
      process.exit(0);
    }

    console.error("Unknown vault command. Use: add | list | remove | rotate | audit");
    process.exit(1);
  }
  if (rawArgs[0] === "service") {
    const sub = rawArgs[1];
    if (!sub) {
      console.error("Usage: hlx service <install|uninstall|start|stop|status|logs>");
      process.exit(1);
    }
    const bunPath = process.execPath;
    const repoPath = process.cwd();
    const logsDir = join(homedir(), ".hlx", "logs");
    mkdirSync(logsDir, { recursive: true });

    const run = async (cmd: string[], allowFail = false) => {
      const proc = Bun.spawn({ cmd, stdout: "inherit", stderr: "inherit" });
      const code = await proc.exited;
      if (code !== 0 && !allowFail) process.exit(code);
      return code;
    };

    if (process.platform === "darwin") {
      const plistPath = launchdPath();
      const label = "com.helixclaw.gateway";
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      if (sub === "install") {
        await writeFile(plistPath, launchdPlist({ bunPath, repoPath }), "utf-8");
        await run(["launchctl", "unload", plistPath], true);
        await run(["launchctl", "load", "-w", plistPath]);
        console.log("✓ HelixClaw will start automatically on login");
        process.exit(0);
      }
      if (sub === "uninstall") {
        await run(["launchctl", "unload", plistPath], true);
        await rm(plistPath, { force: true });
        console.log("✓ HelixClaw service removed");
        process.exit(0);
      }
      if (sub === "start") {
        await run(["launchctl", "kickstart", "-k", `gui/${uid}/${label}`], true);
        process.exit(0);
      }
      if (sub === "stop") {
        await run(["launchctl", "bootout", `gui/${uid}`, plistPath], true);
        process.exit(0);
      }
      if (sub === "status") {
        await run(["launchctl", "list", label], true);
        process.exit(0);
      }
      if (sub === "logs") {
        const lines = Number(flagValue(rawArgs, "--lines") ?? "50");
        await run(["tail", "-n", String(lines), join(logsDir, "gateway.log")], true);
        process.exit(0);
      }
      console.error("Unknown service command.");
      process.exit(1);
    }

    if (process.platform === "linux") {
      const unitPath = systemdPath();
      if (sub === "install") {
        const dir = join(homedir(), ".config", "systemd", "user");
        mkdirSync(dir, { recursive: true });
        await writeFile(unitPath, systemdUnit({ bunPath, repoPath }), "utf-8");
        await run(["systemctl", "--user", "daemon-reload"]);
        await run(["systemctl", "--user", "enable", "--now", "helixclaw"]);
        console.log("✓ HelixClaw will start automatically on login");
        process.exit(0);
      }
      if (sub === "uninstall") {
        await run(["systemctl", "--user", "disable", "--now", "helixclaw"], true);
        await rm(unitPath, { force: true });
        await run(["systemctl", "--user", "daemon-reload"], true);
        console.log("✓ HelixClaw service removed");
        process.exit(0);
      }
      if (sub === "start") {
        await run(["systemctl", "--user", "start", "helixclaw"]);
        process.exit(0);
      }
      if (sub === "stop") {
        await run(["systemctl", "--user", "stop", "helixclaw"]);
        process.exit(0);
      }
      if (sub === "status") {
        await run(["systemctl", "--user", "status", "helixclaw", "--no-pager"], true);
        process.exit(0);
      }
      if (sub === "logs") {
        const lines = Number(flagValue(rawArgs, "--lines") ?? "50");
        await run(
          ["journalctl", "--user", "-u", "helixclaw", "-n", String(lines), "--no-pager"],
          true
        );
        process.exit(0);
      }
      console.error("Unknown service command.");
      process.exit(1);
    }

    console.error("Service management is only supported on macOS and Linux.");
    process.exit(1);
  }
  if (rawArgs[0] === "doctor") {
    const { Database } = await import("bun:sqlite");
    const { tryLoadSqliteVec } = await import("@helix/memory");
    const db = new Database(":memory:");
    const vecOk = await tryLoadSqliteVec(db);
    db.close();
    console.log("Helix ADK doctor");
    console.log(`sqlite-vec: ${vecOk ? "available" : "not found"}`);
    if (!vecOk) {
      console.log("Install sqlite-vec for faster memory search: brew install sqlite-vec");
    }
    const { CredentialVault, AllowlistManager, LEAK_PATTERNS } = await import("@helix/security");
    const vaultDir = join(homedir(), ".hlx");
    mkdirSync(vaultDir, { recursive: true });
    const vault = new CredentialVault({
      dbPath: join(vaultDir, "vault.db"),
    });
    await vault.init();
    console.log(`vault: initialized (${vault.list().length} credentials stored)`);
    const testId = await vault.store("__doctor_test__", "test", {});
    if (testId.ok) {
      const retrieved = await vault.retrieve("__doctor_test__");
      await vault.delete("__doctor_test__");
      if (retrieved.ok && retrieved.value === "test") {
        console.log("✓ Vault: encryption working correctly");
      } else {
        console.log("✗ Vault: encryption test failed");
      }
    } else {
      console.log("✗ Vault: encryption test failed");
    }
    const allowlist = new AllowlistManager({ db: vault.db });
    console.log(
      `dlp: active (patterns: ${LEAK_PATTERNS.length}, allowlist entries: ${allowlist.list().length})`
    );
    const tunnelProvider = process.env.HELIX_TUNNEL;
    if (tunnelProvider) {
      console.log(`tunnel: configured (${tunnelProvider})`);
    } else {
      console.log("tunnel: not configured");
    }
    process.exit(0);
  }
  if (rawArgs[0] === "migrate" && rawArgs[1] === "openclaw") {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { MemoryManager, NullEmbeddingProvider, migrateFromOpenClaw } = await import(
      "@helix/memory"
    );
    const pathArg = rawArgs.find(
      (arg) => !arg.startsWith("--") && arg !== "migrate" && arg !== "openclaw"
    );
    const target = pathArg ?? join(homedir(), "openclaw-workspace");
    const dryRun = rawArgs.includes("--dry-run") && !rawArgs.includes("--confirm");
    const confirm = rawArgs.includes("--confirm");

    const memory = new MemoryManager({
      dbPath: join(homedir(), ".hlx", "memory.db"),
      embeddingProvider: new NullEmbeddingProvider(),
      poisoningProtection: true,
    });
    await memory.init();

    console.log(`Scanning OpenClaw workspace at ${target}...`);
    const result = await migrateFromOpenClaw(target, memory, { dryRun, confirm });

    if (!confirm) {
      console.log(`Found: ${result.factsImported} facts, ${result.episodesImported} episodes`);
      console.log("");
      console.log("Preview:");
      console.log(`  ${result.factsImported} facts to import to Tier 1`);
      console.log(`  ${result.episodesImported} episodes to import to Tier 2`);
      console.log("  SOUL.md → ~/.hlx/SOUL.md");
      console.log("");
      console.log("Run with --confirm to import.");
      process.exit(0);
    }

    console.log(`✓ Imported ${result.factsImported} facts`);
    console.log(`✓ Imported ${result.episodesImported} episodes`);
    console.log("Migration complete.");
    process.exit(0);
  }

  if (rawArgs[0] === "skills") {
    const command = rawArgs[1];
    const gatewayUrl = process.env.HELIXCLAW_GATEWAY_URL ?? "http://localhost:3000";
    const fetchGateway = async (path: string) => {
      const res = await fetch(`${gatewayUrl}${path}`);
      if (!res.ok) throw new Error(`Gateway request failed: ${res.status}`);
      return res.json() as Promise<Record<string, unknown>>;
    };
    if (command === "install" && rawArgs[2]) {
      const { runInstall } = await import("@helix/skills/cli/install");
      const tierFlag = rawArgs.find((arg) => arg.startsWith("--tier="))?.split("=")[1];
      const force = rawArgs.includes("--force");
      const result = await runInstall(rawArgs[2], { tier: tierFlag, force });
      if (!result.ok) {
        console.error(result.error ?? "Install failed");
        process.exit(1);
      }
      console.log(`✓ Installed ${result.skillId} (${result.tier})`);
      process.exit(0);
    }
    if (command === "search" && rawArgs[2]) {
      const query = rawArgs.slice(2).join(" ");
      const data = (await fetchGateway(`/api/skills/search?q=${encodeURIComponent(query)}`)) as {
        skills?: Array<{ id: string; description: string; tier: string }>;
      };
      const skills = data.skills ?? [];
      for (const skill of skills) {
        const tier = (skill.tier ?? "UNKNOWN").padEnd(6);
        const id = skill.id.padEnd(16);
        console.log(`${tier} ${id} — ${skill.description ?? ""}`);
      }
      process.exit(0);
    }
    if (command === "info" && rawArgs[2]) {
      const id = rawArgs[2];
      const data = (await fetchGateway(`/api/skills/${encodeURIComponent(id)}`)) as {
        skill?: {
          id: string;
          name: string;
          version?: string;
          description: string;
          author?: string;
          allowedTools?: string[];
          requiresApproval?: string[];
          tags?: string[];
          tier?: string;
          source?: string;
          installedAt?: number;
        };
      };
      if (!data.skill) {
        console.error(`Skill not found: ${id}`);
        process.exit(1);
      }
      const skill = data.skill;
      console.log(`Name: ${skill.name}`);
      console.log(`ID: ${skill.id}`);
      if (skill.version) console.log(`Version: ${skill.version}`);
      if (skill.author) console.log(`Author: ${skill.author}`);
      console.log(`Description: ${skill.description}`);
      if (skill.tier) console.log(`Tier: ${skill.tier}`);
      if (skill.source || skill.installedAt) {
        console.log("Install status: installed");
      } else {
        console.log("Install status: built-in");
      }
      if (skill.allowedTools?.length) {
        console.log(`Allowed tools: ${skill.allowedTools.join(", ")}`);
      }
      if (skill.requiresApproval?.length) {
        console.log(`Requires approval: ${skill.requiresApproval.join(", ")}`);
      }
      if (skill.tags?.length) {
        console.log(`Tags: ${skill.tags.join(", ")}`);
      }
      process.exit(0);
    }
    if (command === "list") {
      const { runList } = await import("@helix/skills/cli/list");
      const skills = await runList(process.cwd());
      if (rawArgs.includes("--json")) {
        console.log(JSON.stringify(skills, null, 2));
      } else {
        for (const skill of skills) {
          console.log(`${skill.tier} ${skill.id} — ${skill.description}`);
        }
      }
      process.exit(0);
    }
    if (command === "remove" && rawArgs[2]) {
      const { runRemove } = await import("@helix/skills/cli/remove");
      await runRemove(rawArgs[2]);
      console.log(`✓ Removed ${rawArgs[2]}`);
      process.exit(0);
    }
    if (command === "audit") {
      const { runAudit } = await import("@helix/skills/cli/audit");
      const results = await runAudit(process.cwd());
      console.log(JSON.stringify(results, null, 2));
      process.exit(0);
    }
    console.log("Usage: hlx skills <install|list|remove|audit|search|info> [args]");
    process.exit(1);
  }

  const args = parseArgs(process.argv);

  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (args.version) {
    console.log("0.1.0");
    process.exit(0);
  }

  // Delegate init to the scaffolding command
  if (args.command === "init") {
    const { runInit } = await import("../commands/init.js");
    await runInit(process.cwd());
    process.exit(0);
  }

  const cwd = process.cwd();

  // Load + validate config
  const rawConfig = await loadConfig(cwd);
  const { config: fileConfig, warnings } = validateConfig(rawConfig);

  for (const warning of warnings) {
    process.stderr.write(`[hlx] ⚠ ${warning}\n`);
  }

  // CLI flags override config file
  const config: HelixConfig = {
    ...fileConfig,
    model: args.model ?? fileConfig.model,
    provider: args.provider ?? fileConfig.provider,
    systemPrompt: fileConfig.systemPrompt ?? defaultSystemPrompt(cwd),
  };

  const provider = makeProvider(config);

  const runtime = new HelixRuntime({
    provider,
    config,
    cwd,
    skipSessionPicker: args.skipSessionPicker ?? Boolean(args.input),
    resumeSessionId: args.resumeSessionId,
    input: args.input,
  });

  try {
    await runtime.start();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

function defaultSystemPrompt(cwd: string): string {
  return `You are Helix, an AI coding assistant running in ${cwd}.

You have access to tools to read files, write files, run bash commands, and list directories.
Use them proactively to complete tasks. Prefer short, direct responses.
When making changes to code, always read the file first, make targeted edits, and verify the result.`;
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
