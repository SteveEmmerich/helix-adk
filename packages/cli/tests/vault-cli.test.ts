import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliPath = join(process.cwd(), "packages/cli/src/bin/hlx.ts");
const readSecretScript = join(process.cwd(), "packages/cli/tests/fixtures/read-secret.ts");

async function runCli(
  args: string[],
  input?: string,
  env?: Record<string, string>
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    stdin: input ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  if (input) {
    proc.stdin?.write(input);
    proc.stdin?.end();
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode, stdout, stderr };
}

describe("hlx vault CLI", () => {
  test("readSecret returns piped stdin in non-TTY", async () => {
    const proc = Bun.spawn(["bun", readSecretScript], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin?.write("piped-secret\n");
    proc.stdin?.end();
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    expect(output.trim()).toBe("piped-secret");
  });

  test("vault add with --value stores and list shows entry", async () => {
    const home = mkdtempSync(join(tmpdir(), "hlx-vault-"));
    const add = await runCli(
      ["vault", "add", "test_key", "--type", "api_key", "--value", "sk-test123"],
      undefined,
      { HOME: home }
    );
    expect(add.code).toBe(0);
    const list = await runCli(["vault", "list"], undefined, { HOME: home });
    expect(list.stdout).toContain("test_key");
  });

  test("vault add with mismatched confirmation exits 1", async () => {
    const home = mkdtempSync(join(tmpdir(), "hlx-vault-"));
    const result = await runCli(
      ["vault", "add", "mismatch_key", "--type", "api_key"],
      "one\ntwo\n",
      { HOME: home }
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Values do not match");
  });
});
