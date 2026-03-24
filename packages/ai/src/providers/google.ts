/**
 * Google Gemini provider for @helix/ai
 *
 * Covers: Gemini 2.5 Pro, 2.5 Flash, 2.0 Flash
 *
 * Key differences from Anthropic/OpenAI:
 * - Uses `generateContent` not `messages` endpoint
 * - Parts-based content model (inline_data for images)
 * - Tool calling uses `functionDeclarations` in `tools`
 * - Separate `systemInstruction` field
 * - SSE streaming with `candidates[].content.parts`
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
  ToolCallId,
} from "../types/index.js";
import { err, modelId, ok, providerId, requestId, toolCallId } from "../types/index.js";

const PROVIDER_ID: ProviderId = providerId("google");

const MODELS: ModelInfo[] = [
  {
    id: modelId("gemini-2.5-pro"),
    provider: PROVIDER_ID,
    displayName: "Gemini 2.5 Pro",
    capabilities: {
      vision: true,
      toolCalling: true,
      parallelToolCalling: true,
      streaming: true,
      extendedThinking: true,
      jsonMode: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
    },
    pricing: {
      promptPer1MTokens: 1.25, // ≤200k ctx
      completionPer1MTokens: 10,
      cacheReadPer1MTokens: 0.31,
    },
  },
  {
    id: modelId("gemini-2.5-flash"),
    provider: PROVIDER_ID,
    displayName: "Gemini 2.5 Flash",
    capabilities: {
      vision: true,
      toolCalling: true,
      parallelToolCalling: true,
      streaming: true,
      extendedThinking: true,
      jsonMode: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
    },
    pricing: {
      promptPer1MTokens: 0.15,
      completionPer1MTokens: 0.6,
      cacheReadPer1MTokens: 0.037,
    },
  },
  {
    id: modelId("gemini-2.0-flash"),
    provider: PROVIDER_ID,
    displayName: "Gemini 2.0 Flash",
    capabilities: {
      vision: true,
      toolCalling: true,
      parallelToolCalling: true,
      streaming: true,
      extendedThinking: false,
      jsonMode: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 8_192,
    },
    pricing: {
      promptPer1MTokens: 0.1,
      completionPer1MTokens: 0.4,
    },
  },
];

export interface GoogleConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly maxRetries?: number;
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

/** Transform Helix messages → Gemini contents array */
function transformMessages(messages: readonly Message[]): {
  systemInstruction: string | undefined;
  contents: unknown[];
} {
  let systemInstruction: string | undefined;
  const contents: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = msg.content;
      continue;
    }

    if (msg.role === "user") {
      const parts =
        typeof msg.content === "string"
          ? [{ text: msg.content }]
          : msg.content.map((p) => {
              if (p.type === "text") return { text: p.text };
              if (p.type === "image")
                return { fileData: { fileUri: p.url, mimeType: p.mimeType ?? "image/jpeg" } };
              if (p.type === "image_base64")
                return { inlineData: { mimeType: p.mimeType, data: p.data } };
              if (p.type === "document") return { text: p.text };
              return { text: JSON.stringify(p) };
            });
      contents.push({ role: "user", parts });
      continue;
    }

    if (msg.role === "assistant") {
      const parts: unknown[] = [];
      for (const part of msg.content) {
        if (part.type === "text") parts.push({ text: part.text });
        if (part.type === "tool_call") {
          parts.push({ functionCall: { name: part.name, args: part.input } });
        }
      }
      contents.push({ role: "model", parts });
      continue;
    }

    if (msg.role === "tool") {
      const parts = msg.content.map((p) => ({
        functionResponse: {
          name: p.id, // Gemini uses name, we use the tool_call_id as proxy
          response: { content: p.content },
        },
      }));
      contents.push({ role: "user", parts });
    }
  }

  return { systemInstruction, contents };
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export class GoogleProvider implements Provider {
  readonly id = PROVIDER_ID;
  readonly displayName = "Google";

  readonly #config: GoogleConfig;
  readonly #baseUrl: string;

  constructor(config: GoogleConfig) {
    this.#config = config;
    this.#baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  async listModels(): Promise<Result<readonly ModelInfo[]>> {
    return ok(MODELS);
  }

  async complete(request: CompletionRequest): Promise<Result<CompletionResponse>> {
    const startMs = Date.now();
    const result = await this.#fetch(request, false);
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
    const result = await this.#fetch(request, true);
    if (!result.ok) return result;
    return ok(this.#buildStream(request.model, result.value as Response, startMs, request.signal));
  }

  #buildBody(request: CompletionRequest): Record<string, unknown> {
    const { systemInstruction, contents } = transformMessages(request.messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 8192,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { topP: request.topP } : {}),
        ...(request.stopSequences?.length ? { stopSequences: request.stopSequences } : {}),
      },
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    if (request.tools?.length) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        },
      ];
    }

    if (request.thinkingBudget !== undefined) {
      (body.generationConfig as Record<string, unknown>).thinkingConfig = {
        thinkingBudget: request.thinkingBudget,
      };
    }

    return body;
  }

  async #fetch(request: CompletionRequest, stream: boolean): Promise<Result<unknown>> {
    const maxRetries = this.#config.maxRetries ?? 3;
    let lastError: Error | undefined;
    const method = stream ? "streamGenerateContent" : "generateContent";
    const modelStr = request.model.replace("models/", "");
    const url = `${this.#baseUrl}/models/${modelStr}:${method}${stream ? "?alt=sse" : ""}`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 30_000));
      if (request.signal?.aborted) return err(new Error("Aborted"));

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.#config.apiKey,
          },
          body: JSON.stringify(this.#buildBody(request)),
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
    return {
      promptTokens: Number(raw.promptTokenCount ?? 0),
      completionTokens: Number(raw.candidatesTokenCount ?? 0),
      cacheReadTokens: Number(raw.cachedContentTokenCount ?? 0),
      cacheWriteTokens: 0,
      totalTokens: Number(raw.totalTokenCount ?? 0),
    };
  }

  #parseResponse(
    model: ModelId,
    data: Record<string, unknown>,
    durationMs: number
  ): CompletionResponse {
    const modelInfo = MODELS.find((m) => m.id === model);
    const usage = this.#parseUsage(
      (data.usageMetadata as Record<string, unknown> | undefined) ?? {}
    );
    const cost = modelInfo ? computeCost(modelInfo, usage) : zeroCost();

    const candidate = (data.candidates as unknown[])?.[0] as Record<string, unknown> | undefined;
    const parts =
      ((candidate?.content as Record<string, unknown> | undefined)?.parts as
        | unknown[]
        | undefined) ?? [];
    const content: AssistantContentPart[] = [];
    // Per-response counter prevents ID collisions when the same tool is called
    // multiple times in one turn. Gemini doesn't return stable IDs like OpenAI/Anthropic.
    let tcIdx = 0;

    for (const part of parts) {
      const p = part as Record<string, unknown>;
      if (p.text) content.push({ type: "text", text: String(p.text) });
      if (p.functionCall) {
        const fc = p.functionCall as Record<string, unknown>;
        const name = String(fc.name);
        content.push({
          type: "tool_call",
          id: toolCallId(`gemini_${name}_${tcIdx++}`),
          name,
          input: fc.args,
        });
      }
    }

    const finishReason = String(candidate?.finishReason ?? "STOP");
    const stopReason: CompletionResponse["stopReason"] =
      finishReason === "MAX_TOKENS"
        ? "max_tokens"
        : finishReason === "STOP" && content.some((c) => c.type === "tool_call")
          ? "tool_use"
          : "end_turn";

    return {
      id: requestId(crypto.randomUUID()),
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
    const models = MODELS;
    let fullText = "";
    const toolCalls: Array<{ id: ToolCallId; name: string; input: unknown }> = [];
    let usage: TokenUsage | undefined;

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
              let chunk: Record<string, unknown>;
              try {
                chunk = JSON.parse(data) as Record<string, unknown>;
              } catch {
                continue;
              }

              if (chunk.usageMetadata) {
                const u = chunk.usageMetadata as Record<string, unknown>;
                usage = {
                  promptTokens: Number(u.promptTokenCount ?? 0),
                  completionTokens: Number(u.candidatesTokenCount ?? 0),
                  cacheReadTokens: Number(u.cachedContentTokenCount ?? 0),
                  cacheWriteTokens: 0,
                  totalTokens: Number(u.totalTokenCount ?? 0),
                };
              }

              const candidate = (chunk.candidates as unknown[])?.[0] as
                | Record<string, unknown>
                | undefined;
              const parts =
                ((candidate?.content as Record<string, unknown> | undefined)?.parts as unknown[]) ??
                [];

              for (const part of parts) {
                const p = part as Record<string, unknown>;
                if (p.text) {
                  const delta = String(p.text);
                  fullText += delta;
                  controller.enqueue({ type: "text_delta", delta });
                }
                if (p.functionCall) {
                  const fc = p.functionCall as Record<string, unknown>;
                  const name = String(fc.name);
                  const id = toolCallId(`gemini_${name}_${toolCalls.length}`);
                  controller.enqueue({ type: "tool_call_start", id, name });
                  controller.enqueue({ type: "tool_call_end", id, input: fc.args });
                  toolCalls.push({ id, name, input: fc.args });
                }
              }
            }
          }

          const content: AssistantContentPart[] = [];
          if (fullText) content.push({ type: "text", text: fullText });
          for (const tc of toolCalls) content.push({ type: "tool_call", ...tc });

          const finalUsage: TokenUsage = usage ?? {
            promptTokens: 0,
            completionTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
          };
          const modelInfo = models.find((m) => m.id === model);
          const cost = modelInfo ? computeCost(modelInfo, finalUsage) : zeroCost();
          const stopReason: CompletionResponse["stopReason"] =
            toolCalls.length > 0 ? "tool_use" : "end_turn";
          const completionResponse: CompletionResponse = {
            id: requestId(crypto.randomUUID()),
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
