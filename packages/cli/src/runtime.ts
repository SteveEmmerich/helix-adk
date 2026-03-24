/**
 * Helix runtime — the glue between all pieces.
 *
 * This is what you instantiate when building a hlx CLI app.
 * The bin/hlx.ts entrypoint calls this.
 * You can also call it programmatically for embedding hlx in other tools.
 */

import type { AnthropicProvider } from "@helix/ai";
import { modelId } from "@helix/ai";
import { Agent, FileSessionStorage, SessionManager, codingTools, withLogging } from "@helix/core";
import type { AgentEvent, MiddlewareFn } from "@helix/core";
import { render } from "ink";
import React from "react";
import { makeBuiltinCommands, routeCommand } from "./commands/index.js";
import { ExtensionLoader } from "./extensions/loader.js";
import { ExtensionRegistry } from "./extensions/registry.js";
import type { CommandContext, HelixConfig } from "./extensions/types.js";
import { SessionPicker } from "./session-picker/index.tsx";
import { NovaApp } from "./tui/app.tsx";

// ─── Runtime options ──────────────────────────────────────────────────────────

export interface HelixRuntimeOptions {
  readonly provider: AnthropicProvider;
  readonly config: HelixConfig;
  readonly cwd?: string;
  /** Skip session picker even if sessions exist */
  readonly skipSessionPicker?: boolean;
  /** Resume a specific session by ID */
  readonly resumeSessionId?: string;
  /** Initial input (non-interactive / pipe mode) */
  readonly input?: string;
}

// ─── Runtime ─────────────────────────────────────────────────────────────────

export class HelixRuntime {
  readonly #opts: HelixRuntimeOptions;
  readonly #sessions: SessionManager;
  readonly #loader: ExtensionLoader;
  readonly #registry: ExtensionRegistry;

  #agent: Agent | undefined;
  #abortController = new AbortController();

  constructor(opts: HelixRuntimeOptions) {
    this.#opts = opts;

    this.#sessions = new SessionManager(
      new FileSessionStorage(`${process.env.HOME ?? ""}/.hlx/sessions`)
    );

    this.#loader = new ExtensionLoader(opts.config, opts.cwd ?? process.cwd());
    this.#registry = new ExtensionRegistry(this.#loader);
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // 1. Load extensions
    this.#loader.onEvent((event) => {
      if (event.type === "error") {
        console.error(`[hlx:ext] Error in "${event.id}": ${event.error.message}`);
      }
    });
    await this.#loader.loadAll();

    // 2. Resolve session
    let sessionId: string | undefined = this.#opts.resumeSessionId;

    if (!sessionId && !this.#opts.skipSessionPicker) {
      sessionId = await this.#runSessionPicker();
    }

    if (sessionId) {
      await this.#sessions.load(sessionId);
    } else {
      await this.#sessions.create({
        model: this.#opts.config.model,
        workingDirectory: this.#opts.cwd ?? process.cwd(),
      });
    }

    // 3. Build agent
    this.#agent = this.#buildAgent();

    // Inject existing session messages
    const current = this.#sessions.current;
    if (current && current.messages.length > 0) {
      this.#agent.inject(current.messages);
    }

    // 4. Start TUI or pipe mode
    if (this.#opts.input) {
      await this.#runPipeMode(this.#opts.input);
    } else {
      await this.#runInteractive();
    }
  }

  // ─── Session picker ────────────────────────────────────────────────────────

  async #runSessionPicker(): Promise<string | null> {
    const sessions = await this.#sessions.list();
    if (sessions.length === 0) return null;

    return new Promise((resolve) => {
      const { unmount } = render(
        React.createElement(SessionPicker, {
          sessions,
          onSelect: (id) => {
            unmount();
            resolve(id);
          },
          onDelete: async (_id) => {
            await this.#sessions.list(); // refresh
          },
        })
      );
    });
  }

  // ─── Agent construction ────────────────────────────────────────────────────

  #buildAgent(): Agent {
    const { config, provider } = this.#opts;

    const middleware: MiddlewareFn[] = [...this.#registry.middleware];

    if (process.env.HELIX_DEBUG) {
      middleware.push(withLogging({ includeMessages: false }));
    }

    return new Agent({
      provider,
      model: modelId(config.model),
      systemPrompt: config.systemPrompt,
      tools: [...codingTools, ...this.#registry.tools],
      maxTurns: config.maxTurns ?? 50,
      parallelTools: true,
      middleware,
      signal: this.#abortController.signal,
    });
  }

  // ─── Interactive TUI mode ──────────────────────────────────────────────────

  async #runInteractive(): Promise<void> {
    const builtins = makeBuiltinCommands(this.#registry, this.#loader);
    const appEventHandlerRef: { current?: (event: AgentEvent) => void } = {};

    const handleSubmit = async (input: string): Promise<void> => {
      // Check extension input hooks first
      let processed = input;
      for (const { hook } of this.#registry.inputHooks) {
        const result = await hook(processed, this.#makeCommandContext(appEventHandlerRef.current));
        if (result.type === "handled") return;
        if (result.type === "transform") processed = result.input;
      }

      // Check slash commands
      const cmdResult = await routeCommand(
        processed,
        builtins,
        this.#registry,
        this.#makeCommandContext(appEventHandlerRef.current)
      );

      if (cmdResult) {
        if (cmdResult.type === "error" && appEventHandlerRef.current) {
          appEventHandlerRef.current({
            type: "error",
            error: new Error(cmdResult.message),
          });
        }
        // "passthrough" would send to agent
        if (cmdResult.type !== "passthrough") return;
        processed = cmdResult.input;
      }

      // Run agent turn
      if (!this.#agent) return;
      await this.#agent.run({
        input: processed,
        onEvent: async (event) => {
          appEventHandlerRef.current?.(event);

          // Extension event handlers
          for (const { ext } of this.#loader.extensions) {
            await ext.onAgentEvent?.(event, this.#makeCommandContext(appEventHandlerRef.current));
          }

          // Sync session on completion
          if (event.type === "done") {
            await this.#sessions.syncFromAgent(this.#agent?.state);
          }
        },
        signal: this.#abortController.signal,
      });
    };

    const appElement = React.createElement(NovaApp, {
      model: this.#opts.config.model,
      onSubmit: handleSubmit,
      registry: this.#registry,
      onExit: () => this.#shutdown(),
    });

    const { waitUntilExit } = render(appElement);

    // Capture the event handler from the rendered app
    // (Ink doesn't expose refs directly, so we use the static property trick)
    appEventHandlerRef.current = (
      NovaApp as unknown as { _handler?: (e: AgentEvent) => void }
    )._handler;

    await waitUntilExit();
  }

  // ─── Pipe mode ─────────────────────────────────────────────────────────────

  async #runPipeMode(input: string): Promise<void> {
    if (!this.#agent) return;

    const result = await this.#agent.run({
      input,
      onEvent: (event) => {
        if (event.type === "stream_event" && event.event.type === "text_delta") {
          process.stdout.write(event.event.delta);
        }
        if (event.type === "tool_call") {
          process.stderr.write(`[tool] ${event.name}\n`);
        }
      },
    });

    if (result.ok) {
      process.stdout.write("\n");
      if (process.env.HELIX_SHOW_COST) {
        process.stderr.write(
          `cost: $${result.value.state.totalCostUsd.toFixed(6)} · ` +
            `${result.value.state.totalTokens} tokens\n`
        );
      }
    }
  }

  // ─── Command context ───────────────────────────────────────────────────────

  #makeCommandContext(appEventHandler?: (event: AgentEvent) => void): CommandContext {
    const print = (line: string) => {
      appEventHandler?.({
        type: "stream_event" as const,
        event: { type: "text_delta", delta: line },
      });
    };

    return {
      state: this.#agent?.state ?? { messages: [], turns: 0, totalCostUsd: 0, totalTokens: 0 },
      config: this.#opts.config,
      print,
      sendToAgent: async (input) => {
        await this.#agent?.run({ input });
      },
      reset: () => {
        this.#agent?.reset();
        this.#sessions
          .create({
            model: this.#opts.config.model,
            workingDirectory: this.#opts.cwd,
          })
          .catch(console.error);
      },
      fork: async (atMessage) => {
        await this.#sessions.fork(atMessage);
      },
    };
  }

  // ─── Shutdown ──────────────────────────────────────────────────────────────

  async #shutdown(): Promise<void> {
    this.#abortController.abort();
    await this.#loader.unloadAll();
  }
}
