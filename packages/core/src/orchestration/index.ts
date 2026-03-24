/**
 * @helix/core — Multi-agent orchestration
 *
 * Three composable patterns:
 *
 * 1. Pipeline  — agents run in sequence, each receives the previous output
 *                Good for: review chains, multi-step transforms, critique loops
 *
 * 2. Parallel  — agents run concurrently on the same input, results are merged
 *                Good for: parallel research, multi-perspective analysis, redundancy
 *
 * 3. Swarm     — a coordinator agent routes subtasks to specialist agents via tools
 *                Good for: complex projects where different agents own different domains
 *
 * All patterns are built on the same Agent class — no special infrastructure needed.
 */

import type { Result } from "@helix/ai";
import { err, ok } from "@helix/ai";
import { Agent, type AgentConfig, type AgentEvent, type AgentRunResult } from "../loop/agent.js";
import { defineTool } from "../tools/index.js";

// ─── Shared types ─────────────────────────────────────────────────────────────

export type OrchestratorEvent =
  | { type: "agent_start"; agentId: string; input: string }
  | { type: "agent_event"; agentId: string; event: AgentEvent }
  | { type: "agent_done"; agentId: string; result: AgentRunResult }
  | { type: "agent_error"; agentId: string; error: Error };

export type OrchestratorHandler = (event: OrchestratorEvent) => void | Promise<void>;

// ─── 1. Pipeline ─────────────────────────────────────────────────────────────

export interface PipelineStep {
  readonly id: string;
  readonly config: AgentConfig;
  /**
   * Transform the previous step's output before passing it to this step.
   * Default: pass through unchanged.
   */
  readonly transform?: (input: string, stepIndex: number) => string | Promise<string>;
}

export interface PipelineResult {
  readonly steps: Array<{ id: string; input: string; output: string; costUsd: number }>;
  readonly finalOutput: string;
  readonly totalCostUsd: number;
}

/**
 * Run a pipeline of agents in sequence.
 * Each agent's final message becomes the next agent's input.
 */
export async function runPipeline(
  steps: readonly PipelineStep[],
  initialInput: string,
  onEvent?: OrchestratorHandler,
  signal?: AbortSignal
): Promise<Result<PipelineResult>> {
  if (steps.length === 0) return err(new Error("Pipeline must have at least one step"));

  const results: PipelineResult["steps"] = [];
  let currentInput = initialInput;
  let totalCostUsd = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    if (signal?.aborted) return err(new Error("Pipeline aborted"));

    // Apply optional transform
    const input = step.transform ? await step.transform(currentInput, i) : currentInput;

    await onEvent?.({ type: "agent_start", agentId: step.id, input });

    const agent = new Agent({ ...step.config, signal });
    const result = await agent.run({
      input,
      onEvent: (event) => onEvent?.({ type: "agent_event", agentId: step.id, event }),
      signal,
    });

    if (!result.ok) {
      await onEvent?.({ type: "agent_error", agentId: step.id, error: result.error });
      return err(new Error(`Pipeline step "${step.id}" failed: ${result.error.message}`));
    }

    const stepResult = result.value;
    await onEvent?.({ type: "agent_done", agentId: step.id, result: stepResult });

    results.push({
      id: step.id,
      input,
      output: stepResult.finalMessage,
      costUsd: stepResult.state.totalCostUsd,
    });

    totalCostUsd += stepResult.state.totalCostUsd;
    currentInput = stepResult.finalMessage;
  }

  return ok({
    steps: results,
    finalOutput: currentInput,
    totalCostUsd,
  });
}

// ─── 2. Parallel ─────────────────────────────────────────────────────────────

export interface ParallelAgent {
  readonly id: string;
  readonly config: AgentConfig;
  /** Optional input override — defaults to the shared input */
  readonly input?: string;
}

export interface ParallelResult {
  readonly outputs: Array<{ id: string; output: string; costUsd: number }>;
  readonly totalCostUsd: number;
}

/**
 * Run multiple agents concurrently on the same (or varied) input.
 * All agents start simultaneously and results are collected when all complete.
 */
export async function runParallel(
  agents: readonly ParallelAgent[],
  sharedInput: string,
  onEvent?: OrchestratorHandler,
  signal?: AbortSignal
): Promise<Result<ParallelResult>> {
  if (agents.length === 0) return err(new Error("Need at least one agent"));

  const tasks = agents.map(async (spec) => {
    const input = spec.input ?? sharedInput;
    await onEvent?.({ type: "agent_start", agentId: spec.id, input });

    const agent = new Agent({ ...spec.config, signal });
    const result = await agent.run({
      input,
      onEvent: (event) => onEvent?.({ type: "agent_event", agentId: spec.id, event }),
      signal,
    });

    if (!result.ok) {
      await onEvent?.({ type: "agent_error", agentId: spec.id, error: result.error });
      return { id: spec.id, output: `ERROR: ${result.error.message}`, costUsd: 0 };
    }

    await onEvent?.({ type: "agent_done", agentId: spec.id, result: result.value });
    return {
      id: spec.id,
      output: result.value.finalMessage,
      costUsd: result.value.state.totalCostUsd,
    };
  });

  const outputs = await Promise.all(tasks);
  const totalCostUsd = outputs.reduce((sum, o) => sum + o.costUsd, 0);

  return ok({ outputs, totalCostUsd });
}

// ─── 3. Swarm ─────────────────────────────────────────────────────────────────

export interface SwarmAgent {
  readonly id: string;
  readonly description: string; // What the coordinator sees about this agent's capabilities
  readonly config: AgentConfig;
}

export interface SwarmResult {
  readonly coordinatorOutput: string;
  readonly delegations: Array<{ agentId: string; input: string; output: string }>;
  readonly totalCostUsd: number;
}

/**
 * Swarm orchestration — a coordinator agent that can delegate to specialist agents.
 *
 * The coordinator is given a `delegate` tool for each registered specialist.
 * It decides which agent(s) to call and how to integrate their results.
 * Specialists run as sub-agents and return their output to the coordinator.
 *
 * This is Helix's equivalent of OpenAI Swarm / Anthropic multi-agent patterns.
 */
export async function runSwarm(
  coordinator: AgentConfig,
  specialists: readonly SwarmAgent[],
  input: string,
  onEvent?: OrchestratorHandler,
  signal?: AbortSignal
): Promise<Result<SwarmResult>> {
  const delegations: SwarmResult["delegations"] = [];
  let totalCostUsd = 0;

  // Build delegation tools — one per specialist agent
  const delegationTools = specialists.map((spec) =>
    defineTool({
      name: `delegate_to_${spec.id}`,
      description: `Delegate a subtask to the ${spec.id} specialist agent.\nCapabilities: ${spec.description}\nPass a clear, self-contained task description as the input.`,
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The task to delegate. Be specific and self-contained.",
          },
        },
        required: ["task"],
      },
      execute: async ({ task }: { task: string }, subSignal) => {
        await onEvent?.({ type: "agent_start", agentId: spec.id, input: task });

        const subAgent = new Agent({
          ...spec.config,
          signal: subSignal,
        });

        const result = await subAgent.run({
          input: task,
          onEvent: (event) => onEvent?.({ type: "agent_event", agentId: spec.id, event }),
          signal: subSignal,
        });

        if (!result.ok) {
          await onEvent?.({ type: "agent_error", agentId: spec.id, error: result.error });
          return { error: result.error.message };
        }

        await onEvent?.({ type: "agent_done", agentId: spec.id, result: result.value });

        delegations.push({ agentId: spec.id, input: task, output: result.value.finalMessage });
        totalCostUsd += result.value.state.totalCostUsd;

        return { output: result.value.finalMessage };
      },
      formatOutput: ({ output, error }: { output?: string; error?: string }) =>
        error ? `Delegation failed: ${error}` : (output ?? ""),
    })
  );

  // Build coordinator system prompt that lists available specialists
  const specialistList = specialists.map((s) => `- ${s.id}: ${s.description}`).join("\n");

  const coordinatorWithSwarm: AgentConfig = {
    ...coordinator,
    systemPrompt: `${coordinator.systemPrompt ? `${coordinator.systemPrompt}\n\n` : ""}You are coordinating a team of specialist agents. Available specialists:\n${specialistList}\n\nUse the delegate_to_* tools to assign subtasks. Synthesize their results into a final answer.`,
    tools: [...(coordinator.tools ?? []), ...delegationTools],
    signal,
  };

  await onEvent?.({ type: "agent_start", agentId: "coordinator", input });

  const coordinatorAgent = new Agent(coordinatorWithSwarm);
  const result = await coordinatorAgent.run({
    input,
    onEvent: (event) => onEvent?.({ type: "agent_event", agentId: "coordinator", event }),
    signal,
  });

  if (!result.ok) {
    await onEvent?.({ type: "agent_error", agentId: "coordinator", error: result.error });
    return err(result.error);
  }

  await onEvent?.({ type: "agent_done", agentId: "coordinator", result: result.value });
  totalCostUsd += result.value.state.totalCostUsd;

  return ok({
    coordinatorOutput: result.value.finalMessage,
    delegations,
    totalCostUsd,
  });
}

// ─── Critique loop — a common pipeline specialisation ─────────────────────────

export interface CritiqueLoopOptions {
  /** The agent that produces work */
  readonly workerConfig: AgentConfig;
  /** The agent that critiques and suggests improvements */
  readonly critiqueConfig: AgentConfig;
  /** Max rounds of critique. Default: 2 */
  readonly maxRounds?: number;
  /** Stop early if the critique agent outputs this string */
  readonly approvalSignal?: string;
  readonly onEvent?: OrchestratorHandler;
  readonly signal?: AbortSignal;
}

export interface CritiqueLoopResult {
  readonly finalOutput: string;
  readonly rounds: number;
  readonly totalCostUsd: number;
}

/**
 * Run a worker→critic loop until the critic approves or maxRounds is reached.
 * Classic "generate, critique, revise" pattern.
 */
export async function runCritiqueLoop(
  input: string,
  opts: CritiqueLoopOptions
): Promise<Result<CritiqueLoopResult>> {
  const maxRounds = opts.maxRounds ?? 2;
  const approvalSignal = opts.approvalSignal ?? "APPROVED";
  let totalCostUsd = 0;
  let currentOutput = "";

  for (let round = 1; round <= maxRounds; round++) {
    // Worker turn
    const workerInput =
      round === 1
        ? input
        : `Revise your previous output based on this feedback:\n\n${currentOutput}\n\nOriginal task: ${input}`;

    const workerResult = await runPipeline(
      [{ id: `worker-r${round}`, config: opts.workerConfig }],
      workerInput,
      opts.onEvent,
      opts.signal
    );
    if (!workerResult.ok) return err(workerResult.error);
    currentOutput = workerResult.value.finalOutput;
    totalCostUsd += workerResult.value.totalCostUsd;

    // Critique turn
    const critiqueInput = `Review this output and provide specific, actionable feedback. If it fully satisfies the requirements, output only "${approvalSignal}".\n\nOriginal task: ${input}\n\nOutput to review:\n${currentOutput}`;

    const critiqueResult = await runPipeline(
      [{ id: `critique-r${round}`, config: opts.critiqueConfig }],
      critiqueInput,
      opts.onEvent,
      opts.signal
    );
    if (!critiqueResult.ok) return err(critiqueResult.error);
    totalCostUsd += critiqueResult.value.totalCostUsd;

    const critiqueOutput = critiqueResult.value.finalOutput;

    // Check for approval
    if (critiqueOutput.includes(approvalSignal)) {
      return ok({ finalOutput: currentOutput, rounds: round, totalCostUsd });
    }

    // Feed critique back for next round
    currentOutput = critiqueOutput;
  }

  // Max rounds reached — return last worker output
  return ok({ finalOutput: currentOutput, rounds: maxRounds, totalCostUsd });
}
