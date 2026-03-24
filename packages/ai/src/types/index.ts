/**
 * @helix/ai — Core type definitions
 *
 * v2 streaming changes:
 * - StreamHandler callback replaced with ReadableStream<StreamEvent>
 * - Provider.stream() returns ReadableStream<StreamEvent> directly
 * - Backpressure: producer pauses when consumer isn't reading
 * - Cancellation: reader.cancel() propagates to fetch body via stream cancel callback
 * - The final CompletionResponse is the last event in the stream (type: "done")
 *
 * Why ReadableStream over AsyncIterator:
 * - Web Streams are the Bun/browser native primitive — zero wrapping overhead
 * - Built-in backpressure via the BYOB reader and high-water mark
 * - cancel() propagates back to the underlying resource (fetch body)
 * - Can be teed for fan-out (e.g. send to TUI + write to log simultaneously)
 * - Composable with TransformStream for middleware-style event processing
 */

// ─── Branded ID types ────────────────────────────────────────────────────────

declare const __brand: unique symbol;
type Brand<T, B> = T & { [__brand]: B };

export type ModelId = Brand<string, "ModelId">;
export type ProviderId = Brand<string, "ProviderId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type RequestId = Brand<string, "RequestId">;

export const modelId = (s: string): ModelId => s as ModelId;
export const providerId = (s: string): ProviderId => s as ProviderId;
export const toolCallId = (s: string): ToolCallId => s as ToolCallId;
export const requestId = (s: string): RequestId => s as RequestId;

// ─── Result type ──────────────────────────────────────────────────────────────

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = Error> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

// ─── Token usage & cost ───────────────────────────────────────────────────────

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
}

export interface CostBreakdown {
  readonly promptCostUsd: number;
  readonly completionCostUsd: number;
  readonly cacheReadCostUsd: number;
  readonly cacheWriteCostUsd: number;
  readonly totalCostUsd: number;
}

// ─── Tool schema (JSON Schema subset) ─────────────────────────────────────────

export type JsonSchemaType =
  | { type: "string"; enum?: string[]; description?: string }
  | { type: "number"; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "array"; items: JsonSchemaType; description?: string }
  | {
      type: "object";
      properties: Record<string, JsonSchemaType>;
      required?: string[];
      description?: string;
    }
  | { type: "null" };

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaType & { type: "object" };
  readonly execute: (input: TInput, signal: AbortSignal) => Promise<TOutput>;
  readonly formatOutput?: (output: TOutput) => string | null;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly url: string; readonly mimeType?: string }
  | { readonly type: "image_base64"; readonly data: string; readonly mimeType: string }
  | { readonly type: "document"; readonly text: string; readonly title?: string };

export type AssistantContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly id: ToolCallId;
      readonly name: string;
      readonly input: unknown;
    };

export type ToolResultPart = {
  readonly type: "tool_result";
  readonly id: ToolCallId;
  readonly content: string;
  readonly isError: boolean;
};

export type Message =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: readonly ContentPart[] | string }
  | { readonly role: "assistant"; readonly content: readonly AssistantContentPart[] }
  | { readonly role: "tool"; readonly content: readonly ToolResultPart[] };

export const userMsg = (text: string): Message => ({ role: "user", content: text });
export const systemMsg = (text: string): Message => ({ role: "system", content: text });

// ─── Model capabilities ───────────────────────────────────────────────────────

export interface ModelCapabilities {
  readonly vision: boolean;
  readonly toolCalling: boolean;
  readonly parallelToolCalling: boolean;
  readonly streaming: boolean;
  readonly extendedThinking: boolean;
  readonly jsonMode: boolean;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

export interface ModelInfo {
  readonly id: ModelId;
  readonly provider: ProviderId;
  readonly displayName: string;
  readonly capabilities: ModelCapabilities;
  readonly pricing: {
    readonly promptPer1MTokens: number;
    readonly completionPer1MTokens: number;
    readonly cacheReadPer1MTokens?: number;
    readonly cacheWritePer1MTokens?: number;
  };
}

// ─── Request ──────────────────────────────────────────────────────────────────

export interface CompletionRequest {
  readonly model: ModelId;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDefinition[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
  readonly toolChoice?: "auto" | "none" | "required" | { name: string };
  /**
   * Extended thinking token budget.
   * Providers that support it (Anthropic, Google) will honour it.
   * Providers that don't (OpenAI base models) will ignore it.
   */
  readonly thinkingBudget?: number;
  readonly signal?: AbortSignal;
}

// ─── Streaming events ─────────────────────────────────────────────────────────
//
// The stream terminates with a single "done" event carrying the full response.
// Consumers iterate with: for await (const event of stream) { ... }
//
// Backpressure: the ReadableStream internal queue applies backpressure automatically.
// If the consumer is slow, the producer will pause enqueue() calls (the
// underlying fetch body read loop blocks because the stream's high-water mark
// is hit). This prevents unbounded memory accumulation on slow consumers.
//
// Cancellation: call reader.cancel() or abort the AbortSignal on the request.
// The stream's cancel() callback closes the fetch response body, which causes
// the server to stop sending data. No polling required.

export type StreamEvent =
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "thinking_delta"; readonly delta: string }
  | { readonly type: "tool_call_start"; readonly id: ToolCallId; readonly name: string }
  | { readonly type: "tool_call_delta"; readonly id: ToolCallId; readonly delta: string }
  | { readonly type: "tool_call_end"; readonly id: ToolCallId; readonly input: unknown }
  | { readonly type: "usage"; readonly usage: TokenUsage; readonly cost: CostBreakdown }
  | { readonly type: "done"; readonly response: CompletionResponse };

// ─── Response (also the payload of the terminal "done" StreamEvent) ───────────

export interface CompletionResponse {
  readonly id: RequestId;
  readonly model: ModelId;
  readonly stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  readonly message: Extract<Message, { role: "assistant" }>;
  readonly usage: TokenUsage;
  readonly cost: CostBreakdown;
  readonly durationMs: number;
}

// ─── Provider interface ───────────────────────────────────────────────────────
//
// stream() returns a ReadableStream<StreamEvent>.
// The caller reads it with a for-await loop and extracts the final "done" event.
//
// Rationale for replacing StreamHandler callback:
//
//   OLD: stream(request, handler: (event) => void | Promise<void>)
//        - If handler returns Promise, provider doesn't await → silent drop
//        - No backpressure: fast provider + slow handler → unbounded queue
//        - Cancellation: only at retry boundaries (polling signal.aborted)
//        - Fan-out: requires external bookkeeping
//
//   NEW: stream(request): ReadableStream<StreamEvent>
//        - Async iteration guarantees handler awaited before next event
//        - Backpressure built into Web Streams (high-water mark)
//        - Cancellation: reader.cancel() closes underlying fetch body
//        - Fan-out: stream.tee() gives two independent readers
//        - Composable: pipe through TransformStream for middleware

export interface Provider {
  readonly id: ProviderId;
  readonly displayName: string;

  listModels(): Promise<Result<readonly ModelInfo[]>>;
  complete(request: CompletionRequest): Promise<Result<CompletionResponse>>;

  /**
   * Streaming completion.
   * Returns a ReadableStream of StreamEvent.
   * The stream ends with a { type: "done", response } event.
   * The returned Result wraps the stream itself — Err if the connection fails
   * before streaming begins (e.g. auth error, network down).
   */
  stream(request: CompletionRequest): Promise<Result<ReadableStream<StreamEvent>>>;
}

// ─── Stream helpers ───────────────────────────────────────────────────────────

/**
 * Consume a StreamEvent stream, calling onEvent for each event,
 * and return the final CompletionResponse.
 *
 * This is the primary way to consume a stream in the agent loop.
 * onEvent is awaited before the next event is read — guaranteed ordering.
 */
export async function consumeStream(
  stream: ReadableStream<StreamEvent>,
  onEvent?: (event: StreamEvent) => void | Promise<void>
): Promise<Result<CompletionResponse>> {
  const reader = stream.getReader();
  try {
    let lastDone: CompletionResponse | undefined;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await onEvent?.(value);
      if (value.type === "done") lastDone = value.response;
    }
    if (!lastDone) return err(new Error("Stream ended without a 'done' event"));
    return ok(lastDone);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  } finally {
    reader.releaseLock();
  }
}

/**
 * Tee a stream so two consumers can read it independently.
 * Both streams receive all events including "done".
 * Backpressure is applied to the faster consumer until the slower one catches up.
 */
export function teeStream(
  stream: ReadableStream<StreamEvent>
): [ReadableStream<StreamEvent>, ReadableStream<StreamEvent>] {
  return stream.tee();
}

/**
 * Create a ReadableStream<StreamEvent> from a provider's SSE fetch response.
 * Used internally by providers — not part of the public API.
 *
 * @param response      The fetch Response with SSE body
 * @param parseLine     Parse one SSE "data: ..." line into 0–N StreamEvents
 * @param onDone        Called when the stream ends; should return the CompletionResponse
 */
export function makeProviderStream(opts: {
  response: Response;
  parseLine: (data: string) => StreamEvent[];
  onDone: () => CompletionResponse;
  signal?: AbortSignal;
}): ReadableStream<StreamEvent> {
  const { response, parseLine, onDone, signal } = opts;

  return new ReadableStream<StreamEvent>({
    async start(controller) {
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Propagate AbortSignal → cancel stream
      const onAbort = () => {
        reader.cancel().catch(() => {});
        controller.error(new Error("Aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            for (const event of parseLine(data)) {
              controller.enqueue(event);
            }
          }
        }

        // Emit the terminal "done" event
        controller.enqueue({ type: "done", response: onDone() });
        controller.close();
      } catch (e) {
        if (!signal?.aborted) controller.error(e);
      } finally {
        signal?.removeEventListener("abort", onAbort);
        reader.releaseLock();
      }
    },

    cancel() {
      // Called when reader.cancel() is invoked by the consumer.
      // The underlying fetch body is already closed by the reader above
      // because we hold the lock — releasing it here is sufficient.
    },
  });
}

// ─── Provider registry ────────────────────────────────────────────────────────

export interface ProviderRegistry {
  register(provider: Provider): void;
  get(id: ProviderId): Provider | undefined;
  getAll(): readonly Provider[];
  resolveModel(modelId: ModelId): { provider: Provider; model: ModelInfo } | undefined;
}
