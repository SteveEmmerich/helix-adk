/**
 * OpenAI provider for @helix/ai
 *
 * Covers: GPT-4o, o3, o4-mini, and any OpenAI-compatible endpoint
 * (LM Studio, Ollama, Together, Groq, Azure OpenAI).
 *
 * Key differences from Anthropic:
 * - Tool results go in the same `messages` array (not a separate role)
 * - Streaming uses `[DONE]` sentinel
 * - Reasoning models (o3, o4-mini) use `reasoning_effort` not `thinking`
 * - JSON mode via `response_format: { type: "json_object" }`
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
} from "../types/index.js";
import { err, modelId, ok, providerId, requestId, toolCallId } from "../types/index.js";

const PROVIDER_ID: ProviderId = providerId("openai");

const MODELS: ModelInfo[] = [
  {
    id: modelId("gpt-4o"),
    provider: PROVIDER_ID,
    displayName: "GPT-4o",
    capabilities: {
      vision: true,
      toolCalling: true,
      parallelToolCalling: true,
      streaming: true,
      extendedThinking: false,
      jsonMode: true,
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
    },
    pricing: {
      promptPer1MTokens: 2.5,
      completionPer1MTokens: 10,
      cacheReadPer1MTokens: 1.25,
    },
  },
  {
    id: modelId("gpt-4o-mini"),
    provider: PROVIDER_ID,
    displayName: "GPT-4o Mini",
    capabilities: {
      vision: true,
      toolCalling: true,
      parallelToolCalling: true,
      streaming: true,
      extendedThinking: false,
      jsonMode: true,
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
    },
    pricing: {
      promptPer1MTokens: 0.15,
      completionPer1MTokens: 0.6,
      cacheReadPer1MTokens: 0.075,
    },
  },
  {
    id: modelId("o3"),
    provider: PROVIDER_ID,
    displayName: "o3",
    capabilities: {
      vision: true,
      toolCalling: true,
      parallelToolCalling: true,
      streaming: true,
      extendedThinking: true,
      jsonMode: true,
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
    },
    pricing: {
      promptPer1MTokens: 10,
      completionPer1MTokens: 40,
    },
  },
  {
    id: modelId("o4-mini"),
    provider: PROVIDER_ID,
    displayName: "o4-mini",
    capabilities: {
      vision: true,
      toolCalling: true,
      parallelToolCalling: true,
      streaming: true,
      extendedThinking: true,
      jsonMode: true,
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
    },
    pricing: {
      promptPer1MTokens: 1.1,
      completionPer1MTokens: 4.4,
    },
  },
];

export interface OpenAIConfig {
  readonly apiKey: string;
  /** Override for LM Studio, Ollama, Azure, Together, Groq, etc. */
  readonly baseUrl?: string;
  readonly organization?: string;
  readonly maxRetries?: number;
  readonly defaultHeaders?: Record<string, string>;
  /** Extra models not in the built-in list (for custom/fine-tuned models) */
  readonly extraModels?: readonly ModelInfo[];
}

function computeCost(model: ModelInfo, usage: TokenUsage): CostBreakdown {
  const p = model.pricing;
  const promptCostUsd = (usage.promptTokens / 1_000_000) * p.promptPer1MTokens;
  const completionCostUsd = (usage.completionTokens / 1_000_000) * p.completionPer1MTokens;
  const cacheReadCostUsd =
    usage.cacheReadTokens > 0 && p.cacheReadPer1MTokens
      ? (usage.cacheReadTokens / 1_000_000) * p.cacheReadPer1MTokens
      : 0;
  return {
    promptCostUsd,
    completionCostUsd,
    cacheReadCostUsd,
    cacheWriteCostUsd: 0,
    totalCostUsd: promptCostUsd + completionCostUsd + cacheReadCostUsd,
  };
}

function zeroCost(): CostBreakdown {
  return {
    promptCostUsd: 0,
    completionCostUsd: 0,
    cacheReadCostUsd: 0,
    cacheWriteCostUsd: 0,
    totalCostUsd: 0,
  };
}

/** Transform Helix Message[] → OpenAI message format */
function transformMessages(messages: readonly Message[]): unknown[] {
  const out: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      out.push({ role: "system", content: msg.content });
      continue;
    }

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
      } else {
        const content = msg.content.map((p) => {
          if (p.type === "text") return { type: "text", text: p.text };
          if (p.type === "image") return { type: "image_url", image_url: { url: p.url } };
          if (p.type === "image_base64") {
            return { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } };
          }
          if (p.type === "document") return { type: "text", text: p.text };
          return p;
        });
        out.push({ role: "user", content });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const textParts = msg.content.filter(
        (c): c is Extract<AssistantContentPart, { type: "text" }> => c.type === "text"
      );
      const toolCalls = msg.content.filter(
        (c): c is Extract<AssistantContentPart, { type: "tool_call" }> => c.type === "tool_call"
      );

      const assistantMsg: Record<string, unknown> = {
        role: "assistant",
        content: textParts.map((p) => p.text).join("") || null,
      };

      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }));
      }

      out.push(assistantMsg);
      continue;
    }

    if (msg.role === "tool") {
      // OpenAI: one message per tool result (unlike Anthropic's batched approach)
      for (const part of msg.content) {
        out.push({
          role: "tool",
          tool_call_id: part.id,
          content: part.content,
        });
      }
    }
  }

  return out;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class OpenAIProvider implements Provider {
  readonly id = PROVIDER_ID;
  readonly displayName = "OpenAI";

  readonly #config: OpenAIConfig;
  readonly #baseUrl: string;
  readonly #allModels: ModelInfo[];

  constructor(config: OpenAIConfig) {
    this.#config = config;
    this.#baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.#allModels = [...MODELS, ...(config.extraModels ?? [])];
  }

  async listModels(): Promise<Result<readonly ModelInfo[]>> {
    return ok(this.#allModels);
  }

  async complete(request: CompletionRequest): Promise<Result<CompletionResponse>> {
    const startMs = Date.now();
    const result = await this.#fetchWithRetry(request, false);
    if (!result.ok) return result;
    return ok(
      this.#parseResponse(
        request.model,
        result.value as Record<string, unknown>,
        Date.now() - startMs
      )
    );
  }

  async stream(request: CompletionRequest): Promise<Result<ReadableStream<StreamEvent>>> {
    const startMs = Date.now();
    const result = await this.#fetchWithRetry(request, true);
    if (!result.ok) return result;
    return ok(this.#buildStream(request.model, result.value as Response, startMs, request.signal));
  }

  #buildBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const messages = transformMessages(request.messages);
    const isReasoningModel = request.model.startsWith("o3") || request.model.startsWith("o4");

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream,
      stream_options: stream ? { include_usage: true } : undefined,
    };

    // Reasoning models use max_completion_tokens, not max_tokens
    if (isReasoningModel) {
      body.max_completion_tokens = request.maxTokens ?? 16_384;
      if (request.thinkingBudget !== undefined) {
        body.reasoning_effort =
          request.thinkingBudget > 5000 ? "high" : request.thinkingBudget > 1000 ? "medium" : "low";
      }
    } else {
      body.max_tokens = request.maxTokens ?? 4096;
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.topP !== undefined) body.top_p = request.topP;
    }

    if (request.stopSequences?.length) body.stop = request.stopSequences;

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    if (request.toolChoice) {
      if (typeof request.toolChoice === "string") {
        body.tool_choice = request.toolChoice;
      } else {
        body.tool_choice = { type: "function", function: { name: request.toolChoice.name } };
      }
    }

    return body;
  }

  async #fetchWithRetry(request: CompletionRequest, stream: boolean): Promise<Result<unknown>> {
    const maxRetries = this.#config.maxRetries ?? 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 30_000));
      if (request.signal?.aborted) return err(new Error("Aborted"));

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#config.apiKey}`,
          ...this.#config.defaultHeaders,
        };
        if (this.#config.organization) {
          headers["OpenAI-Organization"] = this.#config.organization;
        }

        const res = await fetch(`${this.#baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(this.#buildBody(request, stream)),
          signal: request.signal,
        });

        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) return err(new Error(`HTTP ${res.status}: ${await res.text()}`));
        if (stream) return ok(res);
        return ok(await res.json());
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return err(new Error("Aborted"));
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    return err(lastError ?? new Error("Unknown error"));
  }

  #parseUsage(raw: Record<string, unknown>): TokenUsage {
    const prompt = Number(raw.prompt_tokens ?? 0);
    const completion = Number(raw.completion_tokens ?? 0);
    const details = raw.prompt_tokens_details as Record<string, number> | undefined;
    return {
      promptTokens: prompt,
      completionTokens: completion,
      cacheReadTokens: details?.cached_tokens ?? 0,
      cacheWriteTokens: 0,
      totalTokens: prompt + completion,
    };
  }

  #parseResponse(
    model: ModelId,
    data: Record<string, unknown>,
    durationMs: number
  ): CompletionResponse {
    const modelInfo = this.#allModels.find((m) => m.id === model);
    const usage = this.#parseUsage((data.usage as Record<string, unknown> | undefined) ?? {});
    const cost = modelInfo ? computeCost(modelInfo, usage) : zeroCost();

    const choice = (data.choices as unknown[])?.[0] as Record<string, unknown> | undefined;
    const msg = choice?.message as Record<string, unknown> | undefined;
    const content: AssistantContentPart[] = [];

    const text = msg?.content;
    if (text && typeof text === "string") content.push({ type: "text", text });

    const toolCalls = msg?.tool_calls as unknown[] | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const t = tc as Record<string, unknown>;
        const fn = t.function as Record<string, string>;
        let input: unknown = {};
        try {
          input = JSON.parse(fn.arguments ?? "{}");
        } catch {
          /* empty */
        }
        content.push({
          type: "tool_call",
          id: toolCallId(String(t.id)),
          name: fn.name ?? "",
          input,
        });
      }
    }

    const finishReason = String(choice?.finish_reason ?? "stop");
    const stopReason: CompletionResponse["stopReason"] =
      finishReason === "tool_calls"
        ? "tool_use"
        : finishReason === "length"
          ? "max_tokens"
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

  #buildStream(
    model: ModelId,
    response: Response,
    startMs: number,
    signal?: AbortSignal
  ): ReadableStream<StreamEvent> {
    const allModels = this.#allModels;
    let fullText = "";
    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
    let usage: TokenUsage | undefined;
    let stopReason: CompletionResponse["stopReason"] = "end_turn";
    let responseId = crypto.randomUUID();

    return new ReadableStream<StreamEvent>({
      async start(controller) {
        const bodyReader = response.body?.getReader();
        const decoder = new TextDecoder();

        const onAbort = () => {
          bodyReader.cancel().catch(() => {});
          controller.error(new Error("Aborted"));
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

              let chunk: Record<string, unknown>;
              try {
                chunk = JSON.parse(data) as Record<string, unknown>;
              } catch {
                continue;
              }

              responseId = String(chunk.id ?? responseId);
              if (chunk.usage) {
                // Import helper inline to avoid closure over `this`
                const u = chunk.usage as Record<string, unknown>;
                const prompt = Number(u.prompt_tokens ?? 0);
                const completion = Number(u.completion_tokens ?? 0);
                const details = u.prompt_tokens_details as Record<string, number> | undefined;
                usage = {
                  promptTokens: prompt,
                  completionTokens: completion,
                  cacheReadTokens: details?.cached_tokens ?? 0,
                  cacheWriteTokens: 0,
                  totalTokens: prompt + completion,
                };
              }

              const choices = chunk.choices as unknown[] | undefined;
              if (!choices?.length) continue;

              const choice = choices[0] as Record<string, unknown>;
              const delta = choice.delta as Record<string, unknown> | undefined;
              const finishReason = choice.finish_reason;
              if (finishReason) {
                stopReason =
                  finishReason === "tool_calls"
                    ? "tool_use"
                    : finishReason === "length"
                      ? "max_tokens"
                      : "end_turn";
              }
              if (!delta) continue;

              const textDelta = delta.content;
              if (textDelta && typeof textDelta === "string") {
                fullText += textDelta;
                controller.enqueue({ type: "text_delta", delta: textDelta });
              }

              const tcDeltas = delta.tool_calls as unknown[] | undefined;
              if (tcDeltas) {
                for (const tcDelta of tcDeltas) {
                  const tc = tcDelta as Record<string, unknown>;
                  const idx = Number(tc.index ?? 0);
                  const fn = tc.function as Record<string, string> | undefined;
                  if (!toolCallBuffers.has(idx)) {
                    const id = String(tc.id ?? "");
                    const name = fn?.name ?? "";
                    toolCallBuffers.set(idx, { id, name, args: "" });
                    controller.enqueue({ type: "tool_call_start", id: toolCallId(id), name });
                  }
                  const buf = toolCallBuffers.get(idx);
                  if (!buf) continue;
                  if (fn?.arguments) {
                    buf.args += fn.arguments;
                    controller.enqueue({
                      type: "tool_call_delta",
                      id: toolCallId(buf.id),
                      delta: fn.arguments,
                    });
                  }
                }
              }
            }
          }

          // Finalize
          const content: AssistantContentPart[] = [];
          if (fullText) content.push({ type: "text", text: fullText });
          for (const [, buf] of Array.from(toolCallBuffers.entries()).sort(([a], [b]) => a - b)) {
            let input: unknown = {};
            try {
              input = JSON.parse(buf.args || "{}");
            } catch {
              /* empty */
            }
            content.push({ type: "tool_call", id: toolCallId(buf.id), name: buf.name, input });
            controller.enqueue({ type: "tool_call_end", id: toolCallId(buf.id), input });
          }

          const finalUsage: TokenUsage = usage ?? {
            promptTokens: 0,
            completionTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
          };
          const modelInfo = allModels.find((m) => m.id === model);
          const cost = modelInfo ? computeCost(modelInfo, finalUsage) : zeroCost();
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
      cancel() {},
    });
  }
}

/**
 * Convenience: create an OpenAI-compatible provider pointing at a local server.
 * Works with LM Studio, Ollama (via OpenAI compat layer), Llamafile, etc.
 */
export function localOpenAIProvider(opts: {
  baseUrl?: string;
  modelId?: string;
  displayName?: string;
}): OpenAIProvider {
  const mid = modelId(opts.modelId ?? "local-model");
  return new OpenAIProvider({
    apiKey: "local", // most local servers ignore the key
    baseUrl: opts.baseUrl ?? "http://localhost:1234/v1",
    extraModels: [
      {
        id: mid,
        provider: PROVIDER_ID,
        displayName: opts.displayName ?? "Local Model",
        capabilities: {
          vision: false,
          toolCalling: true,
          parallelToolCalling: false,
          streaming: true,
          extendedThinking: false,
          jsonMode: true,
          contextWindow: 32_768,
          maxOutputTokens: 8_192,
        },
        pricing: { promptPer1MTokens: 0, completionPer1MTokens: 0 },
      },
    ],
  });
}
