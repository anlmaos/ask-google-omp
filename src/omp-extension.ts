/**
 * oh-my-pi (omp) extension entrypoint.
 *
 * This is the primary front door for `ask_google`: omp loads this module as an
 * extension and calls the default export, which registers `ask_google` as a
 * model-callable tool via `pi.registerTool`.
 *
 * The transport is UNTOUCHED. The browser sidecar extension still drives Google
 * AI Mode in the user's own logged-in session, the browser-owned native host
 * (`native-host/host.js`) still owns the 127.0.0.1:51784 listener, and this
 * module is just another localhost TCP client on that same listener — it reuses
 * the very same `NativeMessagingBridge`, `parser.ts` and `query.ts` modules.
 * Nothing about the browser, the native host, or the scraping is plugin-specific.
 *
 * The `@oh-my-pi/pi-coding-agent` import is type-only and erased at build time:
 * this repo deliberately has no dependency on the omp packages, so the module
 * must also stay importable outside omp (tests, plain Node).
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { NativeMessagingBridge } from "./native-messaging.js";
import { parseAiResponse } from "./parser.js";
import { toGoogleAiModeQuery } from "./query.js";

/** Default per-request wait for the browser-side AI answer. */
const DEFAULT_SEARCH_TIMEOUT_MS = 60_000;

/**
 * Host frame carried back over the native-messaging bridge. On success `ok` is
 * true and `html` holds the raw Google AI Mode DOM plus its citation groups; on
 * failure `ok` is false and `error` says why.
 */
interface HostFrame {
 requestId?: number;
 ok: boolean;
 error?: string;
 html?: string;
 citations?: {
  marker_id: number;
  sources: { title: string; url: string; domain: string }[];
 }[];
}

/** Progress update emitted while the browser-side answer is pending. */
interface AskGoogleUpdate {
 content: { type: "text"; text: string }[];
 details: { phase: string; query: string };
}

/** Structured details attached to a successful tool result. */
interface AskGoogleDetails {
 query: string;
 citations: number;
}

/** Text tool result payload. */
interface AskGoogleToolResult {
 content: { type: "text"; text: string }[];
 details: AskGoogleDetails;
}

/**
 * Exactly one bridge per process, shared by every call. The model may issue
 * concurrent `ask_google` calls in a single batch; the bridge already
 * correlates replies by `requestId`, so a single instance is both correct and
 * cheap (one socket, one reconnect path).
 *
 * The bridge is created by the first `execute` call rather than at module load,
 * so a module-scope import never opens a socket or touches `process.env` eagerly.
 */
let bridge: NativeMessagingBridge | null = null;

function getBridge(pi: ExtensionAPI): NativeMessagingBridge {
 if (bridge) return bridge;
 bridge = new NativeMessagingBridge({
  log: (message, error) => {
   // Never `console.*`: this module is imported inside the omp TUI, where
   // stdout writes corrupt rendering. If no logger is wired, swallow.
   try {
    pi.logger?.warn(message, { err: String(error) });
   } catch {
    /* diagnostics are best-effort */
   }
  },
 });
 return bridge;
}

export default function askGoogleExtension(pi: ExtensionAPI): void {
 const z = pi.zod;

 pi.registerTool({
  name: "ask_google",
  label: "Ask Google",
  description:
   "Runs a Google AI Mode search through the user's own logged-in browser session " +
   "(no API key, grounded, free) and returns an AI-synthesized answer with inline " +
   "[1][2] citations plus a Sources section. Use for questions needing current, " +
   "well-sourced web facts. Requires the ask-google browser extension and its native host.",
  parameters: z.object({
   query: z.string().describe("The search query to ask Google AI Mode."),
   timeout_ms: z
    .number()
    .optional()
    .describe(
     "Per-request wait for the AI answer in milliseconds (default 60000).",
    ),
  }),
  // A Google AI Mode search only reads; no local state is mutated.
  approval: "read",
  async execute(
   toolCallId: string,
   params: { query: string; timeout_ms?: number },
   signal: AbortSignal | undefined,
   onUpdate: ((update: AskGoogleUpdate) => void) | undefined,
   ctx: unknown,
  ): Promise<AskGoogleToolResult> {
   onUpdate?.({
    content: [{ type: "text", text: "Waiting for Google AI Mode…" }],
    details: { phase: "search", query: params.query },
   });

   const finalQuery = toGoogleAiModeQuery(params.query);

   let frame: HostFrame;
   try {
    // `signal` is forwarded so an agent abort cancels the in-flight search.
    frame = (await getBridge(pi).search(
     finalQuery,
     params.timeout_ms ?? DEFAULT_SEARCH_TIMEOUT_MS,
     signal,
    )) as HostFrame;
   } catch (err) {
    // Unreachable host: preserve the bridge's descriptive error (it names
    // 127.0.0.1:51784 and Firefox) and append an actionable hint.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
     `${detail}\n\nHint: start Firefox with the ask-google extension loaded so ` +
     `native-host/host.js listens on 127.0.0.1:51784; see AGENTS.md ` +
     `("Switching Browser Sidecars For E2E Tests").`,
    );
   }

   if (!frame.ok) {
    throw new Error(frame.error || "Google AI Mode search failed.");
   }
   if (!frame.html) {
    throw new Error("No answer HTML was returned by Google AI Mode.");
   }

   const parsed = parseAiResponse(frame.html, frame.citations ?? []);
   if (!parsed.ok) {
    throw new Error(parsed.error);
   }

   return {
    content: [{ type: "text", text: parsed.markdown }],
    details: {
     query: params.query,
     citations: frame.citations?.length ?? 0,
    },
   };
  },
  onSession(event: { reason: string }): void {
   // Release the host socket when the omp session ends.
   if (event.reason === "shutdown") {
    void bridge?.dispose();
   }
  },
 });
}
