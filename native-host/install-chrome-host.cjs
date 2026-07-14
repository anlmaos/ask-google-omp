#!/usr/bin/env node
/**
 * Registers the native-messaging host with Chromium-compatible browsers.
 *
 * Chromium-compatible native messaging manifests require `allowed_origins`,
 * which must include the concrete unpacked or store extension id:
 *
 *   node native-host/install-chrome-host.cjs --extension-id <32-char-id>
 *   CHROME_EXTENSION_ID=<32-char-id> node native-host/install-chrome-host.cjs
 *
 * Optional:
 *   --browser chrome     (default)
 *   --browser chromium
 *   --browser brave
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const HOST_NAME = "com.ask.google";
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
  brave: {
    linuxDir: path.join(".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
    macDir: path.join(
      "Library",
      "Application Support",
      "BraveSoftware",
      "Brave-Browser",
      "NativeMessagingHosts"
    ),
    winKey: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
  },
};

function supportedBrowsers() {
  return Object.keys(BROWSERS).join(", ");
}

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
    throw new Error(`Unsupported browser: ${browser}. Use ${supportedBrowsers()}.`);
  }
  return { extensionId, browser };
}

function buildChromeManifest(extensionId) {
  validateExtensionId(extensionId);
  return {
    name: HOST_NAME,
    description: "Ask Google native messaging bridge",
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

function resolveManifestTarget({
  browser = "chrome",
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  const browserConfig = BROWSERS[browser];
  if (!browserConfig) {
    throw new Error(`Unsupported browser: ${browser}. Use ${supportedBrowsers()}.`);
  }

  if (platform === "linux") {
    return path.join(homeDir, browserConfig.linuxDir, `${HOST_NAME}.json`);
  }

  if (platform === "darwin") {
    return path.join(homeDir, browserConfig.macDir, `${HOST_NAME}.json`);
  }

  if (platform === "win32") {
    return {
      manifestPath: path.win32.join(
        homeDir,
        ".anima-use-google",
        browser,
        `${HOST_NAME}.json`
      ),
      registryKey: `${browserConfig.winKey}\\${HOST_NAME}`,
    };
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

function installChromeHost({ extensionId, browser = "chrome" }) {
  const manifest = buildChromeManifest(extensionId);
  writeLauncher();

  if (process.platform === "linux") {
    const target = resolveManifestTarget({ browser });
    writeJson(target, manifest);
    return target;
  }

  if (process.platform === "darwin") {
    const target = resolveManifestTarget({ browser });
    writeJson(target, manifest);
    return target;
  }

  if (process.platform === "win32") {
    const { execSync } = require("node:child_process");
    const { manifestPath, registryKey } = resolveManifestTarget({ browser });
    writeJson(manifestPath, manifest);
    const regValue = manifestPath.replace(/\\/g, "\\\\");
    execSync(
      `reg add "${registryKey}" /ve /t REG_SZ /d "${regValue}" /f`
    );
    return manifestPath;
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

function main() {
  const options = parseArgs();
  const target = installChromeHost(options);
  console.log(`Chromium-compatible native messaging host registered: ${HOST_NAME}`);
  console.log(`Browser:    ${options.browser}`);
  console.log(`Manifest:  ${target}`);
  console.log(`Host:      ${HOST_JS}`);
  console.log(`Extension: chrome-extension://${options.extensionId}/`);
  console.log("");
  console.log(`Reload the ${options.browser} extension after installing the host manifest.`);
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
  resolveManifestTarget,
  validateExtensionId,
};
