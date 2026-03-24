import type { ScanContext, ScanMatch, ScanResult } from "../types.js";
import { LEAK_PATTERNS, isValidLuhn } from "./patterns.js";

function previewValue(value: string): string {
  const trimmed = value.trim();
  const suffix = trimmed.slice(-4);
  return `...${suffix}`;
}

export class LeakScanner {
  scan(text: string, _context: ScanContext): ScanResult {
    const matches: ScanMatch[] = [];
    if (!text) return { matches, hasMatches: false };

    for (const pattern of LEAK_PATTERNS) {
      if (pattern.type === "credit_card") {
        const regex = pattern.regex;
        regex.lastIndex = 0;
        let match = regex.exec(text);
        while (match) {
          const value = match[0];
          if (value && isValidLuhn(value)) {
            matches.push({
              type: pattern.type,
              preview: previewValue(value),
              position: match.index ?? 0,
              pattern: pattern.name,
            });
            regex.lastIndex = match.index + value.length;
          } else {
            regex.lastIndex = (match.index ?? 0) + 1;
          }
          match = regex.exec(text);
        }
        continue;
      }
      pattern.regex.lastIndex = 0;
      for (const match of text.matchAll(pattern.regex)) {
        const value = match[0];
        if (!value) continue;
        matches.push({
          type: pattern.type,
          preview: previewValue(value),
          position: match.index ?? 0,
          pattern: pattern.name,
        });
      }
    }

    return { matches, hasMatches: matches.length > 0 };
  }
}
