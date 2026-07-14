#!/usr/bin/env node
/**
 * Native messaging host for the anima-use-google Firefox extension.
 *
 * Lifecycle: Firefox spawns this process when the extension calls
 * `browser.runtime.connectNative("com.ask.google")`. We then:
 *
 *   1. Speak the native-messaging framing on stdin/stdout with Firefox
 *      (4-byte little-endian length prefix + UTF-8 JSON payload).
 *   2. Simultaneously run a localhost TCP server (default 127.0.0.1:51784)
 *      that the MCP server connects to. Requests from the MCP server are
 *      forwarded to the extension over the Firefox port; replies from the
 *      extension are forwarded back to the MCP server (and vice versa),
 *      correlated by `requestId`.
 *
 * A single Firefox port is held for the lifetime of this process. If the
 * extension disconnects, we exit and let Firefox respawn us on the next
 * connectNative.
 */

const HOST = process.env.GOOGLE_AI_HOST_HOST || "127.0.0.1";
const PORT = Number(process.env.GOOGLE_AI_HOST_PORT || 51784);

const skipDomains = new Set([
  "google.com",
  "google.de",
  "gstatic.com",
  "support.google.com",
]);

// --- native-messaging framing (stdin/stdout with Firefox) ------------------

let stdinBuffer = Buffer.alloc(0);
let firefoxPort = null; // we don't actually use node's port here; Firefox talks stdio

function writeToFirefox(obj) {
  if (process.stdout.destroyed) return;
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

// --- localhost TCP server (for the MCP server) -----------------------------

import * as net from "node:net";

const clients = new Set(); // net.Socket
const pendingByRequest = new Map(); // requestId -> { mcpClient }

function sendToClient(client, obj) {
  if (client.destroyed) return;
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  client.write(Buffer.concat([header, json]));
}

function broadcastToMcpClients(obj) {
  for (const c of clients) sendToClient(c, obj);
}

const server = net.createServer((client) => {
  clients.add(client);
  let buf = Buffer.alloc(0);

  client.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const length = buf.readUInt32LE(0);
      if (buf.length < 4 + length) break;
      const payload = buf.subarray(4, 4 + length);
      buf = buf.subarray(4 + length);
      let msg;
      try {
        msg = JSON.parse(payload.toString("utf8"));
      } catch {
        sendToClient(client, {
          requestId: null,
          ok: false,
          error: "invalid JSON from MCP server",
        });
        continue;
      }
      // Forward to Firefox extension.
      pendingByRequest.set(msg.requestId, { mcpClient: client });
      writeToFirefox(msg);
    }
  });

  client.on("error", () => clients.delete(client));
  client.on("close", () => clients.delete(client));
});

server.on("error", (err) => {
  console.error(`[ask-google host] TCP server error: ${err.message}`);
});
server.listen(PORT, HOST, () => {
  console.error(
    `[ask-google host] listening on ${HOST}:${PORT} (Firefox native host ready)`
  );
});

// --- Firefox native-messaging stdin ---------------------------------------

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  while (stdinBuffer.length >= 4) {
    const length = stdinBuffer.readUInt32LE(0);
    if (stdinBuffer.length < 4 + length) break;
    const payload = stdinBuffer.subarray(4, 4 + length);
    stdinBuffer = stdinBuffer.subarray(4 + length);
    let msg;
    try {
      msg = JSON.parse(payload.toString("utf8"));
    } catch {
      continue;
    }
    // The extension sends back { requestId, ok, markdown?, error? }.
    // Forward to whichever MCP client is waiting on this requestId.
    const pending = pendingByRequest.get(msg.requestId);
    if (pending) {
      pendingByRequest.delete(msg.requestId);
      sendToClient(pending.mcpClient, msg);
    } else {
      // No MCP client waiting (e.g. extension-initiated message) - broadcast.
      broadcastToMcpClients(msg);
    }
  }
});

process.stdin.on("end", () => {
  // Firefox closed the port; exit so Firefox can respawn us next time.
  server.close();
  process.exit(0);
});

process.stdin.on("error", () => process.exit(0));
process.stdout.on("error", () => process.exit(0));

// Silence uncaught throws.
process.on("uncaughtException", (err) => {
  console.error(`[ask-google host] uncaught: ${err && err.message}`);
});
