#!/usr/bin/env node
/**
 * MCP server entrypoint.
 *
 * Exposes a single tool `search_google_ai({ query, timeout_ms? })` that runs a
 * Google AI Mode (udm=50) search inside your own logged-in Firefox session via
 * the sidecar extension, and returns the synthesized markdown answer + citations
 * back to the MCP client.
 *
 * Flow:
 *   1. Client calls search_google_ai({ query }).
 *   2. Bridge sends { type: "run-search", query } to host.js over TCP.
 *   3. host.js forwards to the Firefox extension over native messaging.
 *   4. Extension opens the AI Mode tab, waits for completion, runs the
 *      click-based SERPO citation extraction (DOM-bound, must run in the
 *      page context), and returns the resulting { html, citations } back.
 *   5. Bridge forwards { html, citations } to this server.
 *   6. Server-side parser (cheerio+turndown) converts to markdown, embeds
 *      citations, post-processes, and posts back { type: "parse-result", ok, markdown }.
 *   7. Bridge forwards that back to the extension, which relays as
 *      { type: "search-result" } to the MCP client.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { NativeMessagingBridge } from "./native-messaging.js";
import { parseAiResponse } from "./parser.js";
import { toGoogleAiModeQuery } from "./query.js";

interface ExtensionResponse {
  requestId: number;
  ok: boolean;
  error?: string;
  html?: string;
  citations?: any[];
}

function toToolResult(markdown: string): CallToolResult {
  return {
    content: [{ type: "text", text: markdown }],
  };
}

function toErrorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

async function main(): Promise<void> {
  const bridge = new NativeMessagingBridge();
  const server = new Server(
    { name: "google-ai-search", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_google_ai",
        description:
          "Run a Google AI Mode search (https://www.google.com/search?udm=50&q=...) using your own logged-in Firefox session and return the AI-synthesized answer with inline citations [1][2] and a source list. Free, grounded, no API key.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query to send to Google AI Mode.",
            },
            timeout_ms: {
              type: "number",
              description:
                "Optional timeout in milliseconds for waiting on the AI response (default 60000).",
            },
          },
          required: ["query"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as {
      query?: string;
      timeout_ms?: number;
    };

    if (name !== "search_google_ai") {
      return toErrorResult(`Unknown tool: ${name}`);
    }
    if (!args.query || typeof args.query !== "string") {
      return toErrorResult("Missing required argument: query");
    }
    const timeout = typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;

    try {
      const resp = (await bridge.search(
        toGoogleAiModeQuery(args.query),
        timeout
      )) as ExtensionResponse;

      if (!resp || !resp.ok) {
        return toErrorResult(resp?.error || "Extension did not return a successful result");
      }

      // Parse the raw HTML + citations into markdown.
      const parsed = parseAiResponse(resp.html ?? "", resp.citations ?? []);
      if (!parsed.ok) {
        return toErrorResult(parsed.error);
      }

      return toToolResult(parsed.markdown || "");
    } catch (err) {
      return toErrorResult(err instanceof Error ? err.message : String(err));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Clean up the host process on shutdown.
  process.on("SIGINT", async () => {
    await bridge.dispose();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await bridge.dispose();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(
    `[google-ai-search] fatal: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
});
