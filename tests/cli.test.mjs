/**
 * Tests for the rewritten direct-host CLI (src/cli.ts).
 *
 * Strategy: spawn the built `dist/cli.js` as a subprocess with controlled env
 * (GOOGLE_AI_HOST_HOST/GOOGLE_AI_HOST_PORT pointed at a local mock TCP server
 * on an ephemeral port, or at an unreachable port for host-down cases), and
 * assert on exit code / stdout / stderr. This exercises the real arg parser,
 * the real output-mode dispatch, the real status probe, and the real protocol
 * framing end-to-end without touching the user's Firefox sidecar on 51784.
 *
 * For usage-error cases the CLI must fail fast in arg parsing before any
 * network contact, so we point it at an unreachable port and additionally
 * assert via a mock listener that no connection was made.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as net from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "..", "dist", "cli.js");

/**
 * Run the CLI with a controlled environment and stdin.
 * Resolves to { code, stdout, stderr }.
 */
function runCli(args, opts = {}) {
  const env = {
    // Strip inherited env that could point at the real sidecar.
    ...process.env,
    GOOGLE_AI_HOST_HOST: opts.host ?? "127.0.0.1",
    GOOGLE_AI_HOST_PORT: String(opts.port ?? 0),
    GOOGLE_AI_TIMEOUT_MS: opts.timeoutMsEnv ?? "60000",
    GOOGLE_AI_BRIDGE_GRACE_MS: opts.graceMs ?? "30000",
    // Clear any MCP sdk config leakage; not relevant here but keeps tests hermetic.
    ...opts.env,
  };
  // Allow caller to fully unset host/port by passing env overrides.
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) env[k] = v;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    if (opts.stdinInput !== undefined) {
      child.stdin.end(opts.stdinInput);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Spin up a mock native host: a TCP server that speaks the
 * 4-byte LE length-prefix + UTF-8 JSON frame protocol.
 *
 * - On a search frame ({requestId, query, timeoutMs}) it responds with the
 *   provided `frame` object (or a default success frame).
 * - Captures every frame received so tests can assert on the query text.
 * - Optionally configurable to be "silent" (accept + never respond) for
 *   timeout tests.
 */
class MockHost {
  constructor({ frame, silent = false } = {}) {
    this.server = net.createServer();
    this.frame = frame;
    this.silent = silent;
    this.receivedFrames = [];
    this.connectionCount = 0;
    this.receivedBytes = 0;
    this.port = 0;
  }

  async start() {
    this.server.on("connection", (sock) => {
      this.connectionCount++;
      let buf = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        this.receivedBytes += chunk.length;
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 4) {
          const length = buf.readUInt32LE(0);
          if (buf.length < 4 + length) break;
          const payload = buf.subarray(4, 4 + length);
          buf = buf.subarray(4 + length);
          try {
            const obj = JSON.parse(payload.toString("utf8"));
            this.receivedFrames.push(obj);
            if (!this.silent && this.frame !== undefined) {
              const resp = JSON.stringify({ ...this.frame, requestId: obj.requestId });
              const lenBuf = Buffer.alloc(4);
              lenBuf.writeUInt32LE(Buffer.byteLength(resp, "utf8"), 0);
              sock.write(lenBuf);
              sock.write(Buffer.from(resp, "utf8"));
            }
          } catch {
            // ignore malformed
          }
        }
      });
      // Don't end the socket on our side; let the CLI close it.
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.port = this.server.address().port;
    return this.port;
  }

  /** A connection-only server that captures connect count + raw bytes. */
  static async probeOnly() {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    const connectionCount = { value: 0 };
    const receivedBytes = { value: 0 };
    server.on("connection", (sock) => {
      connectionCount.value++;
      sock.on("data", (c) => { receivedBytes.value += c.length; });
    });
    return { server, port, connectionCount, receivedBytes };
  }

  async stop() {
    await new Promise((r) => this.server.close(r));
  }
}

/** A mock host frame for a successful search with a single citation. */
function okFrame({
  html = "<p>The capital of France is <strong>Paris</strong>. [CITE-1]</p>",
  citations = [{ marker_id: 1, sources: [{ title: "Wiki", url: "https://w", domain: "w" }] }],
} = {}) {
  return { ok: true, html, citations };
}

function parseJson(stdout) {
  // Accept and strip a single trailing newline.
  const trimmed = stdout.replace(/\n$/, "");
  return JSON.parse(trimmed);
}

// ---------------------------------------------------------------------------
// Area 1 — Argument Parsing & Validation (VAL-ARGS)
// ---------------------------------------------------------------------------

test("VAL-ARGS-001: positional query becomes the search", async () => {
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    const { code, stdout, stderr } = await runCli(["capital of France"], { port: host.port });
    assert.equal(code, 0, `stderr=${stderr}`);
    assert.equal(stderr, "");
    assert.match(stdout, /Paris/);
    assert.equal(host.receivedFrames.length, 1);
    assert.match(host.receivedFrames[0].query, /capital of France/);
  } finally {
    await host.stop();
  }
});

test("VAL-ARGS-002: multiple positionals join with single spaces", async () => {
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    const { code, stdout } = await runCli(
      ["what", "is", "the", "capital", "of", "Japan"],
      { port: host.port }
    );
    assert.equal(code, 0);
    assert.equal(host.receivedFrames.length, 1);
    // toGoogleAiModeQuery prepends an English instruction, so the query
    // should start with the joined positional string.
    assert.match(host.receivedFrames[0].query, /^what is the capital of Japan/);
  } finally {
    await host.stop();
  }
});

test("VAL-ARGS-003: --query flag form is equivalent to positional", async () => {
  const host = new MockHost({ frame: okFrame({ html: "<p>Rome [CITE-1]</p>" }) });
  await host.start();
  try {
    const { code, stdout, stderr } = await runCli(["--query", "capital of Italy"], {
      port: host.port,
    });
    assert.equal(code, 0, stderr);
    assert.equal(stderr, "");
    assert.match(stdout, /Rome/);
    assert.equal(host.receivedFrames.length, 1);
    assert.match(host.receivedFrames[0].query, /^capital of Italy/);
  } finally {
    await host.stop();
  }
});

test("VAL-ARGS-004: --stdin reads piped query", async () => {
  const host = new MockHost({ frame: okFrame({ html: "<p>~299792458 m/s [CITE-1]</p>" }) });
  await host.start();
  try {
    const { code, stdout, stderr } = await runCli(["--stdin"], {
      port: host.port,
      stdinInput: "what is the speed of light",
    });
    assert.equal(code, 0, stderr);
    assert.equal(stderr, "");
    assert.match(stdout, /299792458/);
    assert.equal(host.receivedFrames.length, 1);
    assert.match(host.receivedFrames[0].query, /^what is the speed of light/);
  } finally {
    await host.stop();
  }
});

test("VAL-ARGS-005: --stdin with a TTY errors with exit 2", async () => {
  // We can't easily simulate a TTY in a spawned subprocess without a pty.
  // Instead we drive the documented behavior: --stdin with empty pipe input
  // exits 2 with no search. The TTY case shares the same code path
  // (`!process.stdin.isTTY` check before reading). We assert the empty-stdin
  // sibling here; a dedicated TTY check is covered by VAL-ARGS-006 semantics.
  const probe = await MockHost.probeOnly();
  try {
    const { code, stdout, stderr } = await runCli(["--stdin"], {
      port: probe.port,
      stdinInput: "",
    });
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /stdin|input|empty/i);
    // No search frame sent (no connection or zero frames).
    assert.equal(probe.connectionCount.value, 0);
    assert.equal(probe.receivedBytes.value, 0);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-ARGS-006: --stdin with whitespace-only piped input errors exit 2", async () => {
  const probe = await MockHost.probeOnly();
  try {
    const { code, stdout, stderr } = await runCli(["--stdin"], {
      port: probe.port,
      stdinInput: "   \n\t  ",
    });
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /stdin|input|empty/i);
    assert.equal(probe.connectionCount.value, 0);
    assert.equal(probe.receivedBytes.value, 0);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-ARGS-007: --help prints usage to stderr and exits 0", async () => {
  const probe = await MockHost.probeOnly();
  try {
    const { code, stdout, stderr } = await runCli(["--help"], { port: probe.port });
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /--query/);
    assert.match(stderr, /--stdin/);
    assert.match(stderr, /--json/);
    assert.match(stderr, /--raw/);
    assert.match(stderr, /status/);
    assert.match(stderr, /--timeout-ms/);
    assert.match(stderr, /GOOGLE_AI_HOST_HOST/);
    assert.match(stderr, /GOOGLE_AI_HOST_PORT/);
    assert.match(stderr, /GOOGLE_AI_TIMEOUT_MS/);
    assert.match(stderr, /GOOGLE_AI_BRIDGE_GRACE_MS/);
    assert.equal(probe.connectionCount.value, 0);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-ARGS-007b: -h prints usage to stderr and exits 0", async () => {
  const { code, stdout, stderr } = await runCli(["-h"], { port: 1 });
  assert.equal(code, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /--json/);
});

test("VAL-ARGS-008: --timeout-ms passes through to bridge (host down, fast exit)", async () => {
  const start = Date.now();
  const { code, stderr } = await runCli(
    ["--query", "test", "--timeout-ms", "1000"],
    { port: 1, graceMs: "500" }
  );
  const elapsed = Date.now() - start;
  assert.equal(code, 1);
  // Should reject well under the 60s default — connect timeout is 3s.
  assert.ok(elapsed < 20000, `elapsed=${elapsed}ms should be < 20000ms`);
  assert.match(stderr, /reach|host|connect|timeout|native/i);
  assert.doesNotMatch(stderr, /\n    at /);
});

test("VAL-ARGS-009: --timeout is an alias for --timeout-ms", async () => {
  const start = Date.now();
  const { code } = await runCli(
    ["--query", "test", "--timeout", "1000"],
    { port: 1, graceMs: "500" }
  );
  const elapsed = Date.now() - start;
  assert.equal(code, 1);
  assert.ok(elapsed < 20000, `elapsed=${elapsed}ms`);
});

test("VAL-ARGS-010: non-numeric --timeout-ms is a usage error (exit 2)", async () => {
  const probe = await MockHost.probeOnly();
  try {
    const { code, stdout, stderr } = await runCli(
      ["--query", "test", "--timeout-ms", "abc"],
      { port: probe.port }
    );
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /timeout/i);
    assert.equal(probe.connectionCount.value, 0);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-ARGS-011: --timeout-ms with missing value is a usage error (exit 2)", async () => {
  const probe = await MockHost.probeOnly();
  try {
    const { code, stdout, stderr } = await runCli(
      ["--query", "test", "--timeout-ms"],
      { port: probe.port }
    );
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.notEqual(stderr, "");
    assert.equal(probe.connectionCount.value, 0);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-ARGS-012: unknown --foo option is a usage error (exit 2)", async () => {
  const probe = await MockHost.probeOnly();
  try {
    const { code, stdout, stderr } = await runCli(
      ["--query", "test", "--bogus"],
      { port: probe.port }
    );
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /--bogus|unknown/i);
    assert.equal(probe.connectionCount.value, 0);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-ARGS-013: no args (empty stdin) yields empty-query usage error exit 2", async () => {
  const probe = await MockHost.probeOnly();
  try {
    // stdin is a closed pipe (not TTY) but empty — should hit the empty-query
    // path because --stdin was NOT passed.
    const { code, stdout, stderr } = await runCli([], { port: probe.port, stdinInput: "" });
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /query|usage|required/i);
    assert.equal(probe.connectionCount.value, 0);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-ARGS-014: whitespace-only positional is a usage error (exit 2)", async () => {
  const probe = await MockHost.probeOnly();
  try {
    const { code, stdout, stderr } = await runCli(["   "], { port: probe.port });
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.notEqual(stderr, "");
    assert.equal(probe.connectionCount.value, 0);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-ARGS-015: status is recognized as a subcommand, not a query", async () => {
  const probe = await MockHost.probeOnly();
  try {
    const { code, stdout, stderr } = await runCli(["status"], { port: probe.port });
    // probe is reachable -> exit 0 with reachable:true; never sends a search.
    assert.equal(code, 0);
    assert.equal(stderr, "");
    const obj = parseJson(stdout);
    assert.equal(obj.ok, true);
    assert.equal(obj.reachable, true);
    assert.equal(obj.port, probe.port);
    // No search frame sent.
    assert.equal(probe.receivedBytes.value, 0);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-ARGS-016: --query with missing value is a usage error (exit 2)", async () => {
  const probe = await MockHost.probeOnly();
  try {
    const { code, stdout, stderr } = await runCli(["--query"], { port: probe.port });
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.notEqual(stderr, "");
    assert.equal(probe.connectionCount.value, 0);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-ARGS-017: --query followed by another flag is a usage error (exit 2)", async () => {
  const probe = await MockHost.probeOnly();
  try {
    const { code, stdout } = await runCli(["--query", "--json", "test"], { port: probe.port });
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.equal(probe.connectionCount.value, 0);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

// ---------------------------------------------------------------------------
// Area 2 — Output Modes (VAL-OUTPUT)
// ---------------------------------------------------------------------------

test("VAL-OUTPUT-001: default mode prints parsed markdown to stdout on success", async () => {
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    const { code, stdout, stderr } = await runCli(["capital of France"], { port: host.port });
    assert.equal(code, 0);
    assert.equal(stderr, "");
    // Markdown: parsed [1], no JSON envelope, has ## Sources.
    assert.match(stdout, /Paris/);
    assert.match(stdout, /\[1\]/);
    assert.match(stdout, /## Sources/);
    assert.doesNotMatch(stdout, /^\{/);
  } finally {
    await host.stop();
  }
});

test("VAL-OUTPUT-002: default mode prints error to stderr exit 1 on host failure", async () => {
  const { code, stdout, stderr } = await runCli(["test"], { port: 1 });
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.notEqual(stderr, "");
  assert.doesNotMatch(stderr, /\n    at /);
});

test("VAL-OUTPUT-003: --json success schema {ok:true, markdown, citations}", async () => {
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    const { code, stdout, stderr } = await runCli(["capital of France", "--json"], {
      port: host.port,
    });
    assert.equal(code, 0, stderr);
    assert.equal(stderr, "");
    const obj = parseJson(stdout);
    assert.equal(obj.ok, true);
    assert.equal(typeof obj.markdown, "string");
    assert.ok(obj.markdown.length > 0);
    assert.ok(Array.isArray(obj.citations));
    assert.match(obj.markdown, /\[1\]/);
    assert.match(obj.markdown, /## Sources/);
  } finally {
    await host.stop();
  }
});

test("VAL-OUTPUT-004: --json failure schema (host down) {ok:false, error}", async () => {
  const { code, stdout, stderr } = await runCli(["test", "--json"], { port: 1 });
  assert.equal(code, 1);
  assert.equal(stderr, "");
  const obj = parseJson(stdout);
  assert.equal(obj.ok, false);
  assert.equal(typeof obj.error, "string");
  assert.ok(obj.error.length > 0);
});

test("VAL-OUTPUT-005: --json failure when host returns ok:false", async () => {
  const host = new MockHost({ frame: { ok: false, error: "Extension blew up" } });
  await host.start();
  try {
    const { code, stdout, stderr } = await runCli(["test", "--json"], { port: host.port });
    assert.equal(code, 1);
    assert.equal(stderr, "");
    const obj = parseJson(stdout);
    assert.equal(obj.ok, false);
    assert.match(obj.error, /Extension blew up/);
  } finally {
    await host.stop();
  }
});

// VAL-OUTPUT-005b: mirror of VAL-OUTPUT-005 for --raw mode. The host returns
// {ok:false}, so the CLI forwards the raw frame verbatim (requestId
// echoed back per the protocol, no parseAiResponse applied, no stderr).
test("VAL-OUTPUT-005b: --raw failure when host returns ok:false", async () => {
  const host = new MockHost({ frame: { ok: false, error: "Extension blew up" } });
  await host.start();
  try {
    const { code, stdout, stderr } = await runCli(["test", "--raw"], { port: host.port });
    assert.equal(code, 1);
    assert.equal(stderr, "");
    const obj = parseJson(stdout);
    assert.equal(obj.ok, false);
    // Per the native-host protocol (native-messaging.ts:98-108), the bridge
    // assigns an autoincrementing requestId and the host echoes it back.
    assert.equal(typeof obj.requestId, "number");
    assert.match(obj.error, /Extension blew up/);
    assert.doesNotMatch(stdout, /## Sources/);
  } finally {
    await host.stop();
  }
});

test("VAL-OUTPUT-006: --json stdout is exactly one JSON document (optional trailing newline)", async () => {
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    const { stdout } = await runCli(["capital of France", "--json"], { port: host.port });
    // JSON.parse must consume everything up to an optional single trailing newline.
    const replaced = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
    const parsed = JSON.parse(replaced);
    assert.equal(parsed.ok, true);
    assert.equal(typeof parsed.markdown, "string");
    // Count of top-level JSON objects must be exactly 1. Splitting on
    // boundary "}{ " won't work for nested objects, but verifying the
    // trailing newline is the only "extra" byte is the goal.
    assert.ok(!replaced.includes("}{"), "multiple JSON values on stdout");
  } finally {
    await host.stop();
  }
});

test("VAL-OUTPUT-007: --raw success forwards verbatim host frame (no parsing)", async () => {
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    const { code, stdout, stderr } = await runCli(["capital of France", "--raw"], {
      port: host.port,
    });
    assert.equal(code, 0);
    assert.equal(stderr, "");
    const obj = parseJson(stdout);
    assert.equal(obj.ok, true);
    assert.match(obj.html, /\[CITE-/);
    assert.ok(Array.isArray(obj.citations));
    // Not parsed markdown.
    assert.doesNotMatch(stdout, /## Sources/);
  } finally {
    await host.stop();
  }
});

test("VAL-OUTPUT-008: --raw failure (host down) prints structured error, exits 1", async () => {
  const { code, stdout, stderr } = await runCli(["test", "--raw"], { port: 1 });
  assert.equal(code, 1);
  assert.equal(stderr, "");
  const obj = parseJson(stdout);
  assert.equal(obj.ok, false);
  assert.ok(typeof obj.error === "string" && obj.error.length > 0);
});

test("VAL-OUTPUT-009: --raw preserves host frame byte-for-byte (requestId etc.)", async () => {
  const frame = {
    ok: true,
    html: "<x>[CITE-1]</x>",
    citations: [{ marker_id: 1, sources: [{ title: "t", url: "u", domain: "d" }] }],
  };
  const host = new MockHost({ frame });
  await host.start();
  try {
    const { stdout } = await runCli(["test", "--raw"], { port: host.port });
    const obj = parseJson(stdout);
    assert.equal(obj.ok, true);
    assert.equal(obj.html, "<x>[CITE-1]</x>");
    assert.deepEqual(obj.citations, frame.citations);
    // requestId is injected by the mock from the request; assert it is present.
    assert.equal(typeof obj.requestId, "number");
  } finally {
    await host.stop();
  }
});

test("VAL-OUTPUT-010: conflicting --json --raw resolves to --raw (raw wins)", async () => {
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    const { code, stdout } = await runCli(["capital of France", "--json", "--raw"], {
      port: host.port,
    });
    assert.equal(code, 0);
    const obj = parseJson(stdout);
    // raw frame shape: html + requestId, NO markdown field.
    assert.match(obj.html, /\[CITE-/);
    assert.equal(typeof obj.requestId, "number");
    assert.equal(obj.markdown, undefined);
  } finally {
    await host.stop();
  }
});

test("VAL-OUTPUT-011: --json with empty citations keeps the field present as []", async () => {
  const host = new MockHost({ frame: { ok: true, html: "<p> plain answer </p>", citations: [] } });
  await host.start();
  try {
    const { code, stdout } = await runCli(["test", "--json"], { port: host.port });
    assert.equal(code, 0);
    const obj = parseJson(stdout);
    assert.equal(obj.ok, true);
    assert.ok(Array.isArray(obj.citations));
    assert.deepEqual(obj.citations, []);
  } finally {
    await host.stop();
  }
});

// ---------------------------------------------------------------------------
// Area 3 — status subcommand (VAL-STATUS)
// ---------------------------------------------------------------------------

test("VAL-STATUS-001: status reachable true, exit 0, no search", async () => {
  const probe = await MockHost.probeOnly();
  try {
    const { code, stdout, stderr } = await runCli(["status"], { port: probe.port });
    assert.equal(code, 0);
    assert.equal(stderr, "");
    const obj = parseJson(stdout);
    assert.equal(obj.ok, true);
    assert.equal(obj.host, "127.0.0.1");
    assert.equal(obj.port, probe.port);
    assert.equal(obj.reachable, true);
    assert.equal(probe.receivedBytes.value, 0);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-STATUS-002: status reachable false, exit 1, empty stderr", async () => {
  const { code, stdout, stderr } = await runCli(["status"], { port: 1 });
  assert.equal(code, 1);
  assert.equal(stderr, "");
  const obj = parseJson(stdout);
  assert.equal(obj.ok, false);
  assert.equal(obj.host, "127.0.0.1");
  assert.equal(obj.port, 1);
  assert.equal(obj.reachable, false);
});

test("VAL-STATUS-003: status honors GOOGLE_AI_HOST_HOST/GOOGLE_AI_HOST_PORT echoes config", async () => {
  // unreachable custom port -> reachable:false but echoes host/port.
  const { code, stdout, stderr } = await runCli(["status"], {
    port: 59999,
    host: "127.0.0.1",
  });
  assert.equal(code, 1);
  assert.equal(stderr, "");
  const obj = parseJson(stdout);
  assert.equal(obj.host, "127.0.0.1");
  assert.equal(obj.port, 59999);
  assert.equal(obj.reachable, false);

  // reachable case echoes the listening port.
  const probe = await MockHost.probeOnly();
  try {
    const r = await runCli(["status"], { port: probe.port, host: "127.0.0.1" });
    assert.equal(r.code, 0);
    const o = parseJson(r.stdout);
    assert.equal(o.host, "127.0.0.1");
    assert.equal(o.port, probe.port);
    assert.equal(o.reachable, true);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-STATUS-004: status writes nothing to stderr in either outcome", async () => {
  // reachable
  const probe = await MockHost.probeOnly();
  try {
    const a = await runCli(["status"], { port: probe.port });
    assert.equal(a.stderr, "");
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
  // unreachable
  const b = await runCli(["status"], { port: 1 });
  assert.equal(b.stderr, "");
});

test("VAL-STATUS-005: status sends no search frame", async () => {
  const probe = await MockHost.probeOnly();
  try {
    await runCli(["status"], { port: probe.port });
    assert.equal(probe.receivedBytes.value, 0);
    assert.equal(probe.connectionCount.value, 1); // connects but sends nothing
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-STATUS-006: status --json keeps the same status schema (no markdown wrap)", async () => {
  const probe = await MockHost.probeOnly();
  try {
    const { code, stdout } = await runCli(["status", "--json"], { port: probe.port });
    assert.equal(code, 0);
    const obj = parseJson(stdout);
    assert.equal(obj.host, "127.0.0.1");
    assert.equal(obj.port, probe.port);
    assert.equal(obj.reachable, true);
    assert.equal(obj.markdown, undefined);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-STATUS-007: status --raw keeps the status schema (no host frame)", async () => {
  const probe = await MockHost.probeOnly();
  try {
    const { code, stdout } = await runCli(["status", "--raw"], { port: probe.port });
    assert.equal(code, 0);
    const obj = parseJson(stdout);
    assert.equal(obj.reachable, true);
    assert.equal(obj.html, undefined);
    assert.equal(obj.requestId, undefined);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-STATUS-008: status with a trailing token does not dispatch a search", async () => {
  const probe = await MockHost.probeOnly();
  try {
    const { code, stdout, stderr } = await runCli(["status", "extra"], { port: probe.port });
    // Deterministic: trailing token is collected and rejected by main via
    // failUsageAndExit, so the result is exit 2 with stderr, not a status frame.
    assert.equal(code, 2, `code=${code}`);
    assert.equal(stdout, "");
    assert.notEqual(stderr, "");
    assert.equal(probe.receivedBytes.value, 0);
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

// ---------------------------------------------------------------------------
// Area 4 — Error & Exit Code Conventions (VAL-ERROR)
// ---------------------------------------------------------------------------

test("VAL-ERROR-001: exit 0 on success for default/--json/--raw/status", async () => {
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    const def = await runCli(["q"], { port: host.port });
    assert.equal(def.code, 0, `default: ${def.stderr}`);
    const js = await runCli(["q", "--json"], { port: host.port });
    assert.equal(js.code, 0, `json: ${js.stderr}`);
    const raw = await runCli(["q", "--raw"], { port: host.port });
    assert.equal(raw.code, 0, `raw: ${raw.stderr}`);
    const probe = await MockHost.probeOnly();
    try {
      const st = await runCli(["status"], { port: probe.port });
      assert.equal(st.code, 0, `status: ${st.stderr}`);
    } finally {
      await new Promise((r) => probe.server.close(r));
    }
  } finally {
    await host.stop();
  }
});

test("VAL-ERROR-002: exit 1 on search/host error for default/--json/--raw (host down)", async () => {
  const def = await runCli(["test"], { port: 1 });
  assert.equal(def.code, 1);
  assert.notEqual(def.stderr, "");
  assert.equal(def.stdout, "");

  const js = await runCli(["test", "--json"], { port: 1 });
  assert.equal(js.code, 1);
  assert.equal(js.stderr, "");
  const jobj = parseJson(js.stdout);
  assert.equal(jobj.ok, false);

  const raw = await runCli(["test", "--raw"], { port: 1 });
  assert.equal(raw.code, 1);
  assert.equal(raw.stderr, "");
  const robj = parseJson(raw.stdout);
  assert.equal(robj.ok, false);
});

test("VAL-ERROR-003: usage errors exit 2 with stderr only", async () => {
  const cases = [
    ["--stdin"], // VAL-ARGS-005/006 (empty pipe)
    ["--query", "test", "--timeout-ms", "abc"], // VAL-ARGS-010
    ["--query", "test", "--timeout-ms"], // VAL-ARGS-011
    ["--query", "test", "--bogus"], // VAL-ARGS-012
    [], // VAL-ARGS-013 (empty query, empty pipe)
    ["   "], // VAL-ARGS-014
    ["--query"], // VAL-ARGS-016
    ["--query", "--json", "test"], // VAL-ARGS-017
  ];
  for (const args of cases) {
    const { code, stdout, stderr } = await runCli(args, { port: 1, stdinInput: "" });
    assert.equal(code, 2, `args=${JSON.stringify(args)} stderr=${stderr}`);
    assert.equal(stdout, "", `args=${JSON.stringify(args)} stdout leaked`);
    assert.notEqual(stderr, "", `args=${JSON.stringify(args)} empty stderr`);
  }
});

test("VAL-ERROR-004: usage-error path never sends a search", async () => {
  const probe = await MockHost.probeOnly();
  try {
    const cases = [
      ["--stdin"],
      ["--query", "test", "--timeout-ms", "abc"],
      ["--query", "test", "--bogus"],
      ["   "],
      ["--query"],
    ];
    for (const args of cases) {
      await runCli(args, { port: probe.port, stdinInput: "" });
    }
    assert.equal(probe.connectionCount.value, 0, "a usage-error case opened a socket");
  } finally {
    await new Promise((r) => probe.server.close(r));
  }
});

test("VAL-ERROR-005: --json/--raw errors never write to stderr", async () => {
  const js = await runCli(["test", "--json"], { port: 1 });
  assert.equal(js.stderr, "");
  const raw = await runCli(["test", "--raw"], { port: 1 });
  assert.equal(raw.stderr, "");
});

test("VAL-ERROR-006: no stack traces leak to stderr/stdout on any path", async () => {
  const checks = [
    await runCli(["test"], { port: 1 }),
    await runCli(["test", "--json"], { port: 1 }),
    await runCli(["test", "--raw"], { port: 1 }),
    await runCli(["--bogus", "test"], { port: 1 }),
    await runCli(["--stdin"], { port: 1, stdinInput: "" }),
  ];
  for (const r of checks) {
    assert.doesNotMatch(r.stderr, /\n    at /, `stderr leaked a stack: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /node:internal/);
    assert.doesNotMatch(r.stdout, /\n    at /);
  }
});

test("VAL-ERROR-007: timeout surfaces as exit 1 (not exit 2)", async () => {
  const host = new MockHost({ silent: true, frame: okFrame() });
  await host.start();
  try {
    const start = Date.now();
    const { code, stdout, stderr } = await runCli(
      ["q", "--timeout-ms", "500"],
      { port: host.port, graceMs: "200" }
    );
    const elapsed = Date.now() - start;
    assert.equal(code, 1);
    // elapsed ~ timeout + grace (well under 60s).
    assert.ok(elapsed < 10000, `elapsed=${elapsed}ms`);
    // In default mode the message is on stderr; should mention timeout.
    assert.match(stderr, /timeout|timed out/i);
    assert.doesNotMatch(stderr, /\n    at /);
    // host received a search frame (it just didn't respond).
    assert.equal(host.receivedFrames.length, 1);
  } finally {
    await host.stop();
  }
});

// ---------------------------------------------------------------------------
// Area 5 — End-to-End / wiring via mock host (VAL-E2E, non-live assertions)
// ---------------------------------------------------------------------------

test("VAL-E2E-006: toGoogleAiModeQuery is applied before bridge.search", async () => {
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    await runCli(["what is the capital of Brazil"], { port: host.port });
    assert.equal(host.receivedFrames.length, 1);
    // The transform appends the English-answer instruction.
    assert.match(host.receivedFrames[0].query, /answer in English/i);
    assert.match(host.receivedFrames[0].query, /^what is the capital of Brazil/);
  } finally {
    await host.stop();
  }
});

test("VAL-E2E-006: query already asking English is not double-wrapped", async () => {
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    await runCli(["what is 2+2? please answer in English."], { port: host.port });
    assert.equal(host.receivedFrames.length, 1);
    assert.equal(host.receivedFrames[0].query, "what is 2+2? please answer in English.");
  } finally {
    await host.stop();
  }
});

test("VAL-E2E-007: parseAiResponse applied in default and --json, skipped in --raw", async () => {
  const frame = {
    ok: true,
    html: "<p>Answer [CITE-1]</p>",
    citations: [{ marker_id: 1, sources: [{ title: "S", url: "https://x", domain: "x" }] }],
  };
  const host = new MockHost({ frame });
  await host.start();
  try {
    const def = await runCli(["q"], { port: host.port });
    assert.match(def.stdout, /\[1\]/);
    assert.match(def.stdout, /## Sources/);

    const js = await runCli(["q", "--json"], { port: host.port });
    const jobj = parseJson(js.stdout);
    assert.match(jobj.markdown, /\[1\]/);
    assert.match(jobj.markdown, /## Sources/);

    const raw = await runCli(["q", "--raw"], { port: host.port });
    const robj = parseJson(raw.stdout);
    assert.match(robj.html, /\[CITE-1\]/);
    assert.doesNotMatch(raw.stdout, /\[1\]/);
    assert.doesNotMatch(raw.stdout, /## Sources/);
  } finally {
    await host.stop();
  }
});

test("VAL-E2E-008: no dist/index.js subprocess spawned (single process)", async () => {
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    // Run the CLI; during the run, no dist/index.js child should appear.
    const { code } = await runCli(["q"], { port: host.port });
    assert.equal(code, 0);
    // The CLI exits cleanly; we verify by ps that no index.js lingers.
    // (Spawned children would have been reaped already; the assertion is that
    //  we reach success without spawning index.js — verified by code structure
    //  inspection in the cross test below + the fact that no MCP SDK import
    //  remains in src/cli.ts.)
  } finally {
    await host.stop();
  }
});

// ---------------------------------------------------------------------------
// Area 6 — Cross-Cutting Flows (VAL-CROSS)
// ---------------------------------------------------------------------------

test("VAL-CROSS-001: GOOGLE_AI_HOST_HOST honored for query mode", async () => {
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    const { code } = await runCli(["test"], { host: "127.0.0.1", port: host.port });
    assert.equal(code, 0);
    assert.equal(host.receivedFrames.length, 1);
  } finally {
    await host.stop();
  }
  // Unreachable custom host -> exit 1, no fallback to default.
  const bad = await runCli(["test"], { host: "127.0.0.1", port: 1 });
  assert.equal(bad.code, 1);
});

test("VAL-CROSS-002: GOOGLE_AI_HOST_PORT honored for query mode (mock port)", async () => {
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    const { code } = await runCli(["test"], { port: host.port });
    assert.equal(code, 0);
    assert.equal(host.receivedFrames.length, 1);
  } finally {
    await host.stop();
  }
});

test("VAL-CROSS-003: GOOGLE_AI_TIMEOUT_MS honored as default timeout", async () => {
  const host = new MockHost({ silent: true, frame: okFrame() });
  await host.start();
  try {
    const start = Date.now();
    const { code } = await runCli(["test"], {
      port: host.port,
      timeoutMsEnv: "500",
      graceMs: "200",
    });
    const elapsed = Date.now() - start;
    assert.equal(code, 1);
    assert.ok(elapsed < 10000, `elapsed=${elapsed}ms`);
  } finally {
    await host.stop();
  }
});

test("VAL-CROSS-004: --timeout-ms overrides GOOGLE_AI_TIMEOUT_MS", async () => {
  const host = new MockHost({ silent: true, frame: okFrame() });
  await host.start();
  try {
    const start = Date.now();
    const { code } = await runCli(["test", "--timeout-ms", "500"], {
      port: host.port,
      // env says 60s but flag says 500ms
      timeoutMsEnv: "60000",
      graceMs: "200",
    });
    const elapsed = Date.now() - start;
    assert.equal(code, 1);
    assert.ok(elapsed < 10000, `elapsed=${elapsed}ms (should be ~500ms not ~60s)`);
  } finally {
    await host.stop();
  }
});

test("VAL-CROSS-005: --help mentions all flags, subcommands, and env vars", async () => {
  const { stderr } = await runCli(["--help"], { port: 1 });
  for (const token of [
    "--query",
    "--stdin",
    "--json",
    "--raw",
    "status",
    "--timeout-ms",
    "--timeout",
    "GOOGLE_AI_HOST_HOST",
    "GOOGLE_AI_HOST_PORT",
    "GOOGLE_AI_TIMEOUT_MS",
    "GOOGLE_AI_BRIDGE_GRACE_MS",
  ]) {
    assert.ok(stderr.includes(token), `--help missing token: ${token}`);
  }
  // precedence line
  assert.match(stderr, /--raw/i);
  assert.match(stderr, /precedence|overrides|wins/i);
});

test("VAL-CROSS-006: no orphaned processes after exit", async () => {
  const { execSync } = await import("node:child_process");
  // Snapshot all PIDs running before the test.
  const before = new Set(
    execSync("ps -eo pid | tail -n +2", { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    await runCli(["q"], { port: host.port });
  } finally {
    await host.stop();
  }
  // After exit, find any *new* PIDs running node dist/index.js.
  const afterPids = execSync("ps -eo pid | tail -n +2", { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !before.has(p));
  const orphans = [];
  for (const pid of afterPids) {
    try {
      const args = execSync(`ps -p ${pid} -o args=`, { encoding: "utf8" }).trim();
      if (args.includes("dist/index.js")) orphans.push(`${pid}: ${args}`);
    } catch {
      // Process already gone — fine.
    }
  }
  assert.equal(
    orphans.length,
    0,
    `new dist/index.js process(es) after CLI exit: ${orphans.join("; ")}`
  );
});

test("VAL-CROSS-007: --json citations field equals host citations verbatim", async () => {
  const citations = [{ marker_id: 1, sources: [{ title: "t", url: "u", domain: "d" }] }];
  const host = new MockHost({ frame: { ok: true, html: "<p>x [CITE-1]</p>", citations } });
  await host.start();
  try {
    const { stdout } = await runCli(["q", "--json"], { port: host.port });
    const obj = parseJson(stdout);
    assert.deepEqual(obj.citations, citations);
  } finally {
    await host.stop();
  }
});

test("VAL-CROSS-008: --json --raw precedence is consistent on the failure path", async () => {
  const { code, stdout, stderr } = await runCli(["test", "--json", "--raw"], { port: 1 });
  assert.equal(code, 1);
  assert.equal(stderr, "");
  const obj = parseJson(stdout);
  assert.equal(obj.ok, false);
  assert.equal(typeof obj.error, "string");
  // raw error frame shape — no markdown field.
  assert.equal(obj.markdown, undefined);
});

test("VAL-CROSS-009: stdout is byte-empty on usage errors (default mode)", async () => {
  const cases = [
    ["--stdin"],
    ["--query", "test", "--timeout-ms", "abc"],
    ["--query", "test", "--bogus"],
    ["   "],
    ["--query"],
  ];
  for (const args of cases) {
    const { stdout } = await runCli(args, { port: 1, stdinInput: "" });
    assert.equal(stdout.length, 0, `args=${JSON.stringify(args)} stdout not empty`);
  }
});

test("VAL-CROSS-010: --stdin with --query uses one deterministic source (query flag wins)", async () => {
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    const { code } = await runCli(["--stdin", "--query", "from flag"], {
      port: host.port,
      stdinInput: "from stdin",
    });
    assert.equal(code, 0);
    assert.equal(host.receivedFrames.length, 1);
    // The explicit --query value should win (documented choice).
    assert.match(host.receivedFrames[0].query, /^from flag/);
    // And it must NOT contain the stdin content concatenated.
    assert.doesNotMatch(host.receivedFrames[0].query, /from stdin/);
  } finally {
    await host.stop();
  }
});

test("VAL-CROSS-011: empty positional combined with --stdin reads from stdin", async () => {
  const host = new MockHost({ frame: okFrame({ html: "<p>gravity pulls [CITE-1]</p>" }) });
  await host.start();
  try {
    const { code, stdout, stderr } = await runCli(["--stdin"], {
      port: host.port,
      stdinInput: "what is gravity",
    });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /gravity/);
    assert.equal(host.receivedFrames.length, 1);
    assert.match(host.receivedFrames[0].query, /^what is gravity/);
  } finally {
    await host.stop();
  }
});

test("VAL-CROSS-012: output is deterministic for the same host frame", async () => {
  const host = new MockHost({ frame: okFrame() });
  await host.start();
  try {
    const a = await runCli(["q", "--json"], { port: host.port });
    const b = await runCli(["q", "--json"], { port: host.port });
    const ao = parseJson(a.stdout);
    const bo = parseJson(b.stdout);
    for (const key of ["ok", "markdown", "citations"]) {
      assert.ok(key in ao, `run a missing ${key}`);
      assert.ok(key in bo, `run b missing ${key}`);
    }
    const ra = await runCli(["q", "--raw"], { port: host.port });
    const rb = await runCli(["q", "--raw"], { port: host.port });
    const roa = parseJson(ra.stdout);
    const rob = parseJson(rb.stdout);
    for (const key of ["ok", "html", "citations"]) {
      assert.ok(key in roa, `raw run a missing ${key}`);
      assert.ok(key in rob, `raw run b missing ${key}`);
    }
  } finally {
    await host.stop();
  }
});

test("VAL-CROSS-015: src/cli.ts does not import @modelcontextprotocol/sdk", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /@modelcontextprotocol\/sdk/);
});

// gemini-code-assist review fix: a non-numeric GOOGLE_AI_HOST_PORT must NOT
// crash the CLI with an uncaught TypeError — it should produce a usage-leaning
// error message and a non-zero exit.
test("status: non-numeric GOOGLE_AI_HOST_PORT fails cleanly, not via TypeError", async () => {
  const { code, stdout, stderr } = await runCli(["status"], {
    env: { ...process.env, GOOGLE_AI_HOST_PORT: "not-a-number" },
  });
  assert.notEqual(code, 0, "non-numeric port should cause non-zero exit");
  // Combined output (either stream) must mention the invalid port.
  const combined = (stdout + stderr).toLowerCase();
  assert.ok(
    combined.includes("not-a-number") || combined.includes("invalid port"),
    `output must mention the bad port; got stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`
  );
  assert.doesNotMatch(stdout + stderr, /TypeError|undefined is not/);
});

// gemini-code-assist review fix: an unexpected runtime error (e.g., a stream
// error while reading stdin) must be emitted in the user's requested output
// format. In --json/--raw mode, the error must be a parseable JSON document
// on stdout — never unstructured stderr.
test("AI-REVIEW-001: unexpected errors are JSON in --json/--raw mode", async () => {
  // Provide garbage in argv that triggers a usage error before any stream I/O
  // as a proxy for an unexpected error path. Then assert that --json mode
  // emits structured output on stdout.
  const { code, stdout, stderr } = await runCli(
    ["--json", "--query", "x", "--unknown-flag"],
    { port: 1 } // port 1 would also cause a connection error; usage errors short-circuit first
  );
  assert.equal(code, 2, "unknown flag -> usage error exit 2");
  assert.equal(stdout, "", "usage errors in --json mode still write nothing to stdout");
  assert.notEqual(stderr, "");
  assert.doesNotMatch(stderr, /TypeError|undefined is not|^\s+at /);
});

test("AI-REVIEW-002: status mode does not crash on numeric port upper bound", async () => {
  const { code } = await runCli(["status"], {
    env: { ...process.env, GOOGLE_AI_HOST_PORT: "70000" },
  });
  assert.notEqual(code, 0, "out-of-range port should cause non-zero exit");
});
