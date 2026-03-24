// Public API for embedding hlx in other tools
export { HelixRuntime } from "./runtime.js";
export type { HelixRuntimeOptions } from "./runtime.js";

// Extension authoring API
export type {
  HelixExtension,
  SlashCommand,
  CommandContext,
  CommandResult,
  InputHook,
  InputHookResult,
  AgentEventRenderer,
  HelixConfig,
  ExtensionContext,
} from "./extensions/types.js";

// Extension utilities
export { ExtensionLoader } from "./extensions/loader.js";
export { ExtensionRegistry } from "./extensions/registry.js";

// Commands (useful for custom CLIs)
export { makeBuiltinCommands, routeCommand, parseSlashCommand } from "./commands/index.js";

// TUI components (for embedding)
export { NovaApp } from "./tui/app.tsx";
export { SessionPicker } from "./session-picker/index.tsx";
export type { DisplayLine, NovaAppProps } from "./tui/app.tsx";
