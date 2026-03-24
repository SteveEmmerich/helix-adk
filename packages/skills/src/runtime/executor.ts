import { join } from "node:path";
import type { ToolDefinition } from "@helix/ai";
import { WasmSandbox } from "../install/sandbox.js";
import type { SandboxCapabilities, SandboxResult, SkillContext } from "../types.js";
import { SkillPermissionError } from "../types.js";

export class ToolRegistryProxy {
  readonly #tools: Map<string, ToolDefinition>;
  readonly #skillId: string;
  readonly #allowed: Set<string>;

  constructor(skillId: string, tools: readonly ToolDefinition[], allowed: readonly string[]) {
    this.#skillId = skillId;
    this.#tools = new Map(tools.map((t) => [t.name, t]));
    this.#allowed = new Set(allowed);
  }

  get(name: string): ToolDefinition {
    if (!this.#allowed.has(name)) {
      console.warn(
        `[skills] Blocked: ${this.#skillId} attempted to call ${name} (not in allowed-tools)`
      );
      throw new SkillPermissionError(this.#skillId, name);
    }
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool;
  }
}

export class SkillExecutor {
  readonly #sandbox: WasmSandbox;

  constructor(sandbox?: WasmSandbox) {
    this.#sandbox = sandbox ?? new WasmSandbox();
  }

  async runScript(
    skillPath: string,
    script: string,
    input: unknown,
    context: SkillContext,
    capabilities: SandboxCapabilities
  ): Promise<SandboxResult> {
    const scriptPath = join(skillPath, "scripts", script);
    return this.#sandbox.execute(scriptPath, input, {
      ...capabilities,
      tools: context.allowedTools,
    });
  }
}
