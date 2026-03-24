import type { ToolDefinition } from "@helix/ai";
import type { SecurityConfig } from "../types.js";

export function wrapToolWithSecurity<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
  security: SecurityConfig | undefined,
  sessionId: string
): ToolDefinition<TInput, TOutput> {
  if (!security?.vault && !security?.dlp) return tool;

  return {
    ...tool,
    execute: async (input, signal) => {
      let toolInput: unknown = input;
      if (security.vault) {
        toolInput = await security.vault.inject(toolInput, tool.name);
      }
      if (security.dlp && security.scanToolInputs !== false) {
        const inputResult = await security.dlp.scanInput(tool.name, toolInput, sessionId);
        if (!inputResult.clean && inputResult.requiresApproval && inputResult.approvalRequest) {
          const decision = await security.dlp.waitForApproval(
            inputResult.approvalRequest,
            inputResult.redactedValue
          );
          if (decision.useRedacted && inputResult.redactedValue !== undefined) {
            toolInput = inputResult.redactedValue;
          }
        }
      }

      const output = await tool.execute(toolInput as TInput, signal);

      if (security.dlp && security.scanToolOutputs !== false) {
        const outputResult = await security.dlp.scanOutput(tool.name, output, sessionId);
        if (!outputResult.clean && outputResult.requiresApproval && outputResult.approvalRequest) {
          const decision = await security.dlp.waitForApproval(
            outputResult.approvalRequest,
            outputResult.redactedValue
          );
          if (decision.useRedacted && outputResult.redactedValue !== undefined) {
            return outputResult.redactedValue as TOutput;
          }
          if (decision.status === "denied") {
            throw new Error("Output blocked by DLP");
          }
        }
      }

      return output;
    },
  };
}
