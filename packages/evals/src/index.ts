/**
 * @helix/evals — Evaluation framework for agents
 *
 * Completely absent from pi-mono. Helix makes testing agents first-class.
 *
 * Concepts:
 * - EvalCase: A single input/expected-output test case
 * - Scorer: A function that rates a response (exact match, LLM judge, regex, etc.)
 * - EvalSuite: A collection of cases with a shared scorer
 * - EvalRunner: Runs suites, collects metrics, generates reports
 */

import type { Agent, AgentConfig } from "@helix/core";

// ─── Score types ──────────────────────────────────────────────────────────────

export interface Score {
  /** 0–1 range. 1 = perfect */
  readonly value: number;
  readonly label: string;
  readonly reasoning?: string;
}

export type Scorer<TInput = string, TOutput = string> = (
  input: TInput,
  output: TOutput,
  expected?: TOutput
) => Promise<Score> | Score;

// ─── Built-in scorers ─────────────────────────────────────────────────────────

export const exactMatch: Scorer = (_, output, expected) => {
  if (expected === undefined) return { value: 0, label: "no_expected" };
  const match = output.trim() === expected.trim();
  return { value: match ? 1 : 0, label: match ? "exact_match" : "no_match" };
};

export const containsMatch: Scorer = (_, output, expected) => {
  if (expected === undefined) return { value: 0, label: "no_expected" };
  const match = output.toLowerCase().includes(expected.toLowerCase());
  return { value: match ? 1 : 0, label: match ? "contains" : "not_contains" };
};

export const regexMatch =
  (pattern: RegExp): Scorer =>
  (_, output) => {
    const match = pattern.test(output);
    return { value: match ? 1 : 0, label: match ? "regex_match" : "no_match" };
  };

/** LLM-as-judge scorer */
export const llmJudge =
  (judge: Agent, rubric: string): Scorer =>
  async (input, output) => {
    const prompt = `You are an evaluator. Rate the following response on a scale of 0.0 to 1.0.\n\nRubric: ${rubric}\n\nUser input: ${input}\n\nResponse to evaluate: ${output}\n\nReply with ONLY a JSON object: { "score": <0.0-1.0>, "reasoning": "<brief explanation>" }`;

    const result = await judge.run({ input: prompt });
    if (!result.ok) return { value: 0, label: "judge_error", reasoning: result.error.message };

    try {
      const parsed = JSON.parse(result.value.finalMessage) as {
        score: number;
        reasoning: string;
      };
      return {
        value: Math.max(0, Math.min(1, parsed.score)),
        label: "llm_judge",
        reasoning: parsed.reasoning,
      };
    } catch {
      return { value: 0, label: "parse_error", reasoning: result.value.finalMessage };
    }
  };

// ─── Eval case ────────────────────────────────────────────────────────────────

export interface EvalCase<TInput = string, TExpected = string> {
  readonly id: string;
  readonly input: TInput;
  readonly expected?: TExpected;
  readonly tags?: readonly string[];
  /** Optional additional assertions beyond the scorer */
  readonly assertions?: readonly ((output: string) => boolean | string)[];
}

// ─── Eval result ──────────────────────────────────────────────────────────────

export interface EvalResult<TInput = string> {
  readonly caseId: string;
  readonly input: TInput;
  readonly output: string;
  readonly score: Score;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly costUsd: number;
  readonly tokens: number;
  readonly assertionFailures: readonly string[];
}

export interface SuiteResult {
  readonly suiteName: string;
  readonly cases: readonly EvalResult[];
  readonly passRate: number;
  readonly avgScore: number;
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  readonly durationMs: number;
}

// ─── Eval suite ───────────────────────────────────────────────────────────────

export interface EvalSuiteConfig<TInput = string, TExpected = string> {
  readonly name: string;
  readonly cases: readonly EvalCase<TInput, TExpected>[];
  readonly scorer: Scorer<TInput, TExpected>;
  /** Score threshold for "pass". Default: 0.8 */
  readonly passThreshold?: number;
  /** Max concurrent cases. Default: 5 */
  readonly concurrency?: number;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export interface RunnerConfig {
  readonly agentConfig: AgentConfig;
  readonly onResult?: (result: EvalResult) => void;
  readonly onSuiteComplete?: (result: SuiteResult) => void;
}

export class EvalRunner {
  readonly #config: RunnerConfig;

  constructor(config: RunnerConfig) {
    this.#config = config;
  }

  async runSuite<TInput extends string, TExpected extends string>(
    suite: EvalSuiteConfig<TInput, TExpected>
  ): Promise<SuiteResult> {
    const { Agent } = await import("@helix/core");
    const startMs = Date.now();
    const concurrency = suite.concurrency ?? 5;
    const passThreshold = suite.passThreshold ?? 0.8;

    const results: EvalResult<TInput>[] = [];
    const queue = [...suite.cases];

    const runCase = async (evalCase: EvalCase<TInput, TExpected>): Promise<EvalResult<TInput>> => {
      const agent = new Agent(this.#config.agentConfig);
      const caseStart = Date.now();

      const result = await agent.run({ input: evalCase.input as string });
      const output = result.ok ? result.value.finalMessage : `ERROR: ${result.error.message}`;
      const state = result.ok ? result.value.state : agent.state;

      const score = await suite.scorer(evalCase.input, output as TExpected, evalCase.expected);

      const assertionFailures: string[] = [];
      if (evalCase.assertions) {
        for (const assertion of evalCase.assertions) {
          const res = assertion(output);
          if (res !== true) {
            assertionFailures.push(typeof res === "string" ? res : "Assertion failed");
          }
        }
      }

      return {
        caseId: evalCase.id,
        input: evalCase.input,
        output,
        score,
        passed: score.value >= passThreshold && assertionFailures.length === 0,
        durationMs: Date.now() - caseStart,
        costUsd: state.totalCostUsd,
        tokens: state.totalTokens,
        assertionFailures,
      };
    };

    // Process with concurrency limit
    while (queue.length > 0) {
      const batch = queue.splice(0, concurrency);
      const batchResults = await Promise.all(batch.map(runCase));
      for (const r of batchResults) {
        results.push(r);
        this.#config.onResult?.(r);
      }
    }

    const suiteResult: SuiteResult = {
      suiteName: suite.name,
      cases: results,
      passRate: results.filter((r) => r.passed).length / results.length,
      avgScore: results.reduce((sum, r) => sum + r.score.value, 0) / results.length,
      totalCostUsd: results.reduce((sum, r) => sum + r.costUsd, 0),
      totalTokens: results.reduce((sum, r) => sum + r.tokens, 0),
      durationMs: Date.now() - startMs,
    };

    this.#config.onSuiteComplete?.(suiteResult);
    return suiteResult;
  }

  /** Render a suite result as a human-readable table */
  static formatResult(result: SuiteResult): string {
    const lines: string[] = [
      `\n📊 Eval Suite: ${result.suiteName}`,
      `${"─".repeat(60)}`,
      `Pass rate:   ${(result.passRate * 100).toFixed(1)}%  (${result.cases.filter((c) => c.passed).length}/${result.cases.length})`,
      `Avg score:   ${result.avgScore.toFixed(3)}`,
      `Total cost:  $${result.totalCostUsd.toFixed(4)}`,
      `Total tokens: ${result.totalTokens.toLocaleString()}`,
      `Duration:    ${(result.durationMs / 1000).toFixed(1)}s`,
      `${"─".repeat(60)}`,
    ];

    for (const c of result.cases) {
      const status = c.passed ? "✅" : "❌";
      lines.push(`${status} [${c.caseId}] score=${c.score.value.toFixed(2)} (${c.durationMs}ms)`);
      if (!c.passed && c.score.reasoning) {
        lines.push(`   └─ ${c.score.reasoning}`);
      }
      if (c.assertionFailures.length > 0) {
        for (const f of c.assertionFailures) {
          lines.push(`   └─ ❗ ${f}`);
        }
      }
    }

    return lines.join("\n");
  }
}
