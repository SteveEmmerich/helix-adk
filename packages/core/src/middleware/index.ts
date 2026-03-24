/**
 * Built-in middleware for the Helix agent loop.
 *
 * Each middleware is a higher-order function that returns a MiddlewareFn.
 * Compose them freely via the `middleware` array in AgentConfig.
 */

import type { Result } from "@helix/ai";
import type { MiddlewareFn, TurnContext } from "./agent.js";

// ─── Logging middleware ───────────────────────────────────────────────────────

export interface LoggingOptions {
  readonly log?: (message: string, data?: unknown) => void;
  readonly includeMessages?: boolean;
}

export function withLogging(options: LoggingOptions = {}): MiddlewareFn {
  const log = options.log ?? console.log;

  return async (ctx, next) => {
    const start = Date.now();
    log(`[hlx] turn start — ${ctx.request.messages.length} messages in context`);
    if (options.includeMessages) {
      log("[hlx] messages", ctx.request.messages);
    }

    const result = await next();

    const ms = Date.now() - start;
    if (result.ok) {
      const { usage, cost } = result.value;
      log(
        `[hlx] turn complete in ${ms}ms — ` +
          `${usage.totalTokens} tokens, $${cost.totalCostUsd.toFixed(6)}`
      );
    } else {
      log(`[hlx] turn error in ${ms}ms`, result.error);
    }

    return result;
  };
}

// ─── Budget guard middleware ──────────────────────────────────────────────────

export interface BudgetOptions {
  readonly maxCostUsd: number;
  onExceeded?: (totalCostUsd: number) => void;
}

export function withBudget(options: BudgetOptions): MiddlewareFn {
  let totalCostUsd = 0;

  return async (_ctx, next) => {
    if (totalCostUsd >= options.maxCostUsd) {
      options.onExceeded?.(totalCostUsd);
      return {
        ok: false,
        error: new Error(`Budget exceeded: $${totalCostUsd.toFixed(4)} >= $${options.maxCostUsd}`),
      } satisfies Result<never>;
    }

    const result = await next();
    if (result.ok) {
      totalCostUsd += result.value.cost.totalCostUsd;
    }
    return result;
  };
}

// ─── Context injection middleware ─────────────────────────────────────────────

/**
 * Injects dynamic context into the system prompt or as a user message
 * before each turn. Useful for: time, user info, tool results from memory, etc.
 */
export function withContextInjection(
  inject: (ctx: TurnContext) => Promise<string> | string
): MiddlewareFn {
  return async (ctx, next) => {
    const injection = await inject(ctx);
    if (!injection) return next();

    // Append injection to the last user message if possible
    const messages = [...ctx.request.messages];
    const lastIdx = messages.length - 1;
    const last = messages[lastIdx];

    if (last?.role === "user" && typeof last.content === "string") {
      messages[lastIdx] = { ...last, content: `${last.content}\n\n${injection}` };
      ctx.request = { ...ctx.request, messages };
    }

    return next();
  };
}

// ─── Retry middleware ─────────────────────────────────────────────────────────

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly shouldRetry?: (error: Error) => boolean;
}

export function withRetry(options: RetryOptions = {}): MiddlewareFn {
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? 1000;
  const shouldRetry = options.shouldRetry ?? (() => true);

  return async (_ctx, next) => {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await next();
      if (result.ok) return result;

      lastError = result.error;
      if (!shouldRetry(lastError) || attempt === maxAttempts) break;

      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }

    return { ok: false, error: lastError ?? new Error("Unknown error") };
  };
}

// ─── Timeout middleware ───────────────────────────────────────────────────────

export function withTimeout(timeoutMs: number): MiddlewareFn {
  return async (ctx, next) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Merge with existing signal if any
    const original = ctx.request.signal;
    if (original) {
      original.addEventListener("abort", () => controller.abort());
    }

    ctx.request = { ...ctx.request, signal: controller.signal };

    try {
      return await next();
    } finally {
      clearTimeout(timer);
    }
  };
}

// ─── Metadata middleware ──────────────────────────────────────────────────────

/** Attach arbitrary metadata to each turn for downstream middleware */
export function withMeta(data: Record<string, unknown>): MiddlewareFn {
  return async (ctx, next) => {
    Object.assign(ctx.meta, data);
    return next();
  };
}
