/**
 * Agent loop — improved over pi-mono's agent-core
 *
 * Key improvements:
 * 1. Middleware pipeline (like Express middleware, wraps each turn)
 * 2. Parallel tool execution when safe
 * 3. Turn budgeting to prevent runaway loops
 * 4. Rich event emission for observability
 * 5. Typed AgentState for consumers to inspect
 * 6. No coupling to TUI or any UI
 */

import type {
  AssistantContentPart,
  CompletionRequest,
  CompletionResponse,
  ContentPart,
  Message,
  Provider,
  Result,
  ToolDefinition,
  ToolResultPart,
} from "@helix/ai";
import { consumeStream, err, modelId, ok, userMsg } from "@helix/ai";
import type { MemoryManager } from "@helix/memory";
import { createMemoryTools } from "@helix/memory";
import type { SecurityConfig } from "@helix/security";

// ─── Events ───────────────────────────────────────────────────────────────────

export type AgentEvent =
  | { readonly type: "turn_start"; readonly turn: number; readonly messages: readonly Message[] }
  | { readonly type: "stream_event"; readonly event: StreamEvent }
  | { readonly type: "research_start" }
  | { readonly type: "research_tool"; readonly name: string; readonly result: string }
  | { readonly type: "research_complete"; readonly findings: readonly string[] }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly id: string;
      readonly name: string;
      readonly output: string;
      readonly isError: boolean;
      readonly durationMs: number;
    }
  | { readonly type: "turn_complete"; readonly response: CompletionResponse }
  | {
      readonly type: "done";
      readonly reason: "end_turn" | "max_turns" | "aborted" | "error";
      readonly messages: readonly Message[];
    }
  | { readonly type: "error"; readonly error: Error };

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

// ─── Middleware ───────────────────────────────────────────────────────────────

export interface TurnContext {
  /** The current conversation history (read-only snapshot) */
  readonly messages: readonly Message[];
  /** The request about to be sent to the provider */
  request: CompletionRequest;
  /** Mutable metadata bag for middleware to communicate */
  meta: Record<string, unknown>;
}

export type MiddlewareFn = (
  ctx: TurnContext,
  next: () => Promise<Result<CompletionResponse>>
) => Promise<Result<CompletionResponse>>;

// ─── Agent configuration ──────────────────────────────────────────────────────

export interface AgentConfig {
  readonly provider: Provider;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly tools?: readonly ToolDefinition[];
  readonly skillLoader?: SkillLoader;
  readonly memory?: MemoryManager;
  readonly security?: SecurityConfig;
  readonly researchPhase?: boolean;
  readonly researchMaxTurns?: number;
  /**
   * Maximum number of agentic turns (LLM calls) before forcing stop.
   * Prevents infinite loops. Default: 50
   */
  readonly maxTurns?: number;
  /**
   * Whether to execute independent tool calls in parallel.
   * Default: true
   */
  readonly parallelTools?: boolean;
  /**
   * Middleware applied in order around each LLM turn.
   * Useful for: logging, caching, rate limiting, context injection.
   */
  readonly middleware?: readonly MiddlewareFn[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

// ─── Agent state ──────────────────────────────────────────────────────────────

export interface AgentState {
  readonly messages: readonly Message[];
  readonly turns: number;
  readonly totalCostUsd: number;
  readonly totalTokens: number;
}

// ─── Agent run ────────────────────────────────────────────────────────────────

export interface AgentRunOptions {
  /** The user message to start with, or null to continue from existing messages */
  readonly input: string | null;
  /** True when run is triggered autonomously (e.g. scheduler). */
  readonly autonomous?: boolean;
  /** Optional channel hint for memory loading. */
  readonly channel?: "telegram" | "dashboard" | "scheduler" | string;
  readonly researchPhase?: boolean;
  readonly researchMaxTurns?: number;
  readonly sessionId?: string;
  readonly onEvent?: AgentEventHandler;
  readonly signal?: AbortSignal;
}

export interface AgentRunResult {
  readonly state: AgentState;
  readonly finalMessage: string;
  readonly stopReason: "end_turn" | "max_turns" | "aborted" | "error";
}

// ─── The Agent class ──────────────────────────────────────────────────────────

export class Agent {
  readonly #config: AgentConfig;
  readonly #tools: readonly ToolDefinition[];
  #messages: Message[] = [];
  #turns = 0;
  #totalCostUsd = 0;
  #totalTokens = 0;
  #skillsInjected = false;
  readonly #activeSkills = new Set<string>();
  readonly #pendingSkillActivations = new Set<string>();
  readonly #knownSkillIds = new Set<string>();
  #skillSummaryKey = "";
  readonly #baseSystemPrompt?: string;

  constructor(config: AgentConfig) {
    this.#config = config;
    this.#baseSystemPrompt = config.systemPrompt;
    const baseTools = [...(config.tools ?? [])];
    if (config.memory) {
      const existing = new Set(baseTools.map((tool) => tool.name));
      for (const tool of createMemoryTools(config.memory)) {
        if (!existing.has(tool.name)) baseTools.push(tool);
      }
    }
    this.#tools = baseTools;
    if (config.systemPrompt) {
      this.#messages.push({ role: "system", content: config.systemPrompt });
    }
  }

  get state(): AgentState {
    return {
      // Note: messages are a shallow copy; message objects are shared by design.
      messages: [...this.#messages],
      turns: this.#turns,
      totalCostUsd: this.#totalCostUsd,
      totalTokens: this.#totalTokens,
    };
  }

  /** Reset conversation history (but keep config/system prompt) */
  reset(): void {
    this.#messages = this.#config.systemPrompt
      ? [{ role: "system", content: this.#config.systemPrompt }]
      : [];
    this.#turns = 0;
    this.#totalCostUsd = 0;
    this.#totalTokens = 0;
  }

  /** Add messages to history without triggering a turn */
  inject(messages: readonly Message[]): void {
    this.#messages.push(...messages);
  }

  async run(options: AgentRunOptions): Promise<Result<AgentRunResult>> {
    const { input, onEvent, signal, autonomous, channel } = options;
    const emit = async (event: AgentEvent) => {
      await onEvent?.(event);
    };

    const maxTurns = this.#config.maxTurns ?? 50;
    const parallelTools = this.#config.parallelTools ?? true;
    const researchPhase = options.researchPhase ?? this.#config.researchPhase ?? false;
    const researchMaxTurns = options.researchMaxTurns ?? this.#config.researchMaxTurns ?? 3;

    if (this.#config.memory && input) {
      const ctx = await this.#config.memory.loadContext({
        channel,
        sessionId: options.sessionId,
        includeSearch: input ?? undefined,
      });
      this.#setMemoryBlock(formatMemoryContext(ctx));
    }

    if (this.#config.skillLoader) {
      await this.#refreshSkillsBlock(input ?? "", Boolean(autonomous));
    }

    if (input !== null) {
      this.#messages.push(userMsg(input));
    }

    if (researchPhase) {
      const findings = await this.#runResearchPhase({
        emit,
        maxTurns: researchMaxTurns,
        parallelTools,
        signal: signal ?? this.#config.signal,
        sessionId: options.sessionId ?? null,
      });
      if (findings.length > 0) {
        this.#setResearchBlock(`## Research findings\n${findings.join("\n")}`);
      }
    }

    let stopReason: AgentRunResult["stopReason"] = "end_turn";
    let lastError: Error | null = null;

    try {
      while (this.#turns < maxTurns) {
        if (signal?.aborted || this.#config.signal?.aborted) {
          stopReason = "aborted";
          break;
        }

        await this.#injectPendingSkillActivations();
        await this.#refreshSkillsBlock(this.#extractLastUserText() ?? "", Boolean(autonomous));

        this.#turns++;
        await emit({ type: "turn_start", turn: this.#turns, messages: this.state.messages });

        // Build request
        const baseRequest: CompletionRequest = {
          model: modelId(this.#config.model),
          messages: [...this.#messages],
          tools: this.#tools,
          maxTokens: this.#config.maxTokens,
          temperature: this.#config.temperature,
          signal: signal ?? this.#config.signal,
        };

        // Run through middleware chain
        const turnCtx: TurnContext = {
          messages: this.state.messages,
          request: baseRequest,
          meta: {},
        };

        const response = await this.#runWithMiddleware(turnCtx, async () => {
          const streamResult = await this.#config.provider.stream(turnCtx.request);
          if (!streamResult.ok) return streamResult;
          return consumeStream(streamResult.value, async (event) => {
            await emit({ type: "stream_event", event });
          });
        });

        if (!response.ok) {
          lastError = response.error;
          await emit({ type: "error", error: response.error });
          stopReason = "error";
          break;
        }

        const completion = response.value;
        this.#totalCostUsd += completion.cost.totalCostUsd;
        this.#totalTokens += completion.usage.totalTokens;

        // Add assistant message to history
        this.#messages.push(completion.message);
        this.#queueSkillsFromAssistant(completion.message);
        await emit({ type: "turn_complete", response: completion });

        if (completion.stopReason === "end_turn" || completion.stopReason === "stop_sequence") {
          stopReason = "end_turn";
          break;
        }

        if (completion.stopReason === "max_tokens") {
          // Keep going — let the model continue
          continue;
        }

        if (completion.stopReason === "tool_use") {
          // Execute tools
          const toolCalls = completion.message.content.filter(
            (c): c is Extract<AssistantContentPart, { type: "tool_call" }> => c.type === "tool_call"
          );

          const toolResults = await this.#executeTools(
            toolCalls,
            parallelTools,
            signal ?? this.#config.signal,
            emit,
            options.sessionId ?? null,
            { emitToolEvents: true }
          );

          this.#messages.push({ role: "tool", content: toolResults });
        }
      }

      if (this.#turns >= maxTurns && stopReason !== "aborted" && stopReason !== "error") {
        stopReason = "max_turns";
      }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      lastError = error;
      await emit({ type: "error", error });
      stopReason = "error";
    }

    await emit({ type: "done", reason: stopReason, messages: this.state.messages });

    // Extract final text response
    const finalMessage = this.#extractFinalText();

    if (stopReason === "error") {
      return err(lastError ?? new Error("Agent run failed"));
    }

    return ok({
      state: this.state,
      finalMessage,
      stopReason,
    });
  }

  async #runResearchPhase(args: {
    emit: AgentEventHandler;
    maxTurns: number;
    parallelTools: boolean;
    signal: AbortSignal | undefined;
    sessionId: string | null;
  }): Promise<string[]> {
    const { emit, maxTurns, parallelTools, signal, sessionId } = args;
    const findings: string[] = [];
    const researchPrompt =
      "You are in research mode. Before responding to the user, gather the information you need using your available tools. " +
      "Do NOT respond to the user yet — only use tools to research. When you have enough information, end with:\n" +
      "[research-complete]";
    const researchMessages: Message[] = [
      { role: "system", content: researchPrompt },
      ...this.#messages,
    ];

    await emit({ type: "research_start" });

    for (let turn = 0; turn < maxTurns; turn++) {
      const request: CompletionRequest = {
        model: modelId(this.#config.model),
        messages: researchMessages,
        tools: this.#tools,
        maxTokens: this.#config.maxTokens,
        temperature: this.#config.temperature,
        signal,
      };

      const response = await this.#config.provider.stream(request);
      if (!response.ok) {
        await emit({ type: "error", error: response.error });
        break;
      }

      const completionResult = await consumeStream(response.value, async () => {});
      if (!completionResult.ok) {
        await emit({ type: "error", error: completionResult.error });
        break;
      }

      const completion = completionResult.value;
      this.#totalCostUsd += completion.cost.totalCostUsd;
      this.#totalTokens += completion.usage.totalTokens;

      researchMessages.push(completion.message);
      const assistantText = this.#extractMessageText(completion.message);
      const hasComplete = assistantText.includes("[research-complete]");

      if (completion.stopReason === "tool_use") {
        const toolCalls = completion.message.content.filter(
          (c): c is Extract<AssistantContentPart, { type: "tool_call" }> => c.type === "tool_call"
        );
        const toolResults = await this.#executeTools(
          toolCalls,
          parallelTools,
          signal,
          emit,
          sessionId,
          {
            emitToolEvents: false,
            onResult: (name, result, isError) => {
              const line = isError ? `${name}: ERROR ${result}` : `${name}: ${result}`;
              findings.push(line);
              void emit({ type: "research_tool", name, result: line });
            },
          }
        );
        researchMessages.push({ role: "tool", content: toolResults });
        if (hasComplete) break;
        continue;
      }

      if (
        hasComplete ||
        completion.stopReason === "end_turn" ||
        completion.stopReason === "stop_sequence"
      ) {
        break;
      }
    }

    await emit({ type: "research_complete", findings });
    return findings;
  }

  async #executeTools(
    toolCalls: Array<Extract<AssistantContentPart, { type: "tool_call" }>>,
    parallel: boolean,
    signal: AbortSignal | undefined,
    emit: AgentEventHandler,
    sessionId: string | null,
    options?: {
      emitToolEvents?: boolean;
      onResult?: (name: string, result: string, isError: boolean) => void;
    }
  ): Promise<ToolResultPart[]> {
    const emitToolEvents = options?.emitToolEvents ?? true;
    const toolMap = new Map(this.#config.tools?.map((t) => [t.name, t]) ?? []);
    const skillLoader = this.#config.skillLoader;
    const toolList = this.#config.tools ?? [];
    const security = this.#config.security;

    const formatToolOutput = (
      output: unknown,
      formatter?: (output: unknown) => string | null | undefined
    ): string => {
      if (formatter) {
        const formatted = formatter(output);
        if (formatted) return formatted;
      }
      if (typeof output === "string") return output;
      return output ? JSON.stringify(output) : "(no output)";
    };

    const executeWithHandling = async (
      call: Extract<AssistantContentPart, { type: "tool_call" }>,
      name: string,
      run: () => Promise<{ output: unknown; isError: boolean }>,
      formatter?: (output: unknown) => string | null | undefined
    ): Promise<ToolResultPart> => {
      if (emitToolEvents) {
        await emit({ type: "tool_call", id: call.id, name, input: call.input });
      }
      const start = Date.now();
      try {
        const { output, isError } = await run();
        const content = formatToolOutput(output, formatter);
        const durationMs = Date.now() - start;
        if (emitToolEvents) {
          await emit({
            type: "tool_result",
            id: call.id,
            name,
            output: content,
            isError,
            durationMs,
          });
        }
        options?.onResult?.(name, content, isError);
        return { type: "tool_result", id: call.id, content, isError };
      } catch (e) {
        const content = e instanceof Error ? e.message : String(e);
        const durationMs = Date.now() - start;
        if (emitToolEvents) {
          await emit({
            type: "tool_result",
            id: call.id,
            name,
            output: content,
            isError: true,
            durationMs,
          });
        }
        options?.onResult?.(name, content, true);
        return { type: "tool_result", id: call.id, content, isError: true };
      }
    };

    const executeOne = async (
      call: Extract<AssistantContentPart, { type: "tool_call" }>
    ): Promise<ToolResultPart> => {
      if (
        (call.name === "skill_execute" || call.name === "skill.execute") &&
        skillLoader?.execute
      ) {
        let payload = call.input as {
          skillId?: string;
          script?: string;
          scriptName?: string;
          input?: unknown;
          capabilities?: unknown;
        };
        if (security?.vault) {
          payload = (await security.vault.inject(payload, call.name)) as typeof payload;
        }
        if (security?.dlp && security.scanToolInputs !== false) {
          const inputResult = await security.dlp.scanInput(
            call.name,
            payload,
            sessionId ?? "unknown"
          );
          if (!inputResult.clean && inputResult.requiresApproval && inputResult.approvalRequest) {
            const decision = await security.dlp.waitForApproval(
              inputResult.approvalRequest,
              inputResult.redactedValue
            );
            if (decision.useRedacted && inputResult.redactedValue !== undefined) {
              payload = inputResult.redactedValue as typeof payload;
            }
            if (decision.status === "denied") {
              return executeWithHandling(call, call.name, async () => ({
                output: "Skill execution blocked by DLP",
                isError: true,
              }));
            }
          }
        }
        const script = payload?.scriptName ?? payload?.script;
        if (!payload?.skillId || !script) {
          return executeWithHandling(call, call.name, async () => ({
            output: "Invalid skill.execute payload",
            isError: true,
          }));
        }

        return executeWithHandling(call, call.name, async () => {
          const result = await skillLoader.execute({
            skillId: payload.skillId,
            script,
            input: payload.input,
            tools: toolList,
            capabilities: payload.capabilities,
          });
          const output =
            result.output !== undefined ? result.output : result.error ? result.error : null;
          if (security?.dlp && security.scanToolOutputs !== false) {
            const outputResult = await security.dlp.scanOutput(
              call.name,
              output,
              sessionId ?? "unknown"
            );
            if (
              !outputResult.clean &&
              outputResult.requiresApproval &&
              outputResult.approvalRequest
            ) {
              const decision = await security.dlp.waitForApproval(
                outputResult.approvalRequest,
                outputResult.redactedValue
              );
              if (decision.useRedacted && outputResult.redactedValue !== undefined) {
                return { output: outputResult.redactedValue, isError: !result.success };
              }
              if (decision.status === "denied") {
                throw new Error("Output blocked by DLP");
              }
            }
          }
          return { output, isError: !result.success };
        });
      }

      const tool = toolMap.get(call.name);
      if (!tool) {
        const result: ToolResultPart = {
          type: "tool_result",
          id: call.id,
          content: `Unknown tool: ${call.name}`,
          isError: true,
        };
        if (emitToolEvents) {
          await emit({
            type: "tool_result",
            id: call.id,
            name: call.name,
            output: result.content,
            isError: true,
            durationMs: 0,
          });
        }
        options?.onResult?.(call.name, result.content, true);
        return result;
      }

      return executeWithHandling(
        call,
        call.name,
        async () => {
          const abortSignal = signal as AbortSignal | undefined;
          let toolInput: unknown = call.input;

          if (security?.vault) {
            toolInput = await security.vault.inject(toolInput, tool.name);
          }

          if (security?.dlp && security.scanToolInputs !== false) {
            const inputResult = await security.dlp.scanInput(
              tool.name,
              toolInput,
              sessionId ?? "unknown"
            );
            if (!inputResult.clean && inputResult.requiresApproval && inputResult.approvalRequest) {
              const decision = await security.dlp.waitForApproval(
                inputResult.approvalRequest,
                inputResult.redactedValue
              );
              if (decision.useRedacted && inputResult.redactedValue !== undefined) {
                toolInput = inputResult.redactedValue;
              }
              if (decision.status === "denied") {
                throw new Error("Input blocked by DLP");
              }
            }
          }

          let output = await (tool as ToolDefinition<unknown, unknown>).execute(
            toolInput,
            abortSignal as AbortSignal
          );

          if (security?.dlp && security.scanToolOutputs !== false) {
            const outputResult = await security.dlp.scanOutput(
              tool.name,
              output,
              sessionId ?? "unknown"
            );
            if (
              !outputResult.clean &&
              outputResult.requiresApproval &&
              outputResult.approvalRequest
            ) {
              const decision = await security.dlp.waitForApproval(
                outputResult.approvalRequest,
                outputResult.redactedValue
              );
              if (decision.useRedacted && outputResult.redactedValue !== undefined) {
                output = outputResult.redactedValue;
              }
              if (decision.status === "denied") {
                throw new Error("Output blocked by DLP");
              }
            }
          }

          return { output, isError: false };
        },
        tool.formatOutput
      );
    };

    if (parallel && toolCalls.length > 1) {
      return Promise.all(toolCalls.map(executeOne));
    }

    const results: ToolResultPart[] = [];
    for (const call of toolCalls) {
      results.push(await executeOne(call));
    }
    return results;
  }

  async #runWithMiddleware(
    ctx: TurnContext,
    final: () => Promise<Result<CompletionResponse>>
  ): Promise<Result<CompletionResponse>> {
    const middleware = this.#config.middleware ?? [];

    const buildChain = (index: number): (() => Promise<Result<CompletionResponse>>) => {
      if (index >= middleware.length) return final;
      const mw = middleware[index];
      if (!mw) return final;
      return () => mw(ctx, buildChain(index + 1));
    };

    return buildChain(0)();
  }

  #extractFinalText(): string {
    for (let i = this.#messages.length - 1; i >= 0; i--) {
      const msg = this.#messages[i];
      if (msg?.role === "assistant") {
        const textParts = msg.content
          .filter((c): c is Extract<AssistantContentPart, { type: "text" }> => c.type === "text")
          .map((c) => c.text);
        if (textParts.length > 0) return textParts.join("");
      }
    }
    return "";
  }

  #extractMessageText(message: Message): string {
    const content = message.content;
    if (typeof content === "string") return content;
    return content
      .filter((c): c is Extract<AssistantContentPart, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
  }

  #extractLastUserText(): string | null {
    for (let i = this.#messages.length - 1; i >= 0; i--) {
      const msg = this.#messages[i];
      if (msg?.role === "user") {
        const content = msg.content;
        if (typeof content === "string") return content;
        const textParts = content
          .filter((c): c is Extract<ContentPart, { type: "text" }> => c.type === "text")
          .map((c) => c.text);
        return textParts.join("");
      }
    }
    return null;
  }

  #setMemoryBlock(content: string | null): void {
    const existingIndex = this.#messages.findIndex(
      (msg) => msg.role === "system" && isMemoryBlock(msg.content)
    );
    if (!content) {
      if (existingIndex >= 0) this.#messages.splice(existingIndex, 1);
      return;
    }

    const systemIndex = this.#baseSystemPrompt
      ? this.#messages.findIndex(
          (msg) => msg.role === "system" && msg.content === this.#baseSystemPrompt
        )
      : -1;
    const insertAt = systemIndex >= 0 ? systemIndex + 1 : 0;
    if (existingIndex >= 0) {
      this.#messages[existingIndex] = { role: "system", content };
    } else {
      this.#messages.splice(insertAt, 0, { role: "system", content });
    }
  }

  #setResearchBlock(content: string | null): void {
    const existingIndex = this.#messages.findIndex(
      (msg) => msg.role === "system" && isResearchBlock(msg.content)
    );
    if (!content) {
      if (existingIndex >= 0) this.#messages.splice(existingIndex, 1);
      return;
    }

    const memoryIndex = this.#messages.findIndex(
      (msg) => msg.role === "system" && isMemoryBlock(msg.content)
    );
    const systemIndex = this.#baseSystemPrompt
      ? this.#messages.findIndex(
          (msg) => msg.role === "system" && msg.content === this.#baseSystemPrompt
        )
      : -1;
    const insertAt = memoryIndex >= 0 ? memoryIndex + 1 : systemIndex >= 0 ? systemIndex + 1 : 0;
    if (existingIndex >= 0) {
      this.#messages[existingIndex] = { role: "system", content };
    } else {
      this.#messages.splice(insertAt, 0, { role: "system", content });
    }
  }

  #scoreSkillRelevance(skill: SkillSummary, message: string): number {
    const text = message.toLowerCase();
    let score = 0;
    if (text.includes(skill.name.toLowerCase())) score += 10;
    for (const tag of skill.tags ?? []) {
      if (text.includes(tag.toLowerCase())) score += 3;
    }
    const keywords = skill.description.toLowerCase().split(/\s+/);
    for (const kw of keywords) {
      if (kw.length > 4 && text.includes(kw)) score += 1;
    }
    return score;
  }

  #buildSkillsBlock(
    summaries: SkillSummary[],
    suggestedIds: Set<string>,
    autonomous: boolean
  ): string {
    const active = summaries.filter((s) => this.#activeSkills.has(s.id));
    const available = summaries.filter((s) => !this.#activeSkills.has(s.id));
    const lines: string[] = [
      "## Available Skills",
      "",
      `You have access to these skills: ${summaries.map((s) => s.id).join(", ")}`,
      "",
      "You have access to the following skills. Activate a skill by including",
      "[skill:skill-id] anywhere in your response when you determine it is relevant to the current task.",
      "Once activated, the full skill instructions will be available for subsequent turns.",
      "To execute a skill's script, call skill_execute with the skillId, scriptName, and input parameters.",
      "",
    ];
    for (const skill of available) {
      const suggested = suggestedIds.has(skill.id) ? " (suggested)" : "";
      lines.push(`- **${skill.id}** (${skill.tier}): ${skill.description}${suggested}`);
      if (skill.allowedTools?.length) {
        lines.push(`  Tools: ${skill.allowedTools.join(", ")}`);
      }
      if (skill.requiresApproval?.length) {
        lines.push(`  Requires approval: ${skill.requiresApproval.join(", ")}`);
      }
      if (skill.scripts) {
        lines.push(`  Scripts: ${skill.scripts.length > 0 ? skill.scripts.join(", ") : "none"}`);
      }
      lines.push("");
    }

    if (autonomous) {
      lines.push(
        "Based on your task, consider whether any available skills are relevant. You do not need to be asked —",
        "activate skills proactively when they would improve your response.",
        ""
      );
    }

    lines.push("## Active Skills");
    if (active.length === 0) {
      lines.push("- (none)");
    } else {
      for (const skill of active) {
        lines.push(`- **${skill.id}**: full instructions loaded`);
      }
    }

    return lines.join("\n");
  }

  async #refreshSkillsBlock(message: string, autonomous: boolean): Promise<void> {
    const loader = this.#config.skillLoader;
    if (!loader) return;
    const summaries = await loader.discover();
    if (summaries.length === 0) return;

    for (const summary of summaries) this.#knownSkillIds.add(summary.id);
    const key = summaries
      .map((s) => s.id)
      .sort()
      .join("|");
    const suggestedIds = new Set<string>();
    for (const summary of summaries) {
      if (this.#activeSkills.has(summary.id)) continue;
      const score = this.#scoreSkillRelevance(summary, message);
      if (score >= 3) suggestedIds.add(summary.id);
    }

    if (key !== this.#skillSummaryKey) {
      this.#skillsInjected = false;
      this.#skillSummaryKey = key;
    }

    if (!this.#skillsInjected) {
      const content = this.#buildSkillsBlock(summaries, suggestedIds, autonomous);
      this.#messages = this.#messages.filter(
        (msg) => !(msg.role === "system" && msg.content.startsWith("## Available Skills"))
      );
      this.#messages.unshift({ role: "system", content });
      this.#skillsInjected = true;
    } else {
      const index = this.#messages.findIndex(
        (msg) => msg.role === "system" && msg.content.startsWith("## Available Skills")
      );
      if (index >= 0) {
        this.#messages[index] = {
          role: "system",
          content: this.#buildSkillsBlock(summaries, suggestedIds, autonomous),
        };
      }
    }
  }

  #queueSkillsFromAssistant(message: Message): void {
    if (message.role !== "assistant") return;
    const textParts = message.content
      .filter((c): c is Extract<AssistantContentPart, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    this.#queueSkillsFromText(textParts);
  }

  #queueSkillsFromText(text: string): void {
    if (!text) return;
    for (const match of text.matchAll(/\[skill:([a-zA-Z0-9_-]+)\]/g)) {
      if (match[1] && !this.#activeSkills.has(match[1])) {
        this.#pendingSkillActivations.add(match[1]);
      }
    }
    const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const id of this.#knownSkillIds) {
      if (this.#activeSkills.has(id)) continue;
      const pattern = new RegExp(`(?<![A-Za-z0-9.])@${escapeRegex(id)}\\b`, "i");
      if (pattern.test(text)) {
        this.#pendingSkillActivations.add(id);
      }
    }
    for (const match of text.matchAll(/skill:([a-zA-Z0-9_-]+)/g)) {
      if (match[1] && !this.#activeSkills.has(match[1])) {
        this.#pendingSkillActivations.add(match[1]);
      }
    }
  }

  async #injectPendingSkillActivations(): Promise<void> {
    const loader = this.#config.skillLoader;
    if (!loader) return;
    if (this.#pendingSkillActivations.size === 0) return;
    const pending = Array.from(this.#pendingSkillActivations);
    this.#pendingSkillActivations.clear();
    for (const id of pending) {
      const context = await loader.activate(id);
      if (this.#activeSkills.has(id)) continue;
      this.#messages.push({ role: "system", content: context.instructions });
      this.#activeSkills.add(id);
    }
  }
}

function formatMemoryContext(ctx: {
  facts: string[];
  recentEpisodes: string[];
  procedures: string[];
  searchResults?: string[];
}): string | null {
  const lines: string[] = [];
  if (ctx.facts.length > 0) {
    lines.push("## What I know", ...ctx.facts, "");
  }
  if (ctx.recentEpisodes.length > 0) {
    lines.push("## Recent history", ...ctx.recentEpisodes, "");
  }
  if (ctx.procedures.length > 0) {
    lines.push("## How to do things here", ...ctx.procedures, "");
  }
  if (ctx.searchResults && ctx.searchResults.length > 0) {
    lines.push("## Relevant context", ...ctx.searchResults, "");
  }
  if (lines.length === 0) return null;
  return lines.join("\n").trim();
}

function isMemoryBlock(content: string): boolean {
  return (
    content.includes("## What I know") ||
    content.includes("## Recent history") ||
    content.includes("## How to do things here") ||
    content.includes("## Relevant context")
  );
}

function isResearchBlock(content: string): boolean {
  return content.includes("## Research findings");
}

export interface SkillLoader {
  discover(): Promise<SkillSummary[]>;
  activate(skillId: string): Promise<{ instructions: string; requiresApproval?: string[] }>;
  execute?: (args: {
    skillId: string;
    script: string;
    input: unknown;
    tools: readonly ToolDefinition[];
    capabilities?: unknown;
  }) => Promise<{
    success: boolean;
    output: unknown;
    logs?: string[];
    error?: string | null;
    durationMs?: number;
  }>;
}

export interface SkillSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tier: "CORE" | "VERIFIED" | "COMMUNITY" | "UNVERIFIED";
  readonly tags?: string[];
  readonly allowedTools?: string[];
  readonly requiresApproval?: string[];
  readonly scripts?: string[];
}

// ─── Convenience: one-shot completion ─────────────────────────────────────────

export async function runAgent(
  config: AgentConfig,
  input: string,
  onEvent?: AgentEventHandler
): Promise<Result<AgentRunResult>> {
  const agent = new Agent(config);
  return agent.run({ input, onEvent });
}
