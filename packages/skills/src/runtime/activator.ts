import type { SafetyLayer } from "@helixclaw/safety";
import type { SkillContext } from "../types.js";

export class SkillActivator {
  readonly #safety?: SafetyLayer;

  constructor(safety?: SafetyLayer) {
    this.#safety = safety;
  }

  activate(skillId: string, context: SkillContext): void {
    if (!this.#safety) return;
    const requires = context.requiresApproval ?? [];
    for (const tool of requires) {
      this.#safety.addSkillRules?.(skillId, tool);
    }
  }
}
