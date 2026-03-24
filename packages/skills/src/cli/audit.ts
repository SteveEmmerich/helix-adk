import { SkillLoader } from "../runtime/loader.js";

export async function runAudit(cwd = process.cwd()) {
  const loader = new SkillLoader({ cwd });
  const skills = await loader.audit();
  return skills;
}
