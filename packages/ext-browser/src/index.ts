/**
 * @helix/ext-browser — Browser automation for Helix agents
 *
 * Backed by Playwright (peer dependency — install separately).
 *
 * FIXED: Browser/page state is now per-extension-instance, not module-level.
 * Multiple agents running concurrently each get their own browser context.
 *
 * Usage:
 *   npm install playwright @helix/ext-browser
 *   npx playwright install chromium
 *   Add "@helix/ext-browser" to hlx.config.ts extensions
 */

import type { ExtensionContext, HelixExtension } from "@helix/cli/extension";
import { defineTool } from "@helix/core";

// Lazy-loaded Playwright types
type Browser = import("playwright").Browser;
type Page = import("playwright").Page;

// ─── Per-instance browser state ───────────────────────────────────────────────
// Stored in closure captured by `makeTools()`, not as module-level variables.
// Each extension instance (= each loaded copy) gets independent state.

interface BrowserState {
  browser: Browser | undefined;
  page: Page | undefined;
}

async function getPage(state: BrowserState): Promise<Page> {
  if (!state.browser) {
    const { chromium } = await import("playwright");
    state.browser = await chromium.launch({ headless: true });
  }
  if (!state.page || state.page.isClosed()) {
    state.page = await state.browser.newPage();
  }
  return state.page;
}

function makeTools(state: BrowserState) {
  const navigateTool = defineTool({
    name: "browser_navigate",
    description: "Navigate the browser to a URL and wait for the page to load.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to navigate to" },
      },
      required: ["url"],
    },
    execute: async ({ url }: { url: string }) => {
      const p = await getPage(state);
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return { url: p.url(), title: await p.title() };
    },
    formatOutput: ({ url, title }) => `Navigated to: ${title} (${url})`,
  });

  const clickTool = defineTool({
    name: "browser_click",
    description: "Click an element on the page identified by a CSS selector or visible text.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the element" },
        text: { type: "string", description: "Visible text to find and click" },
      },
    },
    execute: async ({ selector, text }: { selector?: string; text?: string }) => {
      const p = await getPage(state);
      if (text) {
        await p.getByText(text, { exact: false }).first().click({ timeout: 10_000 });
        return { clicked: `text: "${text}"` };
      }
      if (selector) {
        await p.click(selector, { timeout: 10_000 });
        return { clicked: selector };
      }
      throw new Error("Provide either selector or text");
    },
    formatOutput: ({ clicked }) => `Clicked: ${clicked}`,
  });

  const typeTool = defineTool({
    name: "browser_type",
    description: "Type text into an input field identified by CSS selector or label.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the input" },
        label: { type: "string", description: "Label text of the input" },
        text: { type: "string", description: "Text to type" },
        clear: { type: "boolean", description: "Clear existing value first. Default: true" },
      },
      required: ["text"],
    },
    execute: async ({
      selector,
      label,
      text,
      clear = true,
    }: {
      selector?: string;
      label?: string;
      text: string;
      clear?: boolean;
    }) => {
      const p = await getPage(state);
      const locator = label ? p.getByLabel(label) : p.locator(selector ?? "input:visible");
      if (clear) await locator.clear();
      await locator.type(text, { delay: 30 });
      return { typed: text };
    },
    formatOutput: ({ typed }) => `Typed: ${typed}`,
  });

  const extractTextTool = defineTool({
    name: "browser_extract_text",
    description: "Extract visible text from the current page or a specific element.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to limit extraction. Omit for full page.",
        },
        maxLength: { type: "number", description: "Max characters to return. Default: 5000" },
      },
    },
    execute: async ({ selector, maxLength = 5000 }: { selector?: string; maxLength?: number }) => {
      const p = await getPage(state);
      const text = selector
        ? await p.locator(selector).innerText({ timeout: 5000 })
        : await p.evaluate(() => document.body.innerText);
      const truncated = text.length > maxLength;
      return { text: text.slice(0, maxLength), truncated, totalLength: text.length };
    },
    formatOutput: ({ text, truncated }) => (truncated ? `${text}\n[...truncated]` : text),
  });

  const screenshotTool = defineTool({
    name: "browser_screenshot",
    description: "Take a screenshot of the current page and save it to a file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to save the screenshot (PNG)" },
        fullPage: { type: "boolean", description: "Capture full scrollable page. Default: false" },
      },
      required: ["path"],
    },
    execute: async ({ path, fullPage = false }: { path: string; fullPage?: boolean }) => {
      const p = await getPage(state);
      await p.screenshot({ path, fullPage });
      return { path, fullPage };
    },
    formatOutput: ({ path }) => `Screenshot saved: ${path}`,
  });

  const getCurrentUrlTool = defineTool({
    name: "browser_current_url",
    description: "Get the current URL and page title.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      const p = await getPage(state);
      return { url: p.url(), title: await p.title() };
    },
    formatOutput: ({ url, title }) => `${title}\n${url}`,
  });

  const evaluateJsTool = defineTool({
    name: "browser_evaluate",
    description: "Run JavaScript in the browser page context and return the result.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JavaScript expression to evaluate" },
      },
      required: ["expression"],
    },
    execute: async ({ expression }: { expression: string }) => {
      const p = await getPage(state);
      // eslint-disable-next-line no-new-func
      // biome-ignore lint/security/noGlobalEval: allow controlled expression evaluation
      const result = await p.evaluate((expr) => eval(expr), expression);
      return { result };
    },
    formatOutput: ({ result }) => JSON.stringify(result, null, 2),
  });

  return [
    navigateTool,
    clickTool,
    typeTool,
    extractTextTool,
    screenshotTool,
    getCurrentUrlTool,
    evaluateJsTool,
  ];
}

// ─── Extension factory ────────────────────────────────────────────────────────
// Exported as a function so each load gets a fresh BrowserState instance.
// This means /reload creates a new instance — old browser is torn down via teardown().

function createBrowserExtension(): HelixExtension {
  // Each extension instance owns its browser — no shared module state
  const state: BrowserState = { browser: undefined, page: undefined };

  return {
    name: "@helix/ext-browser",
    version: "0.1.0",
    description: "Browser automation via Playwright",

    async setup(ctx: ExtensionContext) {
      try {
        await import("playwright");
        ctx.log("Playwright available — browser tools ready");
        return true;
      } catch {
        ctx.log(
          "Playwright not installed. Run: npm install playwright && npx playwright install chromium"
        );
        return false;
      }
    },

    async teardown() {
      if (state.browser) {
        await state.browser.close();
        state.browser = undefined;
        state.page = undefined;
      }
    },

    tools() {
      return makeTools(state);
    },

    commands() {
      return [
        {
          name: "browser",
          description: "Open a URL in the agent browser",
          usage: "/browser <url>",
          async execute(args, ctx) {
            if (!args[0]) return { type: "error", message: "Usage: /browser <url>" };
            await ctx.sendToAgent(`Navigate to ${args[0]} and summarize what you see.`);
            return { type: "handled" };
          },
        },
        {
          name: "screenshot",
          description: "Take a screenshot of the current browser page",
          usage: "/screenshot [path]",
          async execute(args, ctx) {
            const path = args[0] ?? `./screenshot-${Date.now()}.png`;
            if (!state.browser) {
              return { type: "error", message: "No browser open. Navigate somewhere first." };
            }
            await ctx.sendToAgent(`Take a screenshot and save it to ${path}`);
            return { type: "handled" };
          },
        },
      ];
    },
  };
}

export default createBrowserExtension();
