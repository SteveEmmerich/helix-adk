import type { LeakType } from "../types.js";

export interface LeakPattern {
  readonly type: LeakType;
  readonly regex: RegExp;
  readonly name: string;
}

export const LEAK_PATTERNS: LeakPattern[] = [
  { type: "api_key", regex: /sk-[a-zA-Z0-9]{20,}/g, name: "openai_sk" },
  { type: "api_key", regex: /ANTHROPIC_API_KEY\s*=\s*[^\s]+/g, name: "anthropic_env" },
  { type: "api_key", regex: /sk-ant-[a-zA-Z0-9-]{20,}/g, name: "anthropic_sk" },
  { type: "api_key", regex: /AIza[0-9A-Za-z-_]{35}/g, name: "google_api" },
  { type: "aws_key", regex: /AKIA[0-9A-Z]{16}/g, name: "aws_access_key" },
  { type: "bearer_token", regex: /Bearer\s+[a-zA-Z0-9._-]{20,}/g, name: "bearer" },
  {
    type: "pii_email",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    name: "email",
  },
  { type: "pii_phone", regex: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, name: "phone" },
  { type: "pii_ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g, name: "ssn" },
  { type: "credit_card", regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, name: "credit_card" },
  { type: "private_key", regex: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g, name: "private_key" },
  { type: "certificate", regex: /-----BEGIN CERTIFICATE-----/g, name: "certificate" },
  { type: "jwt", regex: /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, name: "jwt" },
  { type: "github_token", regex: /gh[ps]_[a-zA-Z0-9]{36}/g, name: "github_token" },
];

export function isValidLuhn(input: string): boolean {
  const digits = input.replace(/\D/g, "");
  if (digits.length < 12) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const char = digits[i];
    if (!char) continue;
    let digit = Number(char);
    if (Number.isNaN(digit)) return false;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}
