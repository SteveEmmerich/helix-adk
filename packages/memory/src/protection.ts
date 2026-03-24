import { createHash } from "node:crypto";
import type { ProtectionResult } from "./types.js";

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /ignore (previous|prior|above) instructions/i, reason: "prompt-injection" },
  { pattern: /disregard|override|bypass/i, reason: "prompt-injection" },
  { pattern: /you are now|act as|pretend to be/i, reason: "prompt-injection" },
  { pattern: /sk-[a-zA-Z0-9]{20,}/, reason: "api-key" },
  { pattern: /Bearer [a-zA-Z0-9._-]{20,}/, reason: "api-key" },
  { pattern: /<script|<iframe|javascript:/i, reason: "script-injection" },
];

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function checkPoisoning(content: string): ProtectionResult {
  if (content.length > 500) return { ok: false, reason: "content-too-long" };
  const newlineCount = content.split("\n").length - 1;
  if (newlineCount > 5) return { ok: false, reason: "too-many-newlines" };
  for (const entry of BLOCKED_PATTERNS) {
    if (entry.pattern.test(content)) return { ok: false, reason: entry.reason };
  }
  return { ok: true };
}
