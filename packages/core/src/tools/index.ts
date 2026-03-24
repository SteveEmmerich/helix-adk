/**
 * Tool builder utilities and stdlib tools for @helix/core
 *
 * Improvements over pi-mono:
 * 1. defineTool<TInput, TOutput>() for full type inference
 * 2. Zod-compatible schema integration
 * 3. Tool composition and wrapping
 */

import type { JsonSchemaType, ToolDefinition } from "@helix/ai";

// ─── Type-safe tool builder ───────────────────────────────────────────────────

export interface ToolBuilder<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaType & { type: "object" };
  execute: (input: TInput, signal: AbortSignal) => Promise<TOutput>;
  formatOutput?: (output: TOutput) => string | null;
}

/**
 * Define a tool with full TypeScript inference.
 *
 * @example
 * ```ts
 * const searchTool = defineTool({
 *   name: "search",
 *   description: "Search the web",
 *   inputSchema: {
 *     type: "object",
 *     properties: {
 *       query: { type: "string", description: "The search query" }
 *     },
 *     required: ["query"]
 *   },
 *   execute: async ({ query }, signal) => {
 *     // ...
 *   }
 * });
 * ```
 */
export function defineTool<TInput = Record<string, unknown>, TOutput = unknown>(
  builder: ToolBuilder<TInput, TOutput>
): ToolDefinition<TInput, TOutput> {
  return {
    name: builder.name,
    description: builder.description,
    inputSchema: builder.inputSchema,
    execute: builder.execute,
    formatOutput: builder.formatOutput,
  };
}

// ─── Tool wrappers ────────────────────────────────────────────────────────────

/** Add a timeout to an existing tool */
export function withTimeout<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
  timeoutMs: number
): ToolDefinition<TInput, TOutput> {
  return {
    ...tool,
    execute: async (input, signal) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      signal.addEventListener("abort", () => controller.abort());

      try {
        return await tool.execute(input, controller.signal);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Add error recovery to a tool */
export function withFallback<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
  fallback: (error: Error, input: TInput) => Promise<TOutput>
): ToolDefinition<TInput, TOutput> {
  return {
    ...tool,
    execute: async (input, signal) => {
      try {
        return await tool.execute(input, signal);
      } catch (e) {
        return fallback(e instanceof Error ? e : new Error(String(e)), input);
      }
    },
  };
}

/** Cache tool results (in-memory, keyed by JSON.stringify(input)) */
export function withCache<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
  ttlMs = 60_000
): ToolDefinition<TInput, TOutput> {
  const cache = new Map<string, { value: TOutput; expiresAt: number }>();

  return {
    ...tool,
    execute: async (input, signal) => {
      const key = JSON.stringify(input);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;

      const value = await tool.execute(input, signal);
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    },
  };
}

// ─── Stdlib tools ─────────────────────────────────────────────────────────────

/** Read a file from the filesystem */
export const readFileTool = defineTool({
  name: "read_file",
  description: "Read the contents of a file at a given path.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative path to the file" },
      encoding: {
        type: "string",
        enum: ["utf-8", "base64"],
        description: "Encoding to use. Default: utf-8",
      },
    },
    required: ["path"],
  },
  execute: async ({ path, encoding = "utf-8" }: { path: string; encoding?: string }) => {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(path, encoding as "utf-8" | "base64");
    return { path, content, encoding };
  },
  formatOutput: ({ content }) => content,
});

/** Write content to a file */
export const writeFileTool = defineTool({
  name: "write_file",
  description: "Write content to a file, creating it if it doesn't exist.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to write" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  execute: async ({ path, content }: { path: string; content: string }) => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
    return { path, bytesWritten: content.length };
  },
  formatOutput: ({ path, bytesWritten }) => `Wrote ${bytesWritten} bytes to ${path}`,
});

/** Execute a shell command */
export const bashTool = defineTool({
  name: "bash",
  description: "Execute a shell command and return stdout/stderr. Use for system operations.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
      cwd: { type: "string", description: "Working directory for the command" },
      timeoutMs: {
        type: "number",
        description: "Timeout in milliseconds. Default: 30000",
      },
    },
    required: ["command"],
  },
  execute: async ({
    command,
    cwd,
    timeoutMs = 30_000,
  }: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
  }) => {
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);

    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    return { stdout: stdout.trim(), stderr: stderr.trim(), command };
  },
  formatOutput: ({ stdout, stderr }) => {
    const parts: string[] = [];
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(`[stderr] ${stderr}`);
    return parts.join("\n") || "(no output)";
  },
});

/** List directory contents */
export const listDirTool = defineTool({
  name: "list_dir",
  description: "List files and directories at a given path.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to list" },
      recursive: {
        type: "boolean",
        description: "Whether to list recursively. Default: false",
      },
    },
    required: ["path"],
  },
  execute: async ({ path, recursive = false }: { path: string; recursive?: boolean }) => {
    const { readdir } = await import("node:fs/promises");

    const entries = await readdir(path, { withFileTypes: true, recursive });
    return {
      path,
      entries: entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
      })),
    };
  },
  formatOutput: ({ path, entries }) => {
    const lines = [`${path}:`];
    for (const e of entries) {
      lines.push(`  ${e.isDirectory ? "📁" : "📄"} ${e.name}`);
    }
    return lines.join("\n");
  },
});

/** Default coding agent toolset (mirrors pi's 4-tool minimal set) */
export const codingTools = [readFileTool, writeFileTool, bashTool, listDirTool] as const;
