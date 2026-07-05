#!/usr/bin/env node
/**
 * Registers the native-messaging host with Firefox by writing the
 * platform-specific manifest to the location Firefox scans for installed
 * native messaging hosts, pointing at this repo's host.js.
 *
 *   Windows:  registry (HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.google.ai.search)
 *   macOS:    ~/Library/ApplicationSupport/Mozilla/NativeMessagingHosts/com.google.ai.search.json
 *   Linux:    ~/.mozilla/native-messaging-hosts/com.google.ai.search.json
 *
 * Re-run this any time you move the repo.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const HOST_NAME = "com.google.ai.search";
const REPO_ROOT = path.resolve(__dirname, "..");
const HOST_JS = path.join(REPO_ROOT, "native-host", "host.js");

function buildManifest() {
  // Firefox requires the host path executable on Unix; we point to a tiny
  // launcher shell script so it works regardless of node location.
  const launcher = path.join(__dirname, "run-host.sh");
  return {
    name: HOST_NAME,
    description: "Anima-use-google native messaging bridge",
    path: launcher,
    type: "stdio",
    allowed_extensions: ["google-ai-search@anima-use-google"],
  };
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

function installLinux() {
  const dir = path.join(os.homedir(), ".mozilla", "native-messaging-hosts");
  const target = path.join(dir, `${HOST_NAME}.json`);
  writeJson(target, buildManifest());
  return target;
}

function installMac() {
  const dir = path.join(
    os.homedir(),
    "Library",
    "ApplicationSupport",
    "Mozilla",
    "NativeMessagingHosts"
  );
  const target = path.join(dir, `${HOST_NAME}.json`);
  writeJson(target, buildManifest());
  return target;
}

function installWindows() {
  const { execSync } = require("node:child_process");
  const manifestPath = path.join(
    os.homedir(),
    ".anima-use-google",
    `${HOST_NAME}.json`
  );
  writeJson(manifestPath, buildManifest());
  const regValue = manifestPath.replace(/\\/g, "\\\\");
  // HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.google.ai.search
  try {
    execSync(
      `reg add "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}" /ve /t REG_SZ /d "${regValue}" /f`
    );
  } catch (err) {
    throw new Error(`Failed to write registry key: ${err.message}`);
  }
  return manifestPath;
}

function writeLauncher() {
  // A small bash launcher that Firefox execs; it just runs node on host.js.
  const launcher = path.join(__dirname, "run-host.sh");
  const nodeBin = process.execPath;
  const content = `#!/bin/sh
exec "${nodeBin}" "${HOST_JS}" "$@"
`;
  fs.writeFileSync(launcher, content, { mode: 0o755 });
  fs.chmodSync(launcher, 0o755);
}

function main() {
  const platform = process.platform;
  let target;
  if (platform === "win32") target = installWindows();
  else if (platform === "darwin") target = installMac();
  else if (platform === "linux") target = installLinux();
  else throw new Error(`Unsupported platform: ${platform}`);

  writeLauncher();

  console.log(`Native messaging host registered: ${HOST_NAME}`);
  console.log(`Manifest:  ${target}`);
  console.log(`Host:       ${HOST_JS}`);
  console.log(`Launcher:   ${path.join(__dirname, "run-host.sh")}`);
  console.log("");
  console.log(
    "Make sure Firefox is (re)started with the extension loaded so connectNative picks this up."
  );
}

try {
  main();
} catch (err) {
  console.error(`install-host: ${err.message}`);
  process.exit(1);
}
