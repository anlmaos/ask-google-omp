/**
 * Tests for the omp extension bridge (src/omp-extension.ts, built to
 * dist/omp-extension.js).
 *
 * Strategy: drive the real module through the same route omp does — import the
 * built output, call the default factory with a mock `ExtensionAPI`, capture
 * what it passes to `registerTool`, then invoke that tool's `execute` against an
 * unreachable port for the host-down cases.
 *
 * These assert the plugin's consumer-visible contract:
 * - the registered tool's name/parameter surface,
 * - host unreachable surfaces an actionable error rather than hanging,
 * - an aborted signal rejects instead of waiting out the 90s bridge ceiling.
 *
 * Importing the built module also proves it carries no runtime dependency on
 * the omp packages: those are declared only in `src/omp_extension.d.ts`, so a
 * real runtime import here would throw rather than resolve silently.
 */

import assert from "node:assert/strict";
import test from "node:test";

// The bridge resolves HOST_HOST/HOST_PORT once at module load, so the override
// must be in place before the extension module is first imported. Each test file
// runs in its own process under `node --test`, so this is file-scoped.
process.env.GOOGLE_AI_HOST_PORT = "59999";

let extensionPath = new URL("../dist/omp-extension.js", import.meta.url);
let cached = null;

async function captureTool() {
 if (cached) return cached;
 const mod = await import(extensionPath);
 let tool = null;
 const pi = {
  zod: {
   object: (shape) => ({ kind: "object", shape }),
   string: () => ({ kind: "string", describe: () => "string?" }),
   number: () => ({
    kind: "number",
    optional: () => ({
     kind: "number?",
     describe: () => "number?",
    }),
    describe: () => "number",
   }),
  },
  logger: { warn: () => { } },
  registerTool: (definition) => {
   tool = definition;
  },
 };
 assert.equal(typeof mod.default, "function", "extension must export a factory");
 mod.default(pi);
 assert.ok(tool, "factory must call registerTool");
 cached = tool;
 return tool;
}

test("ask_google tool advertises the query parameter the model must send", async () => {
 const tool = await captureTool();
 assert.equal(tool.name, "ask_google");
 assert.match(tool.description, /Google AI Mode/);
 assert.match(tool.description, /citations/);
 assert.equal(tool.parameters.shape.query, "string?");
 assert.equal(tool.parameters.shape.timeout_ms, "number?");
 assert.equal(tool.approval, "read");
});

test("host unreachable surfaces a diagnostic naming the host instead of hanging", async () => {
 const tool = await captureTool();
 await assert.rejects(
  tool.execute("call-1", { query: "test" }, undefined, undefined, {}),
  (err) => {
   assert.ok(err instanceof Error);
   assert.match(err.message, /127\.0\.0\.1:59999/);
   return true;
  }
 );
});

test("an aborted signal rejects rather than waiting for the browser", async () => {
 const tool = await captureTool();
 // Nothing listens on 59999, so any wait would end in the 90s bridge ceiling.
 const started = Date.now();
 await assert.rejects(
  tool.execute("call-2", { query: "test" }, AbortSignal.abort(), undefined, {})
 );
 assert.ok(
  Date.now() - started < 10000,
  "aborted search must fail fast, not run out the timeout"
 );
});
