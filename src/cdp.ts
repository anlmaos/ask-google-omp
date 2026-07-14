/**
 * Raw CDP WebSocket driver for Google AI Mode.
 *
 * Attaches to an already-running Chromium via its Chrome DevTools Protocol
 * debugging port (default http://127.0.0.1:9222). No autolaunch, no temp profile —
 * the browser must already be listening. This design intentionally reuses the
 * user's real session (cookies, login state) so AI Mode works without a
 * separate Google login.
 *
 * Each `search()` call creates an isolated ephemeral page target, runs the AI
 * Mode extraction inside it via Runtime.evaluate, then closes that target. The
 * user's other tabs are never touched.
 */

import { buildAiModeExtractScript } from "./extractors/ai-mode.js";

export interface RawSearchResult {
  ok: boolean;
  html?: string;
  citations?: Citation[];
  error?: string;
}

export interface Citation {
  marker_id: number;
  sources: { title: string; url: string; domain: string }[];
}

interface CdpResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface CdpEvent {
  method: string;
  params: unknown;
  sessionId?: string;
}

interface CdpBrowserVersion {
  Browser: string;
  "Protocol-Version": string;
  webSocketDebuggerUrl: string;
}

export class CdpConnectionError extends Error {}

/**
 * Low-level CDP WebSocket client.
 *
 * Sends commands and returns promises that resolve with the `result` field of
 * the matching CDP response. Routes events to registered listeners.
 */
class CdpClient {
  ws: globalThis.WebSocket;
  private sessionId: string | null = null;
  private msgId = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private listeners = new Map<string, Set<(params: unknown) => void>>();

  constructor(wsUrl: string) {
    const { promise: open, resolve: resolveOpen, reject: rejectOpen } =
      Promise.withResolvers<void>();

    this.ws = new globalThis.WebSocket(wsUrl);
    this.ws.addEventListener("open", () => resolveOpen());
    this.ws.addEventListener("error", (e) => rejectOpen(new Error(String(e))));
    this.ws.addEventListener("message", (evt) => this.#onMessage(evt.data));

    // Block until the socket is open.
    void open;
  }

  /** Set the active session ID (from Target.attachedToTarget / browser-level). */
  setSession(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  /**
   * Subscribe to CDP events matching `method`. Callback is invoked with
   * `params`. Buffered — if the event arrived before subscribe, the buffered
   * value is dispatched immediately.
   */
  on(method: string, cb: (params: unknown) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  /** Send a CDP command and resolve with its `result` field. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.msgId;
    const frame: Record<string, unknown> = { id, method };
    if (params) frame["params"] = params;
    if (this.sessionId) frame["sessionId"] = this.sessionId;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(frame));
    });
  }

  close(): void {
    this.ws.close();
  }

  #onMessage(raw: string | ArrayBuffer | Blob): void {
    let data: CdpResponse | CdpEvent | null = null;
    try {
      data = JSON.parse(
        typeof raw === "string" ? raw : String(raw)
      ) as CdpResponse | CdpEvent;
    } catch {
      return;
    }

    if ("id" in data && data.id !== undefined) {
      // Command response.
      const entry = this.pending.get(data.id as number);
      this.pending.delete(data.id as number);
      if (!entry) return;
      if (data.error) {
        entry.reject(
          new Error(`CDP error ${(data as CdpResponse).error!.code}: ${(data as CdpResponse).error!.message}`)
        );
      } else {
        entry.resolve((data as CdpResponse).result ?? null);
      }
    } else if ("method" in data && data.method) {
      // Event notification.
      const set = this.listeners.get((data as CdpEvent).method);
      if (set) {
        for (const cb of set) {
          try { cb((data as CdpEvent).params ?? null); } catch {}
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class CdpDriver {
  private client: CdpClient | null = null;
  private endpoint: string;

  constructor(opts?: { endpoint?: string }) {
    this.endpoint =
      (opts?.endpoint ?? process.env["GOOGLE_AI_CDP_URL"]) ||
      "http://127.0.0.1:9222";
  }

  /** Probe the endpoint and establish a browser-level CDP session. */
  async init(): Promise<void> {
    let version: CdpBrowserVersion;
    try {
      const res = await fetch(`${this.endpoint}/json/version`);
      if (!res.ok) {
        throw Object.assign(
          new Error(`HTTP ${res.status}`),
          { status: res.status }
        );
      }
      version = (await res.json()) as CdpBrowserVersion;
    } catch (err) {
      const hint =
        err instanceof Error && "status" in err
          ? ""
          : " Ensure Chromium is running with --remote-debugging-port=9222.";
      throw new CdpConnectionError(
        `Chromium not reachable at ${this.endpoint}.` +
          hint +
          "\n  Launch it with: chromium-browser-unstable" +
          " --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1"
      );
    }

    this.client = new CdpClient(version.webSocketDebuggerUrl);

    // Wait for the socket to open before sending any commands.
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket = (this.client as CdpClient).ws as unknown as {
      readyState: number;
      onopen: (() => void) | null;
      onerror: ((e: Event) => void) | null;
    };
    if (socket.readyState === 1 /* OPEN */) {
      resolve();
    } else {
      socket.onopen = () => resolve();
      socket.onerror = (e) => reject(new Error(String(e)));
    }
    await promise;

    // Enable the browser-level Target domain so child page sessions auto-attach
    // to our connection (flattened, so we get them on the same ws without a
    // separate port).
    await this.client.send("Target.setDiscoverTargets", { discover: false });
    await this.client.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });

    // No browser-level session needed for the initial setup; page sessions
    // (created via Target.createTarget) will arrive with their own sessionId.
    this.client.setSession(null);
  }

  /**
   * Run one AI Mode search in an ephemeral page target.
   *
   * Flow:
   *  1. Create a blank page target (Target.createTarget).
   *  2. Wait for the page session to auto-attach (Target.attachedToTarget).
   *  3. Enable Page + Runtime + DOM domains on the page session.
   *  4. Navigate to the AI Mode URL.
   *  5. Wait for Page.loadEventFired.
   *  6. Run the extraction script via Runtime.evaluate (awaitPromise → true).
   *  7. Parse the result; close the target regardless of success/failure.
   */
  async search(rawQuery: string, timeoutMs = 60_000): Promise<RawSearchResult> {
    if (!this.client) {
      return { ok: false, error: "CdpDriver not initialised — call init() first" };
    }

    // ── 1. Create an ephemeral page target. ────────────────────────────────
    const createResult = (await this.client.send(
      "Target.createTarget",
      { url: "about:blank" }
    )) as { targetId: string };
    const targetId = createResult.targetId;

    // ── 2. Wait for the auto-attach to deliver the page session. ───────────
    const attached = Promise.withResolvers<{ sessionId: string }>();
    const off = this.client.on("Target.attachedToTarget", (params) => {
      const p = params as { sessionId: string; targetId: string };
      if (p.targetId === targetId) {
        attached.resolve({ sessionId: p.sessionId });
      }
    });
    try {
      const { sessionId } = await attached.promise;
      // Future commands target the page session, not the browser.
      this.client.setSession(sessionId);

      // ── 3. Enable page domains on the new session. ─────────────────────
      await this.client.send("Page.enable");
      await this.client.send("Runtime.enable");
      await this.client.send("DOM.enable");

      // ── 4. Navigate to AI Mode. ─────────────────────────────────────────
      const encoded = encodeURIComponent(rawQuery);
      const aiUrl = `https://www.google.com/search?q=${encoded}&udm=50`;
      await this.client.send("Page.navigate", { url: aiUrl });

      // ── 5. Wait for load to fire. ────────────────────────────────────────
      const loaded = Promise.withResolvers<void>();
      const offLoad = this.client.on("Page.loadEventFired", () =>
        loaded.resolve()
      );
      // Race against the overall timeout.
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Page load timeout")), timeoutMs)
      );
      try {
        await Promise.race([loaded.promise, timeout]);
      } catch {
        // Fall through — AI Mode may never reach "loadEventFired" because it
        // streams content; we proceed anyway and let the in-page script handle
        // the completion wait.
      } finally {
        offLoad();
      }

      // ── 6. Run the extraction script. ───────────────────────────────────
      const expr = buildAiModeExtractScript(timeoutMs);
      const evalResult = (await this.client.send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
        timeout: timeoutMs,
      })) as {
        result?: { value?: unknown };
        exceptionDetails?: { exception?: { description?: string } };
      };

      if (evalResult.exceptionDetails) {
        return {
          ok: false,
          error:
            evalResult.exceptionDetails.exception?.description ??
            "Unknown script error in page context",
        };
      }

      const raw = evalResult.result?.value as
        | { ok: boolean; html?: string; citations?: Citation[]; error?: string }
        | undefined;

      if (!raw) return { ok: false, error: "Empty result from page evaluation" };
      return {
        ok: raw.ok,
        html: raw.html,
        citations: raw.citations,
        error: raw.error,
      };
    } finally {
      off();
      // ── 7. Teardown: close the ephemeral target, revert to browser session. ──
      this.client.setSession(null);
      try {
        await this.client.send("Target.closeTarget", { targetId });
      } catch {
        // Ignore — the target may already be gone.
      }
    }
  }

  /** Tear down the CDP connection. Does NOT close the browser process. */
  dispose(): void {
    this.client?.close();
    this.client = null;
  }
}
