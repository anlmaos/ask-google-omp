/**
 * Bridge to the native-messaging host.
 *
 * This class is shared by every Node-side front door: the direct-host CLI
 * (`src/cli.ts`) and the oh-my-pi extension (`src/omp-extension.ts`).
 *
 * None of them spawn host.js directly: the browser owns that process (it is
 * started on `runtime.connectNative`). Instead, host.js also opens a localhost
 * TCP listener, and this class connects to it to send search requests and
 * receive parsed responses.
 *
 * Framing on the localhost socket is the same 4-byte little-endian length
 * prefix + UTF-8 JSON used by native messaging, just carried over TCP.
 *
 * Because this module is imported both by standalone processes and in-process
 * by hosts with their own I/O surfaces (the omp TUI), it never writes to
 * `console.*` — diagnostics go through an optional injected sink.
 */

import * as net from "node:net";

const HOST_PORT = Number(process.env.GOOGLE_AI_HOST_PORT || 51784);
const HOST_HOST = process.env.GOOGLE_AI_HOST_HOST || "127.0.0.1";
const DEFAULT_TIMEOUT_MS = Number(process.env.GOOGLE_AI_TIMEOUT_MS || 60000);
const BRIDGE_RESPONSE_GRACE_MS = Number(
 process.env.GOOGLE_AI_BRIDGE_GRACE_MS || 30000
);

interface PendingRequest {
 resolve: (payload: unknown) => void;
 reject: (err: Error) => void;
 timer: NodeJS.Timeout;
}

export interface NativeMessagingBridgeOptions {
 /** Diagnostic sink for malformed host frames. Defaults to swallowing, because this
  *  module now also runs IN-PROCESS inside the omp TUI where stdout logging corrupts rendering. */
 log?: (message: string, error?: unknown) => void;
}

const CANCELLED_MESSAGE = "Search was cancelled";

/** Cancellation errors carry `signal.reason` when it is a real Error or a
 *  non-empty string; otherwise fall back to the fixed message. */
function cancellationMessage(reason: unknown, fallback: string): string {
 if (reason instanceof Error) return reason.message;
 if (typeof reason === "string" && reason.trim().length > 0) return reason;
 return fallback;
}

export class NativeMessagingBridge {
 #socket: net.Socket | null = null;
 #connecting: Promise<net.Socket> | null = null;
 #pending = new Map<number, PendingRequest>();
 #nextRequestId = 1;
 #buffer = Buffer.alloc(0);
 #log: ((message: string, error?: unknown) => void) | undefined;

 constructor(options?: NativeMessagingBridgeOptions) {
  this.#log = options?.log;
 }

 private connect(): Promise<net.Socket> {
  if (this.#socket && !this.#socket.destroyed && this.#socket.writable) {
   return Promise.resolve(this.#socket);
  }
  if (this.#connecting) return this.#connecting;

  this.#connecting = new Promise((resolve, reject) => {
   const sock = net.createConnection(
    { host: HOST_HOST, port: HOST_PORT },
    () => {
     this.#socket = sock;
     this.#connecting = null;
     resolve(sock);
    }
   );

   sock.on("data", (chunk: Buffer) => {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    this.drain();
   });
   sock.on("error", (err) => {
    this.#connecting = null;
    this.#socket = null;
    this.failAll(err);
   });
   sock.on("close", () => {
    this.#connecting = null;
    this.#socket = null;
    this.failAll(new Error("Connection to native host closed"));
   });

   // A short connect timeout; the host may not be running yet.
   const connectTimer = setTimeout(() => {
    sock.destroy();
    this.#connecting = null;
    reject(
     new Error(
      `Cannot reach native host at ${HOST_HOST}:${HOST_PORT}. Is Firefox running with the ask-google extension installed and connected?`
     )
    );
   }, 3000);
   sock.once("connect", () => clearTimeout(connectTimer));
  });

  return this.#connecting;
 }

 private failAll(err: Error): void {
  for (const [, req] of this.#pending) {
   clearTimeout(req.timer);
   req.reject(err);
  }
  this.#pending.clear();
 }

 private drain(): void {
  while (this.#buffer.length >= 4) {
   const length = this.#buffer.readUInt32LE(0);
   if (this.#buffer.length < 4 + length) break;
   const payload = this.#buffer.subarray(4, 4 + length);
   this.#buffer = this.#buffer.subarray(4 + length);
   let parsed: unknown;
   try {
    parsed = JSON.parse(payload.toString("utf8"));
   } catch (err) {
    this.#log?.(
     `[ask-google] bad JSON from host: ${err instanceof Error ? err.message : String(err)
     }`,
     err
    );
    continue;
   }
   this.dispatch(parsed);
  }
 }

 private dispatch(msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as { requestId?: number };
  if (typeof m.requestId !== "number") return;
  const pending = this.#pending.get(m.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  this.#pending.delete(m.requestId);
  pending.resolve(m);
 }

 async search(
  query: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal
 ): Promise<unknown> {
  if (signal?.aborted) {
   throw new Error(
    cancellationMessage(
     signal.reason,
     "Search was cancelled before it started"
    )
   );
  }

  const sock = await this.connect();

  const requestId = this.#nextRequestId++;
  const payload = JSON.stringify({ requestId, query, timeoutMs });

  // Executor form is deliberate: the pending map must hold the wrapped
  // resolvers so every settle path (dispatch, failAll, timeout, abort)
  // funnels through one cleanup routine. Promise.withResolvers is Node 22+
  // while the declared engine floor is Node >=20.
  return new Promise((resolve, reject) => {
   let settled = false;
   let onAbort: (() => void) | null = null;

   const finish = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (onAbort && signal) {
     signal.removeEventListener("abort", onAbort);
    }
    onAbort = null;
   };

   const timer = setTimeout(() => {
    this.#pending.delete(requestId);
    finish();
    reject(
     new Error(
      `Search timed out after ${timeoutMs}ms (no response from extension)`
     )
    );
   }, timeoutMs + BRIDGE_RESPONSE_GRACE_MS);

   this.#pending.set(requestId, {
    resolve: (m) => {
     finish();
     resolve(m);
    },
    reject: (err) => {
     finish();
     this.#pending.delete(requestId);
     reject(err);
    },
    timer,
   });

   if (signal) {
    onAbort = () => {
     this.#pending.delete(requestId);
     finish();
     reject(
      new Error(cancellationMessage(signal.reason, CANCELLED_MESSAGE))
     );
    };
    signal.addEventListener("abort", onAbort, { once: true });
   }

   const lengthBuf = Buffer.alloc(4);
   lengthBuf.writeUInt32LE(Buffer.byteLength(payload, "utf8"), 0);
   sock.write(lengthBuf);
   sock.write(Buffer.from(payload, "utf8"));
  });
 }

 async dispose(): Promise<void> {
  if (this.#socket) {
   this.#socket.destroy();
   this.#socket = null;
  }
  this.failAll(new Error("Bridge disposed"));
 }
}
