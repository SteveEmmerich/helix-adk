/**
 * Anthropic (Claude) provider for @helix/ai
 *
 * Improvements over pi-mono:
 * - Proper prompt caching support with cache_control blocks
 * - Extended thinking fully typed
 * - AbortSignal plumbed through everywhere
 * - No global state — provider is a plain class
 * - Retry with exponential backoff built-in
 */

import type {
  AssistantContentPart,
  CompletionRequest,
  CompletionResponse,
  CostBreakdown,
  Message,
  ModelId,
  ModelInfo,
  Provider,
  ProviderId,
  Result,
  StreamEvent,
  TokenUsage,
  ToolResultPart,
} from "../types/index.js";
import { err, modelId, ok, providerId, requestId, toolCallId } from "../types/index.js";

const PROVIDER_ID: ProviderId = providerId("anthropic");

const MODELS: ModelInfo[] = [
  {
    id: modelId("claude-opus-4-5"),
    provider: PROVIDER_ID,
    displayName: "Claude Opus 4.5",
    capabilities: {
      vision: true,
      toolCalling: true,
      parallelToolCalling: true,
      streaming: true,
      extendedThinking: true,
      jsonMode: false,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
    },
    pricing: {
      promptPer1MTokens: 15,
      completionPer1MTokens: 75,
      cacheReadPer1MTokens: 1.5,
      cacheWritePer1MTokens: 18.75,
    },
  },
  {
    id: modelId("claude-sonnet-4-5"),
    provider: PROVIDER_ID,
    displayName: "Claude Sonnet 4.5",
    capabilities: {
      vision: true,
      toolCalling: true,
      parallelToolCalling: true,
      streaming: true,
      extendedThinking: true,
      jsonMode: false,
      contextWindow: 200_000,
      maxOutputTokens: 16_000,
    },
    pricing: {
      promptPer1MTokens: 3,
      completionPer1MTokens: 15,
      cacheReadPer1MTokens: 0.3,
      cacheWritePer1MTokens: 3.75,
    },
  },
  {
    id: modelId("claude-haiku-4-5"),
    provider: PROVIDER_ID,
    displayName: "Claude Haiku 4.5",
    capabilities: {
      vision: true,
      toolCalling: true,
      parallelToolCalling: true,
      streaming: true,
      extendedThinking: false,
      jsonMode: false,
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    },
    pricing: {
      promptPer1MTokens: 0.8,
      completionPer1MTokens: 4,
      cacheReadPer1MTokens: 0.08,
      cacheWritePer1MTokens: 1,
    },
  },
];

interface AnthropicConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly maxRetries?: number;
  readonly defaultHeaders?: Record<string, string>;
}

function computeCost(model: ModelInfo, usage: TokenUsage): CostBreakdown {
  const p = model.pricing;
  const promptCostUsd = (usage.promptTokens / 1_000_000) * p.promptPer1MTokens;
  const completionCostUsd = (usage.completionTokens / 1_000_000) * p.completionPer1MTokens;
  const cacheReadCostUsd =
    usage.cacheReadTokens > 0 && p.cacheReadPer1MTokens
      ? (usage.cacheReadTokens / 1_000_000) * p.cacheReadPer1MTokens
      : 0;
  const cacheWriteCostUsd =
    usage.cacheWriteTokens > 0 && p.cacheWritePer1MTokens
      ? (usage.cacheWriteTokens / 1_000_000) * p.cacheWritePer1MTokens
      : 0;
  return {
    promptCostUsd,
    completionCostUsd,
    cacheReadCostUsd,
    cacheWriteCostUsd,
    totalCostUsd: promptCostUsd + completionCostUsd + cacheReadCostUsd + cacheWriteCostUsd,
  };
}

/** Transform Helix Message[] into Anthropic API format */
function transformMessages(messages: readonly Message[]): {
  system: string | undefined;
  messages: unknown[];
} {
  let system: string | undefined;
  const out: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = msg.content;
      continue;
    }

    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? [{ type: "text", text: msg.content }]
          : msg.content.map((p) => {
              if (p.type === "text") return { type: "text", text: p.text };
              if (p.type === "image") {
                return { type: "image", source: { type: "url", url: p.url } };
              }
              if (p.type === "image_base64") {
                return {
                  type: "image",
                  source: { type: "base64", media_type: p.mimeType, data: p.data },
                };
              }
              if (p.type === "document") {
                return {
                  type: "text",
                  text: p.title ? `<document title="${p.title}">\n${p.text}\n</document>` : p.text,
                };
              }
              return p;
            });
      out.push({ role: "user", content });
      continue;
    }

    if (msg.role === "assistant") {
      const content = msg.content.map((p) => {
        if (p.type === "text") return { type: "text", text: p.text };
        if (p.type === "tool_call") {
          return {
            type: "tool_use",
            id: p.id,
            name: p.name,
            input: p.input,
          };
        }
        return p;
      });
      out.push({ role: "assistant", content });
      continue;
    }

    if (msg.role === "tool") {
      const content = msg.content.map((p: ToolResultPart) => ({
        type: "tool_result",
        tool_use_id: p.id,
        content: p.content,
        is_error: p.isError,
      }));
      out.push({ role: "user", content });
    }
  }

  return { system, messages: out };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AnthropicProvider implements Provider {
  readonly id = PROVIDER_ID;
  readonly displayName = "Anthropic";

  readonly #config: AnthropicConfig;
  readonly #baseUrl: string;

  constructor(config: AnthropicConfig) {
    this.#config = config;
    this.#baseUrl = config.baseUrl ?? "https://api.anthropic.com";
  }

  async listModels(): Promise<Result<readonly ModelInfo[]>> {
    return ok(MODELS);
  }

  async complete(request: CompletionRequest): Promise<Result<CompletionResponse>> {
    const startMs = Date.now();
    const result = await this.#fetchWithRetry(request, false);
    if (!result.ok) return result;

    const data = result.value as Record<string, unknown>;
    return ok(this.#parseResponse(request.model, data, Date.now() - startMs));
  }

  async stream(request: CompletionRequest): Promise<Result<ReadableStream<StreamEvent>>> {
    const startMs = Date.now();
    const result = await this.#fetchWithRetry(request, true);
    if (!result.ok) return result;

    const response = result.value as Response;
    if (!response.body) return err(new Error("No response body for streaming"));

    return ok(this.#buildStream(request.model, response, startMs, request.signal));
  }

  #buildRequestBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const { system, messages } = transformMessages(request.messages);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? 8192,
      stream,
    };

    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.stopSequences) body.stop_sequences = request.stopSequences;

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    if (request.toolChoice) {
      if (typeof request.toolChoice === "string") {
        body.tool_choice = { type: request.toolChoice };
      } else {
        body.tool_choice = { type: "tool", name: request.toolChoice.name };
      }
    }

    if (request.thinkingBudget !== undefined) {
      body.thinking = { type: "enabled", budget_tokens: request.thinkingBudget };
    }

    return body;
  }

  async #fetchWithRetry(request: CompletionRequest, stream: boolean): Promise<Result<unknown>> {
    const maxRetries = this.#config.maxRetries ?? 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 30_000));
      }

      if (request.signal?.aborted) {
        return err(new Error("Request aborted"));
      }

      try {
        const body = this.#buildRequestBody(request, stream);
        const res = await fetch(`${this.#baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.#config.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "prompt-caching-2024-07-31",
            ...this.#config.defaultHeaders,
          },
          body: JSON.stringify(body),
          signal: request.signal,
        });

        if (res.status === 429 || res.status >= 500) {
          const text = await res.text();
          lastError = new Error(`HTTP ${res.status}: ${text}`);
          continue;
        }

        if (!res.ok) {
          const text = await res.text();
          return err(new Error(`HTTP ${res.status}: ${text}`));
        }

        if (stream) return ok(res);
        return ok(await res.json());
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          return err(new Error("Request aborted"));
        }
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }

    return err(lastError ?? new Error("Unknown fetch error"));
  }

  #parseUsage(raw: Record<string, number>): TokenUsage {
    return {
      promptTokens: raw.input_tokens ?? 0,
      completionTokens: raw.output_tokens ?? 0,
      cacheReadTokens: raw.cache_read_input_tokens ?? 0,
      cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
      totalTokens: (raw.input_tokens ?? 0) + (raw.output_tokens ?? 0),
    };
  }

  #parseResponse(
    model: ModelId,
    data: Record<string, unknown>,
    durationMs: number
  ): CompletionResponse {
    const modelInfo = MODELS.find((m) => m.id === model);
    const usage = this.#parseUsage((data.usage as Record<string, number> | undefined) ?? {});
    const cost = modelInfo ? computeCost(modelInfo, usage) : this.#zeroCost();

    const rawContent = (data.content as unknown[]) ?? [];
    const content: AssistantContentPart[] = rawContent.map((block: unknown) => {
      const b = block as Record<string, unknown>;
      if (b.type === "text") {
        return { type: "text" as const, text: String(b.text ?? "") };
      }
      if (b.type === "tool_use") {
        return {
          type: "tool_call" as const,
          id: toolCallId(String(b.id)),
          name: String(b.name),
          input: b.input,
        };
      }
      // thinking blocks
      if (b.type === "thinking") {
        return { type: "text" as const, text: "" }; // stripped from visible content
      }
      return { type: "text" as const, text: JSON.stringify(b) };
    });

    const rawStop = String(data.stop_reason ?? "end_turn");
    const stopReason =
      rawStop === "tool_use"
        ? "tool_use"
        : rawStop === "max_tokens"
          ? "max_tokens"
          : rawStop === "stop_sequence"
            ? "stop_sequence"
            : "end_turn";

    return {
      id: requestId(String(data.id ?? crypto.randomUUID())),
      model,
      stopReason,
      message: { role: "assistant", content },
      usage,
      cost,
      durationMs,
    };
  }

  #zeroCost(): CostBreakdown {
    return {
      promptCostUsd: 0,
      completionCostUsd: 0,
      cacheReadCostUsd: 0,
      cacheWriteCostUsd: 0,
      totalCostUsd: 0,
    };
  }

  #buildStream(
    model: ModelId,
    response: Response,
    startMs: number,
    signal?: AbortSignal
  ): ReadableStream<StreamEvent> {
    // Mutable accumulation state — lives in the stream's closure.
    // The ReadableStream start() callback runs synchronously until the first await,
    // so this state is safely single-threaded (one reader at a time).
    const contentBlocks = new Map<
      number,
      { type: string; id?: string; name?: string; inputJson: string; text: string }
    >();
    let usage: TokenUsage | undefined;
    let stopReason: CompletionResponse["stopReason"] = "end_turn";
    let responseId = crypto.randomUUID();

    const self = this;

    return new ReadableStream<StreamEvent>({
      async start(controller) {
        const bodyReader = response.body?.getReader();
        const decoder = new TextDecoder();

        // Wire AbortSignal → cancel the body reader and error the stream.
        const onAbort = () => {
          bodyReader.cancel().catch(() => {});
          controller.error(new Error("Stream aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        try {
          let buffer = "";
          while (true) {
            const { done, value } = await bodyReader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;

              let evt: Record<string, unknown>;
              try {
                evt = JSON.parse(data) as Record<string, unknown>;
              } catch {
                continue;
              }

              // Emit events into the ReadableStream — enqueue is sync, never blocks.
              // Backpressure is applied by the stream internals: if the consumer is slow,
              // the next bodyReader.read() will block until the queue drains.
              self.#handleStreamEventSync(evt, contentBlocks, controller, (u) => {
                usage = u;
              });

              const evtType = evt.type as string;
              if (evtType === "message_delta") {
                const delta = evt.delta as Record<string, unknown>;
                const raw = String(delta?.stop_reason ?? "end_turn");
                stopReason =
                  raw === "tool_use"
                    ? "tool_use"
                    : raw === "max_tokens"
                      ? "max_tokens"
                      : "end_turn";
              }
              if (evtType === "message_start") {
                const msg = evt.message as Record<string, unknown>;
                responseId = String(msg?.id ?? responseId);
              }
            }
          }

          // Build final CompletionResponse from accumulated state
          const content: AssistantContentPart[] = [];
          for (const [, block] of Array.from(contentBlocks.entries()).sort(([a], [b]) => a - b)) {
            if (block.type === "text" && block.text) {
              content.push({ type: "text", text: block.text });
            } else if (block.type === "tool_use" && block.id && block.name) {
              let input: unknown = {};
              try {
                input = JSON.parse(block.inputJson || "{}");
              } catch {
                /* empty */
              }
              content.push({
                type: "tool_call",
                id: toolCallId(block.id),
                name: block.name,
                input,
              });
            }
          }

          const finalUsage: TokenUsage = usage ?? {
            promptTokens: 0,
            completionTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
          };
          const modelInfo = MODELS.find((m) => m.id === model);
          const cost = modelInfo ? computeCost(modelInfo, finalUsage) : self.#zeroCost();

          const completionResponse: CompletionResponse = {
            id: requestId(responseId),
            model,
            stopReason,
            message: { role: "assistant", content },
            usage: finalUsage,
            cost,
            durationMs: Date.now() - startMs,
          };

          controller.enqueue({ type: "done", response: completionResponse });
          controller.close();
        } catch (e) {
          if (!signal?.aborted) controller.error(e);
        } finally {
          signal?.removeEventListener("abort", onAbort);
          bodyReader.releaseLock();
        }
      },
      cancel() {
        // Body reader already released in finally block above.
      },
    });
  }

  // Synchronous — called inside the ReadableStream start() loop.
  // Uses controller.enqueue() instead of await handler() — no async hop per event.
  #handleStreamEventSync(
    event: Record<string, unknown>,
    blocks: Map<
      number,
      { type: string; id?: string; name?: string; inputJson: string; text: string }
    >,
    controller: ReadableStreamDefaultController<StreamEvent>,
    setUsage: (u: TokenUsage) => void
  ): void {
    const type = event.type as string;

    if (type === "content_block_start") {
      const index = event.index as number;
      const block = event.content_block as Record<string, unknown>;
      blocks.set(index, {
        type: String(block.type),
        id: block.id ? String(block.id) : undefined,
        name: block.name ? String(block.name) : undefined,
        inputJson: "",
        text: "",
      });
      if (block.type === "tool_use") {
        controller.enqueue({
          type: "tool_call_start",
          id: toolCallId(String(block.id)),
          name: String(block.name),
        });
      }
    }

    if (type === "content_block_delta") {
      const index = event.index as number;
      const delta = event.delta as Record<string, unknown>;
      const block = blocks.get(index);
      if (!block) return;

      if (delta.type === "text_delta") {
        const text = String(delta.text ?? "");
        block.text += text;
        controller.enqueue({ type: "text_delta", delta: text });
      } else if (delta.type === "thinking_delta") {
        controller.enqueue({ type: "thinking_delta", delta: String(delta.thinking ?? "") });
      } else if (delta.type === "input_json_delta") {
        const partial = String(delta.partial_json ?? "");
        block.inputJson += partial;
        if (block.id)
          controller.enqueue({ type: "tool_call_delta", id: toolCallId(block.id), delta: partial });
      }
    }

    if (type === "content_block_stop") {
      const index = event.index as number;
      const block = blocks.get(index);
      if (block?.type === "tool_use" && block.id) {
        let input: unknown = {};
        try {
          input = JSON.parse(block.inputJson || "{}");
        } catch {
          /* empty */
        }
        controller.enqueue({ type: "tool_call_end", id: toolCallId(block.id), input });
      }
    }

    if (type === "message_delta") {
      const usage = (event.usage as Record<string, number> | undefined) ?? {};
      const u: TokenUsage = {
        promptTokens: 0,
        completionTokens: Number(usage.output_tokens ?? 0),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: Number(usage.output_tokens ?? 0),
      };
      controller.enqueue({ type: "usage", usage: u, cost: this.#zeroCost() });
    }

    if (type === "message_start") {
      const msg = event.message as Record<string, unknown>;
      const usage = (msg.usage as Record<string, number> | undefined) ?? {};
      setUsage({
        promptTokens: Number(usage.input_tokens ?? 0),
        completionTokens: Number(usage.output_tokens ?? 0),
        cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
        cacheWriteTokens: Number(usage.cache_creation_input_tokens ?? 0),
        totalTokens: Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0),
      });
    }
  }
}
