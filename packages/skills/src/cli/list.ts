import { SkillLoader } from "../runtime/loader.js";

export async function runList(cwd = process.cwd()) {
  const loader = new SkillLoader({ cwd });
  return loader.discover();
}
