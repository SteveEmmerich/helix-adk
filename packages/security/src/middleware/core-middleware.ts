import type { CompletionResponse, Result } from "@helix/ai";
import type { SecurityConfig } from "../types.js";

export type SecurityMiddleware = (
  ctx: { readonly messages: unknown; request: unknown; meta: Record<string, unknown> },
  next: () => Promise<Result<CompletionResponse>>
) => Promise<Result<CompletionResponse>>;

export function createSecurityMiddleware(
  _security: SecurityConfig | undefined
): SecurityMiddleware {
  return async (_ctx, next) => next();
}
