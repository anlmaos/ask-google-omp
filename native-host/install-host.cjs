#!/usr/bin/env node
/**
 * Registers the native-messaging host with Firefox by writing the
 * platform-specific manifest to the location Firefox scans for installed
 * native messaging hosts, pointing at this repo's host.js.
 *
 *   Windows:  registry (HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.ask.google)
 *   macOS:    ~/Library/Application Support/Mozilla/NativeMessagingHosts/com.ask.google.json
 *   Linux:    ~/.mozilla/native-messaging-hosts/com.ask.google.json
 *
 * Re-run this any time you move the repo.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const HOST_NAME = "com.ask.google";
const REPO_ROOT = path.resolve(__dirname, "..");
const HOST_JS = path.join(REPO_ROOT, "native-host", "host.js");
const FIREFOX_WIN_KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;

function buildManifest() {
  // Firefox requires the host path executable on Unix; we point to a tiny
  // launcher shell script so it works regardless of node location.
  const launcher = path.join(__dirname, "run-host.sh");
  return {
    name: HOST_NAME,
    description: "Ask Google native messaging bridge",
    path: launcher,
    type: "stdio",
    allowed_extensions: ["ask-google@anima-use-google"],
  };
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

function resolveManifestTarget({
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  if (platform === "linux") {
    return path.join(
      homeDir,
      ".mozilla",
      "native-messaging-hosts",
      `${HOST_NAME}.json`
    );
  }

  if (platform === "darwin") {
    return path.join(
      homeDir,
      "Library",
      "Application Support",
      "Mozilla",
      "NativeMessagingHosts",
      `${HOST_NAME}.json`
    );
  }

  if (platform === "win32") {
    return {
      manifestPath: path.win32.join(
        homeDir,
        ".anima-use-google",
        `${HOST_NAME}.json`
      ),
      registryKey: FIREFOX_WIN_KEY,
    };
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

function installLinux() {
  const target = resolveManifestTarget();
  writeJson(target, buildManifest());
  return target;
}

function installMac() {
  const target = resolveManifestTarget();
  writeJson(target, buildManifest());
  return target;
}

function installWindows() {
  const { execSync } = require("node:child_process");
  const { manifestPath, registryKey } = resolveManifestTarget();
  writeJson(manifestPath, buildManifest());
  const regValue = manifestPath.replace(/\\/g, "\\\\");
  try {
    execSync(
      `reg add "${registryKey}" /ve /t REG_SZ /d "${regValue}" /f`
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

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`install-host: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildManifest,
  resolveManifestTarget,
};
