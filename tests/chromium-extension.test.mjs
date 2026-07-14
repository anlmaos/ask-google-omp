import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Chromium extension manifest uses MV3 service worker and native messaging", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../extension-chromium/manifest.json", import.meta.url), "utf8")
  );

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.permissions.includes("nativeMessaging"), true);
  assert.equal(manifest.permissions.includes("tabs"), true);
  assert.deepEqual(manifest.host_permissions, ["https://www.google.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].js, ["src/selectors.js", "content.js"]);
});

test("Chromium background uses chrome APIs and the shared native host name", () => {
  const source = readFileSync(
    new URL("../extension-chromium/background.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /const NATIVE_HOST = "com\.ask\.google"/);
  assert.match(source, /chrome\.runtime\.connectNative/);
  assert.match(source, /chrome\.tabs\.sendMessage/);
  assert.doesNotMatch(source, /\bbrowser\./);
});

test("Chromium content script uses a chrome-compatible extension API shim", () => {
  const source = readFileSync(
    new URL("../extension-chromium/content.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /const extensionApi =/);
  assert.match(source, /chrome/);
  assert.doesNotMatch(source, /\bbrowser\.runtime/);
});
