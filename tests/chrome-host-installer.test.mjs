import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

test("Chrome native host manifest includes allowed_origins for the extension id", () => {
  const { buildChromeManifest } = require("../native-host/install-chrome-host.cjs");

  const manifest = buildChromeManifest("abcdefghijklmnopabcdefghijklmnop");

  assert.equal(manifest.name, "com.ask.google");
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

test("Brave native host installer resolves platform-specific locations", () => {
  const { parseArgs, resolveManifestTarget } = require("../native-host/install-chrome-host.cjs");

  assert.deepEqual(
    parseArgs([
      "node",
      "script",
      "--browser",
      "brave",
      "--extension-id",
      "abcdefghijklmnopabcdefghijklmnop",
    ]),
    {
      browser: "brave",
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
    }
  );

  assert.equal(
    resolveManifestTarget({
      browser: "brave",
      platform: "linux",
      homeDir: "/home/alice",
    }),
    "/home/alice/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.ask.google.json"
  );

  assert.equal(
    resolveManifestTarget({
      browser: "brave",
      platform: "darwin",
      homeDir: "/Users/alice",
    }),
    "/Users/alice/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.ask.google.json"
  );

  assert.deepEqual(
    resolveManifestTarget({
      browser: "brave",
      platform: "win32",
      homeDir: "C:\\Users\\Alice",
    }),
    {
      manifestPath: "C:\\Users\\Alice\\.anima-use-google\\brave\\com.ask.google.json",
      registryKey:
        "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.ask.google",
    }
  );
});
