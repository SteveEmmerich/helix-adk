/**
 * @helix/cli/extension — Public extension contract
 *
 * Every hlx extension is an npm package (or local file) that exports
 * a `HelixExtension` as its default export.
 *
 * Design goals vs pi-mono:
 * 1. Extensions are npm packages — versioned, publishable, composable
 * 2. Typed lifecycle hooks — no magic string event names
 * 3. Extensions declare their capabilities upfront (for UI display)
 * 4. No global mutation — extensions return data, don't impeach globals
 * 5. Extensions can contribute tools, commands, renderers, and middleware
 */

import type { ToolDefinition } from "@helix/ai";
import type { AgentEvent, AgentState, MiddlewareFn } from "@helix/core";

// ─── Slash command ────────────────────────────────────────────────────────────

export interface SlashCommand {
  /** e.g. "fork" → triggered by "/fork" */
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  /** e.g. ["f"] → "/f" also works */
  readonly aliases?: readonly string[];
  execute(args: string[], ctx: CommandContext): Promise<CommandResult> | CommandResult;
}

export interface CommandContext {
  /** Current agent state snapshot */
  readonly state: AgentState;
  /** Write a line to the TUI output */
  print(line: string): void;
  /** Trigger a full agent run with this input */
  sendToAgent(input: string): Promise<void>;
  /** Reset the current session */
  reset(): void;
  /** Fork the session at the current message index */
  fork(atMessage?: number): Promise<void>;
  /** Access raw config */
  readonly config: HelixConfig;
}

export type CommandResult =
  | { readonly type: "handled" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "passthrough"; readonly input: string };

// ─── Input hook ───────────────────────────────────────────────────────────────

export type InputHookResult =
  /** Let the input pass through unchanged */
  | { readonly type: "continue" }
  /** Replace the input before it reaches the agent */
  | { readonly type: "transform"; readonly input: string }
  /** Handle it entirely — agent never sees it */
  | { readonly type: "handled" };

export type InputHook = (
  input: string,
  ctx: CommandContext
) => InputHookResult | Promise<InputHookResult>;

// ─── Custom renderer ──────────────────────────────────────────────────────────

export interface AgentEventRenderer {
  /** Return true if this renderer handles this event */
  canRender(event: AgentEvent): boolean;
  /** Return a string to display, or null to suppress */
  render(event: AgentEvent): string | null;
}

// ─── Extension lifecycle ──────────────────────────────────────────────────────

export interface ExtensionContext {
  readonly config: HelixConfig;
  readonly version: string;
  /** Log to hlx's debug output (shown with --debug) */
  log(message: string, data?: unknown): void;
}

// ─── Helix config shape ────────────────────────────────────────────────────────

export interface HelixConfig {
  readonly model: string;
  readonly provider: string;
  readonly systemPrompt?: string;
  readonly maxTurns?: number;
  readonly extensions?: readonly string[];
  readonly [key: string]: unknown;
}

// ─── The extension contract ───────────────────────────────────────────────────

export interface HelixExtension {
  /** Display name shown in /extensions and startup banner */
  readonly name: string;
  /** Semver */
  readonly version: string;
  readonly description?: string;

  /**
   * Called once when the extension loads (or reloads).
   * Return false to abort loading with an error message.
   */
  setup?(ctx: ExtensionContext): Promise<boolean | undefined> | boolean | undefined;

  /**
   * Called when the extension is unloaded (on /reload or exit).
   * Clean up watchers, open handles, etc.
   */
  teardown?(): Promise<void> | void;

  /** Extra tools to add to the agent */
  tools?(): readonly ToolDefinition[];

  /** Slash commands to register (e.g. /sync, /pr, /deploy) */
  commands?(): readonly SlashCommand[];

  /** Called before every user input reaches the agent */
  onInput?: InputHook;

  /** Called for every agent event — for custom rendering or side effects */
  onAgentEvent?(event: AgentEvent, ctx: CommandContext): void | Promise<void>;

  /** Custom renderers for agent events (shown in TUI) */
  renderers?(): readonly AgentEventRenderer[];

  /** Additional middleware to wrap agent turns */
  middleware?(): readonly MiddlewareFn[];
}
