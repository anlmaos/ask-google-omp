#!/usr/bin/env node
/**
 * Registers the native-messaging host with Chrome/Chromium-compatible browsers.
 *
 * Chrome native messaging manifests require `allowed_origins`, which must include
 * the concrete unpacked or store extension id:
 *
 *   node native-host/install-chrome-host.cjs --extension-id <32-char-id>
 *   CHROME_EXTENSION_ID=<32-char-id> node native-host/install-chrome-host.cjs
 *
 * Optional:
 *   --browser chrome     (default)
 *   --browser chromium
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const HOST_NAME = "com.google.ai.search";
const REPO_ROOT = path.resolve(__dirname, "..");
const HOST_JS = path.join(REPO_ROOT, "native-host", "host.js");

const BROWSERS = {
  chrome: {
    linuxDir: path.join(".config", "google-chrome", "NativeMessagingHosts"),
    macDir: path.join("Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
    winKey: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
  },
  chromium: {
    linuxDir: path.join(".config", "chromium", "NativeMessagingHosts"),
    macDir: path.join("Library", "Application Support", "Chromium", "NativeMessagingHosts"),
    winKey: "HKCU\\Software\\Chromium\\NativeMessagingHosts",
  },
};

function validateExtensionId(extensionId) {
  if (!/^[a-p]{32}$/.test(extensionId || "")) {
    throw new Error(
      "Chrome extension id must be 32 lowercase characters in the range a-p"
    );
  }
}

function parseArgs(argv = process.argv, env = process.env) {
  let extensionId = env.CHROME_EXTENSION_ID || "";
  let browser = env.CHROME_BROWSER || "chrome";

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--extension-id") {
      extensionId = argv[++i] || "";
    } else if (arg.startsWith("--extension-id=")) {
      extensionId = arg.slice("--extension-id=".length);
    } else if (arg === "--browser") {
      browser = argv[++i] || "";
    } else if (arg.startsWith("--browser=")) {
      browser = arg.slice("--browser=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!extensionId) {
    throw new Error(
      "Missing required Chrome extension id. Pass --extension-id <id> or set CHROME_EXTENSION_ID."
    );
  }
  validateExtensionId(extensionId);
  if (!BROWSERS[browser]) {
    throw new Error(`Unsupported browser: ${browser}. Use chrome or chromium.`);
  }
  return { extensionId, browser };
}

function buildChromeManifest(extensionId) {
  validateExtensionId(extensionId);
  return {
    name: HOST_NAME,
    description: "Anima-use-google native messaging bridge",
    path: path.join(__dirname, "run-host.sh"),
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

function writeLauncher() {
  const launcher = path.join(__dirname, "run-host.sh");
  const nodeBin = process.execPath;
  const content = `#!/bin/sh
exec "${nodeBin}" "${HOST_JS}" "$@"
`;
  fs.writeFileSync(launcher, content, { mode: 0o755 });
  fs.chmodSync(launcher, 0o755);
}

function installChromeHost({ extensionId, browser }) {
  const browserConfig = BROWSERS[browser];
  const manifest = buildChromeManifest(extensionId);
  writeLauncher();

  if (process.platform === "linux") {
    const target = path.join(os.homedir(), browserConfig.linuxDir, `${HOST_NAME}.json`);
    writeJson(target, manifest);
    return target;
  }

  if (process.platform === "darwin") {
    const target = path.join(os.homedir(), browserConfig.macDir, `${HOST_NAME}.json`);
    writeJson(target, manifest);
    return target;
  }

  if (process.platform === "win32") {
    const { execSync } = require("node:child_process");
    const manifestPath = path.join(
      os.homedir(),
      ".anima-use-google",
      browser,
      `${HOST_NAME}.json`
    );
    writeJson(manifestPath, manifest);
    const regValue = manifestPath.replace(/\\/g, "\\\\");
    execSync(
      `reg add "${browserConfig.winKey}\\${HOST_NAME}" /ve /t REG_SZ /d "${regValue}" /f`
    );
    return manifestPath;
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

function main() {
  const options = parseArgs();
  const target = installChromeHost(options);
  console.log(`Chrome native messaging host registered: ${HOST_NAME}`);
  console.log(`Browser:    ${options.browser}`);
  console.log(`Manifest:  ${target}`);
  console.log(`Host:      ${HOST_JS}`);
  console.log(`Extension: chrome-extension://${options.extensionId}/`);
  console.log("");
  console.log("Reload the Chromium extension after installing the host manifest.");
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`install-chrome-host: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildChromeManifest,
  installChromeHost,
  parseArgs,
  validateExtensionId,
};
