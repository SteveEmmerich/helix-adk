/**
 * Built-in slash commands for @helix/cli
 *
 * All commands implement SlashCommand from the extension contract,
 * so they're identical in shape to extension-contributed commands.
 */

import type { ExtensionLoader } from "../extensions/loader.js";
import type { ExtensionRegistry } from "../extensions/registry.js";
import type { CommandContext, CommandResult, SlashCommand } from "../extensions/types.js";

// ─── /help ────────────────────────────────────────────────────────────────────

export function makeHelpCommand(
  builtins: readonly SlashCommand[],
  registry: ExtensionRegistry
): SlashCommand {
  return {
    name: "help",
    aliases: ["h", "?"],
    description: "Show available commands",
    execute(_args, ctx) {
      const allCommands = [...builtins, ...registry.commands];
      const lines = [
        "",
        "  Helix ADK — available commands",
        "  ─────────────────────────────────────",
      ];
      for (const cmd of allCommands) {
        const aliases = cmd.aliases?.length ? ` (/${cmd.aliases.join(", /")})` : "";
        lines.push(`  /${cmd.name}${aliases}`);
        lines.push(`      ${cmd.description}`);
        if (cmd.usage) lines.push(`      Usage: ${cmd.usage}`);
      }
      lines.push("");
      lines.push("  Tip: start your message with / to enter a command");
      lines.push("");
      ctx.print(lines.join("\n"));
      return { type: "handled" };
    },
  };
}

// ─── /reset ───────────────────────────────────────────────────────────────────

export const resetCommand: SlashCommand = {
  name: "reset",
  aliases: ["r"],
  description: "Clear conversation history and start a new session",
  execute(_args, ctx) {
    ctx.reset();
    ctx.print("  ✓ Session reset — conversation cleared\n");
    return { type: "handled" };
  },
};

// ─── /fork ────────────────────────────────────────────────────────────────────

export const forkCommand: SlashCommand = {
  name: "fork",
  aliases: ["f"],
  description: "Fork the current session at a given message index",
  usage: "/fork [message-index]",
  execute(args, ctx) {
    const index = args[0] ? Number.parseInt(args[0], 10) : undefined;
    if (args[0] && Number.isNaN(index)) {
      return { type: "error", message: `Invalid message index: ${args[0]}` };
    }
    // Fork is async — fire and handle
    ctx
      .fork(index)
      .then(() => {
        const at = index !== undefined ? ` at message ${index}` : "";
        ctx.print(`  ✓ Session forked${at} — continuing from branch\n`);
      })
      .catch((e: unknown) => {
        ctx.print(`  ✗ Fork failed: ${e instanceof Error ? e.message : String(e)}\n`);
      });
    return { type: "handled" };
  },
};

// ─── /reload ──────────────────────────────────────────────────────────────────

export function makeReloadCommand(loader: ExtensionLoader): SlashCommand {
  return {
    name: "reload",
    description: "Hot-reload all local extensions",
    usage: "/reload [extension-id]",
    async execute(args, ctx) {
      if (args[0]) {
        const ok = await loader.reload(args[0]);
        if (!ok) return { type: "error", message: `Unknown extension: ${args[0]}` };
        ctx.print(`  ✓ Reloaded extension: ${args[0]}\n`);
      } else {
        const reloaded = await loader.reloadLocal();
        if (reloaded.length === 0) {
          ctx.print("  ℹ No local extensions to reload\n");
        } else {
          ctx.print(`  ✓ Reloaded ${reloaded.length} extension(s): ${reloaded.join(", ")}\n`);
        }
      }
      return { type: "handled" };
    },
  };
}

// ─── /extensions ──────────────────────────────────────────────────────────────

export function makeExtensionsCommand(registry: ExtensionRegistry): SlashCommand {
  return {
    name: "extensions",
    aliases: ["ext"],
    description: "List loaded extensions",
    execute(_args, ctx) {
      ctx.print(`\n  Loaded extensions:\n${registry.summary()}\n`);
      return { type: "handled" };
    },
  };
}

// ─── /cost ────────────────────────────────────────────────────────────────────

export const costCommand: SlashCommand = {
  name: "cost",
  description: "Show token usage and cost for this session",
  execute(_args, ctx) {
    const { totalCostUsd, totalTokens, turns } = ctx.state;
    ctx.print(
      [
        "",
        "  Session cost",
        "  ─────────────────",
        `  Turns:   ${turns}`,
        `  Tokens:  ${totalTokens.toLocaleString()}`,
        `  Cost:    $${totalCostUsd.toFixed(6)}`,
        "",
      ].join("\n")
    );
    return { type: "handled" };
  },
};

// ─── /model ───────────────────────────────────────────────────────────────────

export const modelCommand: SlashCommand = {
  name: "model",
  description: "Show or switch the current model",
  usage: "/model [model-id]",
  execute(args, ctx) {
    if (args[0]) {
      // Model switching is handled by the app layer
      return {
        type: "passthrough",
        input: `__nova_switch_model__:${args[0]}`,
      };
    }
    ctx.print(`  Current model: ${ctx.config.model}\n`);
    return { type: "handled" };
  },
};

// ─── /compact ─────────────────────────────────────────────────────────────────

export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Compact conversation history to reduce context usage",
  execute(_args, ctx) {
    ctx
      .sendToAgent(
        "Please summarize our conversation so far in a concise system note, then confirm."
      )
      .catch(() => {
        /* handled by agent */
      });
    return { type: "handled" };
  },
};

// ─── Build all builtins ───────────────────────────────────────────────────────

export function makeBuiltinCommands(
  registry: ExtensionRegistry,
  loader: ExtensionLoader
): SlashCommand[] {
  const commands = [
    resetCommand,
    forkCommand,
    makeReloadCommand(loader),
    makeExtensionsCommand(registry),
    costCommand,
    modelCommand,
    compactCommand,
  ];
  // Help gets a reference to all commands, including itself
  commands.unshift(makeHelpCommand(commands, registry));
  return commands;
}

// ─── Command router ───────────────────────────────────────────────────────────

export function parseSlashCommand(input: string): { name: string; args: string[] } | null {
  if (!input.startsWith("/")) return null;
  const [raw, ...rest] = input.slice(1).trim().split(/\s+/);
  if (!raw) return null;
  return { name: raw, args: rest };
}

export async function routeCommand(
  input: string,
  builtins: readonly SlashCommand[],
  registry: ExtensionRegistry,
  ctx: CommandContext
): Promise<CommandResult | null> {
  const parsed = parseSlashCommand(input);
  if (!parsed) return null;

  const { name, args } = parsed;
  const allCommands = [...builtins, ...registry.commands];
  const cmd = allCommands.find((c) => c.name === name || c.aliases?.includes(name));

  if (!cmd) {
    return {
      type: "error",
      message: `Unknown command: /${name} — type /help to see available commands`,
    };
  }

  return cmd.execute(args, ctx);
}
