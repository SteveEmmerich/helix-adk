/**
 * @helix/ext-search — Web search for Helix agents
 *
 * Supports: Brave Search API, Serper.dev, SerpAPI (Google)
 * Configure via environment variables:
 *   BRAVE_SEARCH_API_KEY   → uses Brave
 *   SERPER_API_KEY         → uses Serper (Google results)
 *   SERPAPI_KEY            → uses SerpAPI
 *
 * Falls back gracefully if no key is set.
 */

import type { ExtensionContext, HelixExtension } from "@helix/cli/extension";
import { defineTool } from "@helix/core";

// ─── Provider detection ───────────────────────────────────────────────────────

type SearchProvider = "brave" | "serper" | "serpapi" | "none";

function detectProvider(): SearchProvider {
  if (process.env.BRAVE_SEARCH_API_KEY) return "brave";
  if (process.env.SERPER_API_KEY) return "serper";
  if (process.env.SERPAPI_KEY) return "serpapi";
  return "none";
}

// ─── Result type ──────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ─── Provider implementations ─────────────────────────────────────────────────

async function braveSearch(
  query: string,
  count: number,
  signal: AbortSignal
): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) throw new Error("BRAVE_SEARCH_API_KEY is not set");
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal,
    }
  );
  if (!res.ok) throw new Error(`Brave search failed: ${res.status}`);
  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description?: string }> };
  };
  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description ?? "",
  }));
}

async function serperSearch(
  query: string,
  count: number,
  signal: AbortSignal
): Promise<SearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error("SERPER_API_KEY is not set");
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({ q: query, num: count }),
    signal,
  });
  if (!res.ok) throw new Error(`Serper search failed: ${res.status}`);
  const data = (await res.json()) as {
    organic?: Array<{ title: string; link: string; snippet?: string }>;
  };
  return (data.organic ?? []).map((r) => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet ?? "",
  }));
}

async function serpApiSearch(
  query: string,
  count: number,
  signal: AbortSignal
): Promise<SearchResult[]> {
  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&num=${count}&api_key=${process.env.SERPAPI_KEY}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`SerpAPI search failed: ${res.status}`);
  const data = (await res.json()) as {
    organic_results?: Array<{ title: string; link: string; snippet?: string }>;
  };
  return (data.organic_results ?? []).map((r) => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet ?? "",
  }));
}

async function runSearch(
  query: string,
  count: number,
  signal: AbortSignal
): Promise<SearchResult[]> {
  const provider = detectProvider();
  switch (provider) {
    case "brave":
      return braveSearch(query, count, signal);
    case "serper":
      return serperSearch(query, count, signal);
    case "serpapi":
      return serpApiSearch(query, count, signal);
    default:
      throw new Error(
        "No search API key configured. Set BRAVE_SEARCH_API_KEY, SERPER_API_KEY, or SERPAPI_KEY."
      );
  }
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const searchTool = defineTool({
  name: "web_search",
  description:
    "Search the web for current information. Use for: recent events, documentation, " +
    "prices, news, or anything that might have changed recently.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      count: { type: "number", description: "Number of results (1-10). Default: 5" },
    },
    required: ["query"],
  },
  execute: async ({ query, count = 5 }: { query: string; count?: number }, signal) => {
    const results = await runSearch(query, Math.min(count, 10), signal);
    return { query, results };
  },
  formatOutput: ({ query, results }) => {
    if (results.length === 0) return `No results for: ${query}`;
    return results
      .map((r: SearchResult, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
  },
});

const fetchPageTool = defineTool({
  name: "web_fetch",
  description: "Fetch the text content of a webpage. Use after web_search to read full articles.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
      maxLength: { type: "number", description: "Max characters to return. Default: 8000" },
    },
    required: ["url"],
  },
  execute: async ({ url, maxLength = 8000 }: { url: string; maxLength?: number }, signal) => {
    const res = await fetch(url, {
      headers: { "User-Agent": "Helix-ADK/0.1 (+https://github.com/helix-adk)" },
      signal,
    });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);

    const html = await res.text();

    // Strip HTML tags (simple, no parser dependency)
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const truncated = text.length > maxLength;
    return { url, text: text.slice(0, maxLength), truncated };
  },
  formatOutput: ({ text, truncated }) => (truncated ? `${text}\n[...truncated]` : text),
});

// ─── Extension ────────────────────────────────────────────────────────────────

const searchExtension: HelixExtension = {
  name: "@helix/ext-search",
  version: "0.1.0",
  description: "Web search via Brave, Serper, or SerpAPI",

  setup(ctx: ExtensionContext) {
    const provider = detectProvider();
    if (provider === "none") {
      ctx.log("No search API key found. Set BRAVE_SEARCH_API_KEY, SERPER_API_KEY, or SERPAPI_KEY.");
      return false;
    }
    ctx.log(`Search provider: ${provider}`);
    return true;
  },

  tools() {
    return [searchTool, fetchPageTool];
  },

  commands() {
    return [
      {
        name: "search",
        aliases: ["s"],
        description: "Quick web search",
        usage: "/search <query>",
        async execute(args, ctx) {
          if (!args.length) return { type: "error", message: "Usage: /search <query>" };
          await ctx.sendToAgent(`Search the web for: ${args.join(" ")}`);
          return { type: "handled" };
        },
      },
    ];
  },
};

export default searchExtension;
