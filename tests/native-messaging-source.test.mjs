import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/native-messaging.ts", import.meta.url),
  "utf8"
);

test("bridge response timeout leaves room for the extension watchdog", () => {
  assert.match(source, /BRIDGE_RESPONSE_GRACE_MS\s*=\s*Number/);
  assert.match(source, /timeoutMs\s*\+\s*BRIDGE_RESPONSE_GRACE_MS/);
});
