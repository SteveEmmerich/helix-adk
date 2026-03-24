import { install } from "../install/index.js";

export async function runInstall(source: string, opts: { tier?: string; force?: boolean } = {}) {
  const result = await install(source, {
    tier: opts.tier?.toUpperCase() as "UNVERIFIED" | undefined,
    force: opts.force,
  });
  return result;
}
