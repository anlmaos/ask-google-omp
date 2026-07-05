/**
 * Bridge to the native-messaging host.
 *
 * The MCP server does NOT spawn host.js directly: Firefox owns the host
 * process (it's started by Firefox on `runtime.connectNative`). Instead,
 * host.js also opens a localhost TCP listener, and this class connects to it
 * to send search requests and receive parsed responses.
 *
 * Framing on the localhost socket is the same 4-byte little-endian length
 * prefix + UTF-8 JSON used by native messaging, just carried over TCP.
 */

import * as net from "node:net";

const HOST_PORT = Number(process.env.GOOGLE_AI_HOST_PORT || 51784);
const HOST_HOST = process.env.GOOGLE_AI_HOST_HOST || "127.0.0.1";
const DEFAULT_TIMEOUT_MS = Number(process.env.GOOGLE_AI_TIMEOUT_MS || 60000);

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class NativeMessagingBridge {
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private buffer = Buffer.alloc(0);

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed && this.socket.writable) {
      return Promise.resolve(this.socket);
    }
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const sock = net.createConnection(
        { host: HOST_HOST, port: HOST_PORT },
        () => {
          this.socket = sock;
          this.connecting = null;
          resolve(sock);
        }
      );

      sock.on("data", (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.drain();
      });
      sock.on("error", (err) => {
        this.connecting = null;
        this.socket = null;
        this.failAll(err);
      });
      sock.on("close", () => {
        this.connecting = null;
        this.socket = null;
        this.failAll(new Error("Connection to native host closed"));
      });

      // A short connect timeout; the host may not be running yet.
      const connectTimer = setTimeout(() => {
        sock.destroy();
        this.connecting = null;
        reject(
          new Error(
            `Cannot reach native host at ${HOST_HOST}:${HOST_PORT}. Is Firefox running with the google-ai-search extension installed and connected?`
          )
        );
      }, 3000);
      sock.once("connect", () => clearTimeout(connectTimer));
    });

    return this.connecting;
  }

  private failAll(err: Error): void {
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pending.clear();
  }

  private drain(): void {
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) break;
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString("utf8"));
      } catch (err) {
        console.error(
          `[google-ai-search] bad JSON from host: ${
            err instanceof Error ? err.message : String(err)
          }`
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
    const pending = this.pending.get(m.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(m.requestId);
    pending.resolve(m);
  }

  async search(query: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const sock = await this.connect();

    const requestId = this.nextRequestId++;
    const payload = JSON.stringify({ requestId, query, timeoutMs });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(
            `Search timed out after ${timeoutMs}ms (no response from extension)`
          )
        );
      }, timeoutMs + 5000);

      this.pending.set(requestId, { resolve, reject, timer });

      const lengthBuf = Buffer.alloc(4);
      lengthBuf.writeUInt32LE(Buffer.byteLength(payload, "utf8"), 0);
      sock.write(lengthBuf);
      sock.write(Buffer.from(payload, "utf8"));
    });
  }

  async dispose(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.failAll(new Error("MCP bridge disposed"));
  }
}
