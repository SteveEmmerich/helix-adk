import type { RedactResult, ScanMatch } from "../types.js";
import { LEAK_PATTERNS, isValidLuhn } from "./patterns.js";

function previewValue(value: string): string {
  const trimmed = value.trim();
  const suffix = trimmed.slice(-4);
  return `...${suffix}`;
}

export function redact(text: string): RedactResult {
  let redacted = text;
  const matches: ScanMatch[] = [];

  const creditPattern = LEAK_PATTERNS.find((pattern) => pattern.type === "credit_card");
  if (creditPattern) {
    creditPattern.regex.lastIndex = 0;
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    let match = creditPattern.regex.exec(redacted);
    while (match) {
      const value = match[0];
      if (value && isValidLuhn(value)) {
        replacements.push({
          start: match.index ?? 0,
          end: (match.index ?? 0) + value.length,
          value,
        });
        creditPattern.regex.lastIndex = (match.index ?? 0) + value.length;
      } else {
        creditPattern.regex.lastIndex = (match.index ?? 0) + 1;
      }
      match = creditPattern.regex.exec(redacted);
    }

    for (const replacement of replacements.reverse()) {
      const preview = previewValue(replacement.value);
      matches.push({
        type: "credit_card",
        preview,
        position: replacement.start,
        pattern: creditPattern.name,
      });
      redacted = `${redacted.slice(0, replacement.start)}[REDACTED:credit_card:${preview}]${redacted.slice(replacement.end)}`;
    }
  }

  for (const pattern of LEAK_PATTERNS) {
    if (pattern.type === "credit_card") continue;
    pattern.regex.lastIndex = 0;
    redacted = redacted.replace(pattern.regex, (value, offset) => {
      const preview = previewValue(value);
      matches.push({
        type: pattern.type,
        preview,
        position: typeof offset === "number" ? offset : 0,
        pattern: pattern.name,
      });
      return `[REDACTED:${pattern.type}:${preview}]`;
    });
  }

  return {
    redacted,
    matches,
    wasModified: redacted !== text,
  };
}
