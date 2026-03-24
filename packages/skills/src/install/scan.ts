import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "@babel/parser";
import type { ScanError, ScanResult, ScanWarning } from "../types.js";

const SHELL_BLOCK = /```(bash|sh|zsh)\n[^`]+```/i;
const PROMPT_INJECTION = /(ignore previous|disregard|new instructions)/i;
const CREDENTIALS = /(api key|password|token)/i;
const SETUP_SECTION = /(#+\s*(Prerequisites|Setup)[\s\S]*?)(\n#+\s|$)/i;
const URL_REGEX = /https?:\/\/[^\s)"']+/g;

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

function addError(errors: ScanError[], code: string, message: string, file?: string) {
  errors.push({ code, message, file });
}

function addWarning(warnings: ScanWarning[], code: string, message: string, file?: string) {
  warnings.push({ code, message, file });
}

function checkUrls(content: string, errors: ScanError[], file: string) {
  const urls = content.match(URL_REGEX) ?? [];
  for (const url of urls) {
    if (url.includes("docs.") || url.includes("github.com/")) continue;
    addError(errors, "SKILL_URL", `Non-doc URL detected: ${url}`, file);
  }
}

function checkSkillMd(content: string, errors: ScanError[], file: string) {
  if (SHELL_BLOCK.test(content))
    addError(errors, "SKILL_SHELL", "Shell command block detected", file);
  const setup = content.match(SETUP_SECTION)?.[1] ?? "";
  if (setup && /(run|execute|install)/i.test(setup)) {
    addError(errors, "SKILL_SETUP", "Setup section contains run/execute instructions", file);
  }
  if (PROMPT_INJECTION.test(content))
    addError(errors, "SKILL_INJECTION", "Prompt injection pattern detected", file);
  if (CREDENTIALS.test(content))
    addError(errors, "SKILL_CREDENTIALS", "Credential request detected", file);
  checkUrls(content, errors, file);
}

function analyzeScript(
  content: string,
  errors: ScanError[],
  warnings: ScanWarning[],
  file: string
) {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(content, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    });
  } catch {
    addWarning(warnings, "SCRIPT_PARSE", "Failed to parse script", file);
    return;
  }

  const stack = [ast];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    for (const key of Object.keys(node)) {
      const value = (node as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const item of value) stack.push(item as object);
      } else if (value && typeof value === "object") {
        stack.push(value as object);
      }
    }

    if ((node as { type?: string }).type === "CallExpression") {
      const call = node as {
        callee: {
          type: string;
          name?: string;
          property?: { name?: string };
          object?: { name?: string };
        };
        arguments: Array<{ type: string; value?: unknown }>;
      };
      const callee = call.callee;
      if (callee.type === "Identifier" && callee.name === "eval") {
        addError(errors, "SCRIPT_EVAL", "eval() usage detected", file);
      }
      if (callee.type === "Identifier" && callee.name === "Function") {
        addError(errors, "SCRIPT_EVAL", "Function constructor detected", file);
      }
      if (callee.type === "Identifier" && callee.name === "require") {
        const arg = call.arguments[0];
        if (arg?.type !== "StringLiteral") {
          addError(errors, "SCRIPT_DYNAMIC_IMPORT", "Dynamic require() detected", file);
        }
      }
      if (callee.type === "Import") {
        const arg = call.arguments[0];
        if (arg?.type !== "StringLiteral") {
          addError(errors, "SCRIPT_DYNAMIC_IMPORT", "Dynamic import() detected", file);
        }
      }
      if (callee.type === "MemberExpression") {
        const obj = callee.object as { name?: string } | undefined;
        const prop = callee.property as { name?: string } | undefined;
        if (obj?.name === "process" && prop?.name === "exit") {
          addError(errors, "SCRIPT_PROCESS_EXIT", "process.exit() usage detected", file);
        }
        if (obj?.name === "Bun" && prop?.name === "spawn") {
          addWarning(warnings, "SCRIPT_SPAWN", "Bun.spawn usage detected", file);
        }
        if (obj?.name === "fs") {
          addWarning(warnings, "SCRIPT_FS", "fs usage detected", file);
        }
        if (obj?.name === "console" && prop?.name === "log") {
          addWarning(warnings, "SCRIPT_LOG", "console.log usage detected", file);
        }
      }
      if (callee.type === "Identifier" && callee.name === "fetch") {
        addWarning(warnings, "SCRIPT_FETCH", "fetch() usage detected", file);
      }
      if (callee.type === "Identifier" && callee.name === "exec") {
        addWarning(warnings, "SCRIPT_EXEC", "exec usage detected", file);
      }
    }

    if ((node as { type?: string }).type === "NewExpression") {
      const expr = node as { callee: { type: string; name?: string } };
      if (expr.callee.type === "Identifier" && expr.callee.name === "Function") {
        addError(errors, "SCRIPT_EVAL", "Function constructor detected", file);
      }
      if (expr.callee.type === "Identifier" && expr.callee.name === "XMLHttpRequest") {
        addWarning(warnings, "SCRIPT_FETCH", "XMLHttpRequest usage detected", file);
      }
    }

    if ((node as { type?: string }).type === "ImportDeclaration") {
      const decl = node as { source?: { value?: string } };
      const value = decl.source?.value ?? "";
      if (value.includes("child_process") || value.includes("node:child_process")) {
        addWarning(warnings, "SCRIPT_CHILD_PROCESS", "child_process import detected", file);
      }
      if (value.includes("fs") || value.includes("node:fs")) {
        addWarning(warnings, "SCRIPT_FS", "fs import detected", file);
      }
    }

    if ((node as { type?: string }).type === "MemberExpression") {
      const expr = node as { object: { name?: string }; property: { name?: string } };
      if (expr.object?.name === "process" && expr.property?.name === "env") {
        addError(errors, "SCRIPT_ENV", "process.env access detected", file);
      }
    }

    if ((node as { type?: string }).type === "Identifier") {
      const id = node as { name?: string };
      if (id.name === "__dirname" || id.name === "__filename") {
        addError(errors, "SCRIPT_PATH", "__dirname/__filename usage detected", file);
      }
    }
  }
}

export async function scan(skillPath: string): Promise<ScanResult> {
  const warnings: ScanWarning[] = [];
  const errors: ScanError[] = [];
  const files = await walk(skillPath);

  for (const file of files) {
    const content = await readFile(file, "utf-8");
    if (file.endsWith("SKILL.md")) {
      checkSkillMd(content, errors, file);
    }

    if (file.includes(`${join("scripts", "")}`) && (file.endsWith(".ts") || file.endsWith(".js"))) {
      analyzeScript(content, errors, warnings, file);
      const lines = content.split("\n").length;
      if (lines > 500) addWarning(warnings, "SCRIPT_LARGE", "Large script file", file);
    }
  }

  const passed = errors.length === 0;
  return {
    passed,
    warnings,
    errors,
    filesScanned: files.length,
  };
}
