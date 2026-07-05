import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

test("Firefox native host installer resolves platform-specific locations", () => {
  const { resolveManifestTarget } = require("../native-host/install-host.cjs");

  assert.equal(
    resolveManifestTarget({
      platform: "linux",
      homeDir: "/home/alice",
    }),
    "/home/alice/.mozilla/native-messaging-hosts/com.google.ai.search.json"
  );

  assert.equal(
    resolveManifestTarget({
      platform: "darwin",
      homeDir: "/Users/alice",
    }),
    "/Users/alice/Library/Application Support/Mozilla/NativeMessagingHosts/com.google.ai.search.json"
  );

  assert.deepEqual(
    resolveManifestTarget({
      platform: "win32",
      homeDir: "C:\\Users\\Alice",
    }),
    {
      manifestPath: "C:\\Users\\Alice\\.anima-use-google\\com.google.ai.search.json",
      registryKey:
        "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.google.ai.search",
    }
  );
});
