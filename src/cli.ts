#!/usr/bin/env node
/**
 * CLI client for harnesses without proper MCP support.
 *
 * Bridges the MCP server at dist/index.js directly from the command line,
 * useful for agents/harnesses (e.g. Codex) that don't expose MCP tools.
 *
 * Usage:
 *   npx anima-use-google <query>
 *   npx anima-use-google --query "your query" [--timeout-ms 60000]
 *   echo "your query" | npx anima-use-google --stdin
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

// Resolve the MCP server entry point relative to this file's location
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(__dirname, "index.js");

interface Args {
  query?: string;
  timeoutMs: number;
  showHelp: boolean;
}

function showHelp(): void {
  console.error(
    [
      "anima-use-google CLI client",
      "",
      "Usage:",
      "  anima-use-google <query>",
      "  anima-use-google --query <query> [--timeout-ms <ms>]",
      "  echo <query> | anima-use-google --stdin",
      "  anima-use-google --help",
      "",
      "Options:",
      "  --query <query>   Search query for Google AI Mode",
      "  --timeout-ms <ms> Timeout in milliseconds (default: 60000)",
      "  --stdin           Read query from stdin",
      "  --help            Show this help",
    ].join("\n")
  );
  process.exit(0);
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    query: undefined,
    timeoutMs: 60000,
    showHelp: false,
  };

  // Handle --help, --version first
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      out.showHelp = true;
      return out;
    }
    if (arg === "--version" || arg === "-v") {
      out.showHelp = true;
      return out;
    }
  }

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--query") {
      out.query = argv[++i];
    } else if (arg === "--timeout-ms" || arg === "--timeout") {
      const num = parseInt(argv[++i], 10);
      if (!Number.isNaN(num)) {
        out.timeoutMs = num;
      }
    } else if (arg === "--stdin") {
      out.query = undefined; // flag to read from stdin
    } else if (arg.startsWith("--")) {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    } else {
      // Positional argument joins everything as the query
      if (out.query === undefined) {
        out.query = arg;
      } else {
        out.query += " " + arg;
      }
    }
    i++;
  }

  return out;
}

async function readQueryFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    console.error("Error: --stdin flag used but no input piped");
    process.exit(2);
  }

  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }

  const query = chunks.join("").trim();
  if (!query) {
    console.error("Error: empty stdin input");
    process.exit(2);
  }

  return query;
}

async function runQuery(query: string, timeoutMs: number): Promise<void> {
  let stderrChunks: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [MCP_SERVER_PATH],
    cwd: path.dirname(__dirname),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });

  const client = new Client(
    { name: "anima-use-google-cli", version: "0.1.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);

    const result = await client.callTool(
      {
        name: "search_google_ai",
        arguments: {
          query,
          timeout_ms: timeoutMs,
        },
      },
      undefined,
      { timeout: timeoutMs + 30000 }
    );

    if (result.isError) {
      const text = (result.content as Array<{ type: string; text: string }>)?.[0]?.text;
      console.error(`Search error: ${text ?? "unknown error"}`);
      process.exit(1);
    }

    const text = (result.content as Array<{ type: string; text: string }>)?.[0]?.text;
    process.stdout.write(text ?? "");
  } catch (err) {
    const stderr = stderrChunks.join("").trim();
    console.error(
      `MCP client error: ${err instanceof Error ? err.message : String(err)}${
        stderr ? `\nServer stderr: ${stderr}` : ""
      }`
    );
    process.exit(1);
  } finally {
    await client.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.showHelp) {
    showHelp();
    return;
  }

  let query = args.query;

  // If no positional or --query provided, try stdin
  if (query === undefined) {
    query = await readQueryFromStdin();
  }

  if (!query || !query.trim()) {
    console.error(
      "Error: query is required. Use --query <query>, positional argument, or --stdin"
    );
    showHelp();
    process.exit(2);
  }

  await runQuery(query.trim(), args.timeoutMs);
}

main().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
