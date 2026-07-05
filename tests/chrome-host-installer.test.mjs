import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

test("Chrome native host manifest includes allowed_origins for the extension id", () => {
  const { buildChromeManifest } = require("../native-host/install-chrome-host.cjs");

  const manifest = buildChromeManifest("abcdefghijklmnopabcdefghijklmnop");

  assert.equal(manifest.name, "com.google.ai.search");
  assert.equal(manifest.type, "stdio");
  assert.deepEqual(manifest.allowed_origins, [
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
  ]);
  assert.match(manifest.path, /native-host\/run-host\.sh$/);
});

test("Chrome native host installer rejects missing extension id", () => {
  const { parseArgs } = require("../native-host/install-chrome-host.cjs");

  assert.throws(
    () => parseArgs(["node", "script"]),
    /Missing required Chrome extension id/
  );
});
