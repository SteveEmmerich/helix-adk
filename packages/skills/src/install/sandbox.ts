import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "bun";
import type { SandboxCapabilities, SandboxResult } from "../types.js";

export interface SandboxConfig {
  readonly wasmRunner?: "wasmtime" | "wasmer" | "subprocess";
}

function nowMs(): number {
  return Date.now();
}

async function checkWasmtime(): Promise<boolean> {
  try {
    const proc = spawn({
      cmd: ["wasmtime", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export class WasmSandbox {
  readonly #config: SandboxConfig;
  #wasmtimeAvailable: boolean | null = null;

  constructor(config: SandboxConfig = {}) {
    this.#config = config;
  }

  async execute(
    scriptPath: string,
    input: unknown,
    capabilities: SandboxCapabilities
  ): Promise<SandboxResult> {
    if (this.#wasmtimeAvailable === null) {
      if (this.#config.wasmRunner === "subprocess") {
        this.#wasmtimeAvailable = false;
      } else {
        this.#wasmtimeAvailable =
          this.#config.wasmRunner === "wasmtime" ? await checkWasmtime() : await checkWasmtime();
      }
      if (!this.#wasmtimeAvailable) {
        console.warn(
          "[skills] WASM sandbox unavailable — using restricted subprocess. Install wasmtime for full sandboxing: brew install wasmtime"
        );
      }
    }

    if (this.#wasmtimeAvailable) {
      return this.#executeWasm(scriptPath, input, capabilities);
    }
    return this.#executeSubprocess(scriptPath, input, capabilities);
  }

  async #executeWasm(
    scriptPath: string,
    input: unknown,
    capabilities: SandboxCapabilities
  ): Promise<SandboxResult> {
    const started = nowMs();
    const timeoutMs = capabilities.timeoutMs ?? 10_000;
    const build = await Bun.build({
      entrypoints: [scriptPath],
      target: "browser",
      format: "esm",
      minify: true,
    });

    const output = build.outputs[0];
    if (!output) {
      return {
        success: false,
        output: null,
        logs: [],
        error: "Build failed",
        durationMs: nowMs() - started,
        resourceUsage: { memoryMb: capabilities.memoryMb ?? 64, cpuMs: nowMs() - started },
      };
    }

    const tmpPath = `/tmp/helix-skill-${Date.now()}.js`;
    await Bun.write(tmpPath, await output.text());

    const args: string[] = [
      "wasmtime",
      "--timeout",
      String(timeoutMs),
      "--env",
      `SKILL_INPUT=${JSON.stringify(input ?? {})}`,
    ];
    for (const [key, value] of Object.entries(capabilities.env ?? {})) {
      args.push("--env", `${key}=${value}`);
    }
    for (const p of capabilities.filesystem?.read ?? []) {
      args.push("--dir", p);
    }
    for (const p of capabilities.filesystem?.write ?? []) {
      args.push("--dir", p);
    }
    args.push("--", tmpPath);

    const proc = spawn({
      cmd: args,
      stdout: "pipe",
      stderr: "pipe",
      env: {},
    });

    const timeout = setTimeout(() => {
      proc.kill();
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    clearTimeout(timeout);
    await rm(tmpPath, { force: true });

    const durationMs = nowMs() - started;
    return {
      success: proc.exitCode === 0,
      output: stdout.trim() ? stdout.trim() : null,
      logs: stderr.trim() ? stderr.trim().split("\n") : [],
      error: proc.exitCode === 0 ? null : stderr.trim() || "WASM execution failed",
      durationMs,
      resourceUsage: { memoryMb: capabilities.memoryMb ?? 64, cpuMs: durationMs },
    };
  }

  async #executeSubprocess(
    scriptPath: string,
    input: unknown,
    capabilities: SandboxCapabilities
  ): Promise<SandboxResult> {
    const started = nowMs();
    const timeoutMs = capabilities.timeoutMs ?? 10_000;
    const logs: string[] = [];
    const env = capabilities.env ?? {};
    const cwd = dirname(scriptPath);
    const resolvedBun = process.execPath.startsWith("/")
      ? process.execPath
      : (Bun.which("bun") ?? process.execPath);
    const child = spawn({
      cmd: [resolvedBun, scriptPath],
      env,
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    child.stdin.write(`${JSON.stringify(input ?? {})}\n`);
    child.stdin.end();

    const timeout = setTimeout(() => {
      child.kill();
    }, timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    clearTimeout(timeout);
    if (stdout.trim()) logs.push(stdout.trim());
    if (stderr.trim()) logs.push(stderr.trim());

    const durationMs = nowMs() - started;

    return {
      success: exitCode === 0,
      output: stdout.trim() ? stdout.trim() : null,
      logs,
      error: exitCode === 0 ? null : stderr.trim() || "Script failed",
      durationMs,
      resourceUsage: { memoryMb: capabilities.memoryMb ?? 64, cpuMs: durationMs },
    };
  }
}
