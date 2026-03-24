/**
 * Extension registry — single point of truth for what all extensions contribute.
 * Re-computed every time extensions load/reload.
 */

import type { ToolDefinition } from "@helix/ai";
import type { MiddlewareFn } from "@helix/core";
import type { ExtensionLoader } from "./loader.js";
import type { AgentEventRenderer, HelixExtension, InputHook, SlashCommand } from "./types.js";

export class ExtensionRegistry {
  readonly #loader: ExtensionLoader;

  constructor(loader: ExtensionLoader) {
    this.#loader = loader;
  }

  get tools(): readonly ToolDefinition[] {
    return this.#loader.extensions.flatMap((e) => e.ext.tools?.() ?? []);
  }

  get commands(): readonly SlashCommand[] {
    return this.#loader.extensions.flatMap((e) => e.ext.commands?.() ?? []);
  }

  get middleware(): readonly MiddlewareFn[] {
    return this.#loader.extensions.flatMap((e) => e.ext.middleware?.() ?? []);
  }

  get renderers(): readonly AgentEventRenderer[] {
    return this.#loader.extensions.flatMap((e) => e.ext.renderers?.() ?? []);
  }

  get inputHooks(): readonly { ext: HelixExtension; hook: InputHook }[] {
    return this.#loader.extensions.flatMap((e) =>
      e.ext.onInput ? [{ ext: e.ext, hook: e.ext.onInput }] : []
    );
  }

  findCommand(name: string): SlashCommand | undefined {
    return this.commands.find((c) => c.name === name || c.aliases?.includes(name));
  }

  summary(): string {
    const exts = this.#loader.extensions;
    if (exts.length === 0) return "No extensions loaded";
    return exts.map((e) => `  • ${e.ext.name} v${e.ext.version}`).join("\n");
  }
}
