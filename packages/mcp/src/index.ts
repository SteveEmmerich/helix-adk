/**
 * @helix/mcp — Model Context Protocol adapter
 *
 * Lets any MCP server (stdio or SSE transport) contribute tools to a Helix agent.
 * The entire MCP ecosystem — file systems, databases, APIs, dev tools — becomes
 * available without writing a single Helix tool definition.
 *
 * Usage:
 *   import { McpClient, mcpToolsFromServer } from "@helix/mcp";
 *
 *   // Connect to a stdio MCP server (e.g. the filesystem server)
 *   const client = await McpClient.fromStdio("npx", ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
 *   const tools = await client.tools();
 *
 *   const agent = new Agent({ provider, model, tools });
 *
 * MCP servers available from the official registry:
 *   @modelcontextprotocol/server-filesystem    File system access
 *   @modelcontextprotocol/server-github        GitHub API
 *   @modelcontextprotocol/server-postgres      PostgreSQL queries
 *   @modelcontextprotocol/server-sqlite        SQLite queries
 *   @modelcontextprotocol/server-puppeteer     Browser automation
 *   @modelcontextprotocol/server-slack         Slack integration
 *   ...and hundreds of community servers
 */

import type { JsonSchemaType, ToolDefinition } from "@helix/ai";
import { defineTool } from "@helix/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ─── Connection options ───────────────────────────────────────────────────────

export type McpTransport =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> };

// ─── MCP Client wrapper ───────────────────────────────────────────────────────

export class McpClient {
  readonly #client: Client;
  readonly #transport: McpTransport;
  #connected = false;

  private constructor(client: Client, transport: McpTransport) {
    this.#client = client;
    this.#transport = transport;
  }

  /** Connect to a stdio MCP server (most common — spawns a subprocess) */
  static async fromStdio(
    command: string,
    args: string[] = [],
    env?: Record<string, string>
  ): Promise<McpClient> {
    const transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env, ...env } as Record<string, string>,
    });

    const client = new Client(
      { name: "helix-mcp-client", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    await client.connect(transport);

    const instance = new McpClient(client, { type: "stdio", command, args, env });
    instance.#connected = true;
    return instance;
  }

  /** Connect to an SSE MCP server (remote or local HTTP) */
  static async fromSSE(url: string, headers?: Record<string, string>): Promise<McpClient> {
    const transport = new SSEClientTransport(new URL(url));
    const client = new Client(
      { name: "helix-mcp-client", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    await client.connect(transport);

    const instance = new McpClient(client, { type: "sse", url, headers });
    instance.#connected = true;
    return instance;
  }

  /** Get all tools from this MCP server as Helix ToolDefinitions */
  async tools(opts?: {
    /** Only expose tools matching this prefix */
    prefix?: string;
    /** Override the description prefix shown to the agent */
    descriptionPrefix?: string;
  }): Promise<readonly ToolDefinition[]> {
    if (!this.#connected) throw new Error("McpClient not connected");

    const { tools } = await this.#client.listTools();
    const prefix = opts?.prefix;
    const descPrefix = opts?.descriptionPrefix ?? "";

    return tools
      .filter((t) => !prefix || t.name.startsWith(prefix))
      .map((mcpTool) =>
        defineTool({
          name: mcpTool.name,
          description: descPrefix
            ? `[MCP] ${descPrefix}: ${mcpTool.description ?? mcpTool.name}`
            : (mcpTool.description ?? mcpTool.name),
          inputSchema: (mcpTool.inputSchema as JsonSchemaType & { type: "object" }) ?? {
            type: "object",
            properties: {},
          },
          execute: async (input: unknown, _signal: AbortSignal) => {
            // MCP doesn't support AbortSignal natively yet — best effort
            const result = await this.#client.callTool({
              name: mcpTool.name,
              arguments: input as Record<string, unknown>,
            });

            // MCP returns content blocks — extract text
            if (result.isError) {
              const errorText = result.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n");
              throw new Error(errorText || "MCP tool error");
            }

            const textContent = result.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");

            const imageContent = result.content
              .filter((c) => c.type === "image")
              .map((c) => ({ type: "image", data: c.data, mimeType: c.mimeType }));

            return imageContent.length > 0
              ? { text: textContent, images: imageContent }
              : { text: textContent };
          },
          formatOutput: (result: { text: string; images?: unknown[] }) => result.text,
        })
      );
  }

  /** List available tools without converting them */
  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    const { tools } = await this.#client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description }));
  }

  /** List available resources (files, data sources) */
  async listResources(): Promise<Array<{ uri: string; name?: string; mimeType?: string }>> {
    try {
      const { resources } = await this.#client.listResources();
      return resources.map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType }));
    } catch (e) {
      console.error("[mcp] Failed to list resources:", e);
      return []; // Not all servers implement resources
    }
  }

  async close(): Promise<void> {
    await this.#client.close();
    this.#connected = false;
  }

  get isConnected(): boolean {
    return this.#connected;
  }
}

// ─── Convenience: multi-server manager ────────────────────────────────────────

export interface McpServerConfig {
  readonly id: string;
  readonly transport: McpTransport;
  /** Filter tools by prefix */
  readonly toolPrefix?: string;
  /** Label shown to agent in tool descriptions */
  readonly label?: string;
}

export class McpManager {
  readonly #clients: Map<string, McpClient> = new Map();

  /** Connect to multiple MCP servers defined in config */
  async connect(servers: readonly McpServerConfig[]): Promise<void> {
    await Promise.allSettled(
      servers.map(async (server) => {
        try {
          const client =
            server.transport.type === "stdio"
              ? await McpClient.fromStdio(
                  server.transport.command,
                  server.transport.args,
                  server.transport.env
                )
              : await McpClient.fromSSE(server.transport.url, server.transport.headers);
          this.#clients.set(server.id, client);
        } catch (e) {
          console.error(
            `[hlx:mcp] Failed to connect to "${server.id}":`,
            e instanceof Error ? e.message : e
          );
        }
      })
    );
  }

  /** Get all tools from all connected servers */
  async allTools(): Promise<readonly ToolDefinition[]> {
    const toolArrays = await Promise.all(Array.from(this.#clients.values()).map((c) => c.tools()));
    return toolArrays.flat();
  }

  get(id: string): McpClient | undefined {
    return this.#clients.get(id);
  }

  /** Close all connections */
  async closeAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.#clients.values()).map((c) => c.close()));
    this.#clients.clear();
  }
}

// ─── Quick-connect helpers for popular MCP servers ────────────────────────────

export const mcpServers = {
  /** Official filesystem MCP server — expose a directory to the agent */
  filesystem: (paths: string[]): McpTransport => ({
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", ...paths],
  }),

  /** Official GitHub MCP server */
  github: (token?: string): McpTransport => ({
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: token ? { GITHUB_TOKEN: token } : {},
  }),

  /** Official PostgreSQL MCP server */
  postgres: (connectionString: string): McpTransport => ({
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", connectionString],
  }),

  /** Official SQLite MCP server */
  sqlite: (dbPath: string): McpTransport => ({
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sqlite", dbPath],
  }),

  /** Official Slack MCP server */
  slack: (botToken: string, teamId: string): McpTransport => ({
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    env: { SLACK_BOT_TOKEN: botToken, SLACK_TEAM_ID: teamId },
  }),

  /** Any custom SSE server */
  sse: (url: string, headers?: Record<string, string>): McpTransport => ({
    type: "sse",
    url,
    headers,
  }),
} as const;
