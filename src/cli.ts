#!/usr/bin/env node
/**
 * CLI for Google AI Mode searches via the native host on 127.0.0.1:51784.
 *
 * Direct-host mode: talks straight to the native host over raw TCP (4-byte
 * LE length prefix + UTF-8 JSON frames) via the existing NativeMessagingBridge.
 * No MCP subprocess (dist/index.js) is spawned. Cross-platform (CLI runs on
 * Node stdlib + cheerio/turndown transitively via parseAiResponse).
 *
 * Usage:
 *   anima-use-google-cli <query>
 *   anima-use-google-cli --query <query> [--json|--raw] [--timeout-ms <ms>]
 *   echo <query> | anima-use-google-cli --stdin [--json|--raw]
 *   anima-use-google-cli status [--json|--raw]
 *   anima-use-google-cli --help
 *
 * Env (and where they are honored):
 *   GOOGLE_AI_HOST_HOST      TCP host to connect to (default 127.0.0.1)
 *   GOOGLE_AI_HOST_PORT      TCP port to connect to (default 51784)
 *   GOOGLE_AI_TIMEOUT_MS     Default per-request timeout in ms (default 60000)
 *   GOOGLE_AI_BRIDGE_GRACE_MS  Grace period on top of timeout (default 30000)
 */

import { NativeMessagingBridge } from "./native-messaging.js";
import { parseAiResponse } from "./parser.js";
import { toGoogleAiModeQuery } from "./query.js";
import * as net from "node:net";

interface Args {
  query?: string;
  timeoutMs: number;
  showHelp: boolean;
  jsonMode: boolean;
  rawMode: boolean;
  useStdin: boolean;
  isStatus: boolean;
  /** Trailing tokens after `status` (we reject them as a usage error). */
  statusLeftover?: string;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.GOOGLE_AI_TIMEOUT_MS || 60000);

function showHelp(): void {
  process.stderr.write(
    [
      "anima-use-google-cli — direct host-mode CLI for Google AI Mode",
      "",
      "Searches Google AI Mode through your logged-in browser sidecar",
      "via the local native host on 127.0.0.1:51784 (no MCP subprocess).",
      "",
      "Usage:",
      "  anima-use-google-cli <query>",
      "  anima-use-google-cli --query <query> [--json|--raw] [--timeout-ms <ms>]",
      "  echo <query> | anima-use-google-cli --stdin [--json|--raw]",
      "  anima-use-google-cli status [--json|--raw]",
      "  anima-use-google-cli --help",
      "",
      "Query input:",
      "  <query>               Positional arg (multiple tokens joined with spaces).",
      "  --query <query>       Explicit query flag. Wins over --stdin when both given.",
      "  --stdin               Read query from piped (non-TTY) stdin; trims input.",
      "",
      "Output modes:",
      "  (default)             Parsed markdown answer to stdout; errors to stderr.",
      "  --json                Stable JSON: {\"ok\":true,\"markdown\":\"...\",\"citations\":[...]}",
      "                        on success, or {\"ok\":false,\"error\":\"...\"} on failure.",
      "                        Sole stdout content; nothing on stderr.",
      "  --raw                 Forward the verbatim host frame ({\"requestId\",ok,html,citations})",
      "                        to stdout. No parsing applied.",
      "  Precedence: if both --json and --raw are given, --raw wins.",
      "",
      "Status probe:",
      "  status                TCP reachability probe for the configured host:port.",
      "                        Prints {\"ok\":true,\"host\":<host>,\"port\":<port>,\"reachable\":true}",
      "                        on connect, or {\"ok\":false,..,\"reachable\":false} on failure.",
      "                        Never sends a search. --json/--raw are accepted but produce",
      "                        the same status schema.",
      "",
      "Options:",
      "  --timeout-ms <ms>     Per-request timeout in milliseconds (default 60000).",
      "  --timeout <ms>        Alias for --timeout-ms.",
      "  --help, -h            Show this help.",
      "",
      "Environment:",
      "  GOOGLE_AI_HOST_HOST       native host to connect to (default 127.0.0.1)",
      "  GOOGLE_AI_HOST_PORT       native host port (default 51784)",
      "  GOOGLE_AI_TIMEOUT_MS      default per-request timeout ms (default 60000)",
      "  GOOGLE_AI_BRIDGE_GRACE_MS post-timeout grace ms (default 30000); --timeout-ms overrides GOOGLE_AI_TIMEOUT_MS.",
      "",
      "Exit codes:",
      "  0  success",
      "  1  search/host error (including timeout)",
      "  2  usage error (bad args, empty query, --stdin on TTY)",
      "",
    ].join("\n")
  );
}

function showHelpAndExit(): never {
  showHelp();
  process.exit(0);
}

function failUsageAndExit(msg: string): never {
  process.stderr.write(
    `Error: ${msg}\n\nUsage: anima-use-google-cli <query> | --query <q> | --stdin | --help\n`
  );
  process.exit(2);
}

function showUsageError(msg: string): never {
  console.error(`Error: ${msg}`);
  console.error("");
  console.error(
    "Usage: anima-use-google-cli <query> | --query <q> | --stdin | --help"
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    query: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    showHelp: false,
    jsonMode: false,
    rawMode: false,
    useStdin: false,
    isStatus: false,
  };

  // Early check for --help / -h.
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      out.showHelp = true;
      return out;
    }
  }

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "status") {
      // `status` must be the first non-flag token.
      if (i !== 0) {
        showUsageError("`status` is a subcommand and must come first");
      }
      out.isStatus = true;
      // Only --json / --raw / --help allowed after status.
      i++;
      // Scan remaining tokens for leftover usage errors.
      while (i < argv.length) {
        const t = argv[i];
        if (t === "--json") { out.jsonMode = true; i++; }
        else if (t === "--raw") { out.rawMode = true; i++; }
        else if (t === "--help" || t === "-h") { out.showHelp = true; out.isStatus = false; return out; }
        else if (t.startsWith("--")) { showUsageError(`unknown option ${t} after status`); }
        else { out.statusLeftover = (out.statusLeftover ?? "") + (out.statusLeftover ? " " : "") + t; i++; }
      }
      return out;
    }

    if (arg === "--query") {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) {
        showUsageError("--query requires a value");
      }
      out.query = next;
    } else if (arg === "--timeout-ms" || arg === "--timeout") {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) {
        showUsageError(`${arg} requires a numeric value`);
      }
      const num = Number(next);
      if (!Number.isInteger(num) || num <= 0) {
        showUsageError(`${arg} requires a positive integer (got: ${JSON.stringify(next)})`);
      }
      out.timeoutMs = num;
    } else if (arg === "--stdin") {
      out.useStdin = true;
    } else if (arg === "--json") {
      out.jsonMode = true;
    } else if (arg === "--raw") {
      out.rawMode = true;
    } else if (arg.startsWith("--")) {
      showUsageError(`unknown option ${arg}`);
    } else {
      // Positional arg (query token).
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

class UsageError extends Error {}

async function readQueryFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UsageError("--stdin flag requires piped input (stdin is a TTY)");
  }

  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }

  const query = chunks.join("").trim();
  if (!query) {
    throw new UsageError("stdin input was empty (whitespace-only input is not a valid query)");
  }

  return query;
}

async function runStatusProbe(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port }, () => {
      sock.setTimeout(0); // clear the idle timer; defense-in-depth vs. native-messaging.ts clearTimeout convention
      sock.end();
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => {
      sock.destroy();
      resolve(false);
    });
    // Short safety timeout; the host should accept the connect immediately.
    sock.setTimeout(3000, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Parse and validate a TCP-port env var. Throws UsageError on bad input to
 * give a clean error rather than letting net.createConnection raise a
 * synchronous TypeError when env is non-numeric.
 */
function parsePortEnv(env: string | undefined, fallback: number): number {
  if (env === undefined) return fallback;
  const trimmed = env.trim();
  if (trimmed === "") return fallback;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new UsageError(
      `Invalid port: ${JSON.stringify(env)} — must be an integer in 1..65535`
    );
  }
  return n;
}

async function runStatus(): Promise<number> {
  const host = process.env.GOOGLE_AI_HOST_HOST || "127.0.0.1";
  const port = parsePortEnv(process.env.GOOGLE_AI_HOST_PORT, 51784);

  const reachable = await runStatusProbe(port, host);
  process.stdout.write(
    JSON.stringify({ ok: reachable, host, port, reachable }) + "\n"
  );
  return reachable ? 0 : 1;
}

interface HostFrame {
  requestId?: number;
  ok: boolean;
  error?: string;
  html?: string;
  // Matches parser.ts Citation[] shape.
  citations?: { marker_id: number; sources: { title: string; url: string; domain: string }[] }[];
}

async function runQuery(query: string, args: Args): Promise<number> {
  const timeoutMs = args.timeoutMs;
  const bridge = new NativeMessagingBridge();
  try {
    const transformed = toGoogleAiModeQuery(query);
    const resp = (await bridge.search(transformed, timeoutMs)) as HostFrame;

    // --raw: forward verbatim. Precedence over --json (documented).
    if (args.rawMode) {
      if (resp && resp.ok) {
        process.stdout.write(JSON.stringify(resp) + "\n");
        return 0;
      }
      const errorFrame = {
        requestId: typeof resp?.requestId === "number" ? resp.requestId : undefined,
        ok: false as const,
        error: resp?.error || "Connection to native host failed",
      };
      process.stdout.write(JSON.stringify(errorFrame) + "\n");
      return 1;
    }

    // --json: structured envelope.
    if (args.jsonMode) {
      if (!resp || !resp.ok) {
        process.stdout.write(
          JSON.stringify({
            ok: false,
            error: resp?.error || "Connection to native host failed",
          }) + "\n"
        );
        return 1;
      }
      const parsed = parseAiResponse(resp.html ?? "", resp.citations ?? []);
      if (!parsed.ok) {
        process.stdout.write(JSON.stringify({ ok: false, error: parsed.error }) + "\n");
        return 1;
      }
      process.stdout.write(
        JSON.stringify({
          ok: true,
          markdown: parsed.markdown,
          citations: resp.citations ?? [],
        }) + "\n"
      );
      return 0;
    }

    // Default mode: parsed markdown to stdout, errors to stderr.
    if (!resp || !resp.ok) {
      process.stderr.write((resp?.error || "Connection to native host failed") + "\n");
      return 1;
    }
    const parsed = parseAiResponse(resp.html ?? "", resp.citations ?? []);
    if (!parsed.ok) {
      process.stderr.write(parsed.error + "\n");
      return 1;
    }
    process.stdout.write(parsed.markdown);
    if (!parsed.markdown.endsWith("\n")) process.stdout.write("\n");
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (args.rawMode || args.jsonMode) {
      process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
    } else {
      process.stderr.write(message + "\n");
    }
    return 1;
  } finally {
    await bridge.dispose();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.showHelp) {
    showHelpAndExit();
  }

  if (args.isStatus) {
    if (args.statusLeftover !== undefined) {
      failUsageAndExit(`unexpected token after status: ${JSON.stringify(args.statusLeftover)}`);
    }
    const code = await runStatus();
    process.exit(code);
  }

  let query: string | undefined = args.query;

  try {
    // If --stdin was passed but we have no positional/--query, read stdin.
    // If --stdin was passed AND we have an explicit query, the explicit query
    // wins (documented in --help).
    if (query === undefined && args.useStdin) {
      query = await readQueryFromStdin();
    }

    // If no query at all and no --stdin requested, and stdin is not a TTY
    // (something was piped), treat stdin as an implicit query source. This
    // matches the prior CLI behavior.
    if (query === undefined && !args.useStdin && !process.stdin.isTTY) {
      query = await readQueryFromStdin();
    }
  } catch (err) {
    if (err instanceof UsageError) {
      failUsageAndExit(err.message);
    }
    throw err;
  }

  if (!query || !query.trim()) {
    failUsageAndExit(
      "query is required. Provide via positional arg, --query <q>, or --stdin"
    );
  }

  const code = await runQuery(query.trim(), args);
  process.exit(code);
}

/**
 * True if argv includes --json or --raw. Used in the outer catch so that
 * unexpected runtime errors are emitted in the same format the user
 * requested, rather than unstructured stderr.
 */
function argvWantsJson(): boolean {
  const argv = process.argv.slice(2);
  return argv.includes("--json") || argv.includes("--raw");
}

main().catch((err) => {
  if (err instanceof UsageError) {
    failUsageAndExit(err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  // Honor the user's requested output mode when emitting an unexpected error
  // (e.g., a stream error in readQueryFromStdin). UsageErrors are handled above
  // and always go to stderr.
  if (argvWantsJson()) {
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  } else {
    process.stderr.write(message + "\n");
  }
  process.exit(1);
});
