/**
 * End-to-end check of the ask_google path through the REAL native host
 * (dist/omp-extension.js + native-host/host.js).
 *
 * The browser normally owns `host.js` stdio via native messaging. Here a fake
 * extension replaces the browser: it connects to the host's TCP listener, reads
 * the framed request the tool sends, and answers with a realistic Google AI Mode
 * extraction. Nothing is mocked except the browser.
 *
 * This proves the whole chain the model sees: extension factory -> tool execute
 * -> NativeMessagingBridge framing -> host.js requestId correlation -> parser
 * markdown with citations embedded and Google UI chrome stripped.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { spawn } from "node:child_process";
import * as net from "node:net";

const ROOT = new URL("..", import.meta.url).pathname;

let e2ePort = -1;

async function captureTool() {
 // The bridge caches HOST_HOST/HOST_PORT at module load, so this override must
 // be in place before the extension module is first imported below.
 process.env.GOOGLE_AI_HOST_PORT = String(e2ePort);
 const mod = await import(new URL("../dist/omp-extension.js", import.meta.url));
 let tool = null;
 const pi = {
  zod: {
   object: (shape) => ({ kind: "object", shape }),
   string: () => ({ kind: "string", describe: () => "string?" }),
   number: () => ({
    kind: "number",
    optional: () => ({ kind: "number?", describe: () => "number?" }),
    describe: () => "number",
   }),
  },
  logger: { warn: () => { } },
  registerTool: (d) => {
   tool = d;
  },
 };
 mod.default(pi);
 return tool;
}

function sendFrame(sock, obj) {
 const payload = Buffer.from(JSON.stringify(obj), "utf8");
 const head = Buffer.alloc(4);
 head.writeUInt32LE(payload.length, 0);
 sock.write(Buffer.concat([head, payload]));
}

test("ask_google round-trips through the real native host into markdown", async () => {
 const html = readFileSync(
  new URL("./fixtures/ai-mode-main-col.html", import.meta.url),
  "utf8"
 );

 const server = net.createServer((client) => {
  let buf = Buffer.alloc(0);
  client.on("data", (chunk) => {
   buf = Buffer.concat([buf, chunk]);
   while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const payload = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    const msg = JSON.parse(payload.toString("utf8"));
    if (msg.requestId === undefined) continue;
    sendFrame(client, {
     requestId: msg.requestId,
     ok: true,
     html,
     citations: [
      {
       marker_id: 1,
       sources: [
        { title: "RK3576 overview", url: "https://example.com/ai-mode", domain: "example.com" },
       ],
      },
      {
       marker_id: 2,
       sources: [
        { title: "Grounding explained", url: "https://example.org/g", domain: "example.org" },
       ],
      },
     ],
    });
   }
  });
 });
 await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
 const port = server.address().port;
 e2ePort = port;

 const host = spawn("/usr/bin/node", [`${ROOT}native-host/host.js`], {
  env: {
   ...process.env,
   GOOGLE_AI_HOST_HOST: "127.0.0.1",
   GOOGLE_AI_HOST_PORT: String(port),
  },
  stdio: ["pipe", "pipe", "ignore"],
 });
 await new Promise((resolve) => setTimeout(resolve, 400));

 // Import the extension only now, with the port override already in place.
 const tool = await captureTool();
 try {
  const result = await tool.execute(
   "call-e2e",
   { query: "what is the rk3576" },
   undefined,
   undefined,
   {}
  );
  const text = result.content[0].text;
  assert.match(text, /RK3576 is a low-power quad-core SoC \[1\]/);
  assert.match(text, /## Sources/);
  assert.match(text, /\[1\] RK3576 overview/);
  assert.match(text, /example\.com\/ai-mode/);
  assert.doesNotMatch(text, /KI-Antworten/);
  assert.doesNotMatch(text, /About this result/);
  assert.deepEqual(result.details, {
   query: "what is the rk3576",
   citations: 2,
  });
 } finally {
  // Release the host socket, otherwise it keeps the test runner's event loop
  // alive after the assertions have already passed.
  await tool.onSession?.({ reason: "shutdown" });
  host.kill();
  server.close();
 }
});
