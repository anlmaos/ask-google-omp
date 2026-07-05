# anima-use-google

MCP server + browser sidecar extension that lets AI agents (Claude Code, Cursor, etc.) run [Google AI Mode](https://blog.google/products/search/ai-mode-search/) searches using your **own logged-in browser session**, then return the synthesized answer and citations as an MCP tool result.

No headless browser, no stealth tricks, no CAPTCHA fighting. Your real browser profile does the work.

## Quickest path (5 minutes)

You need three things: the MCP server, the native-messaging host, and either the Firefox or Chromium extension. Then wire the server into your agent.

### 1. Wire the MCP server into your agent

Claude Code:

```bash
claude mcp add google-ai-search -- npx anima-use-google
```

Other agents - add to your MCP config:

```json
{
  "mcpServers": {
    "google-ai-search": {
      "command": "npx",
      "args": ["anima-use-google"]
    }
  }
}
```

If you do not want your agent to follow npm's moving `latest` tag, pin the MCP
server to a GitHub commit instead:

```bash
claude mcp add google-ai-search -- npm exec --yes --package github:animaios/anima-use-google#<commit-sha> -- anima-use-google
```

Equivalent MCP config:

```json
{
  "mcpServers": {
    "google-ai-search": {
      "command": "npm",
      "args": [
        "exec",
        "--yes",
        "--package",
        "github:animaios/anima-use-google#<commit-sha>",
        "--",
        "anima-use-google"
      ]
    }
  }
}
```

Use a full commit SHA for reproducibility. GitHub installs run the package's
`prepare` script, so the TypeScript server is built from source before npm runs
the `anima-use-google` bin.

The MCP server talks to the sidecar over localhost; it does not bundle a browser.

### 2. Set up a browser sidecar (one-time, non-npm)

The npm tarball ships everything you need. After the first `npx anima-use-google`, the files live in `~/.npm/_npx/<hash>/node_modules/anima-use-google/` - easiest to clone:

```bash
git clone https://github.com/animaios/anima-use-google
cd anima-use-google
```

#### Firefox

1. Register the native-messaging host:

   ```bash
   node native-host/install-host.cjs
   ```

   This writes the Firefox native-host registration for your OS:

   - Linux: `~/.mozilla/native-messaging-hosts/com.google.ai.search.json`
   - macOS: `~/Library/Application Support/Mozilla/NativeMessagingHosts/com.google.ai.search.json`
   - Windows: `HKCU\Software\Mozilla\NativeMessagingHosts\com.google.ai.search`, pointing at `%USERPROFILE%\.anima-use-google\com.google.ai.search.json`

2. Load the extension in Firefox:

   - Open `about:debugging#/runtime/this-firefox`.
   - Click **Load Temporary Add-on** and pick `extension/manifest.json`.
   - The host process starts on the first search.

3. Restart Firefox so the new native-messaging host is picked up.

For permanent install (loads on every FF start):

```bash
npx web-ext build --source-dir extension --overwrite-dest
# Then sign or load via about:config xpinstall.signatures.required=false (Dev/Nightly)
```

#### Chrome / Chromium / Brave

Chromium-based browsers use the `extension-chromium/` sidecar. Their native
messaging manifests require `allowed_origins`, so you need the extension id
before installing the native host.

1. Load the unpacked extension:

   - Chrome: open `chrome://extensions`.
   - Chromium: open `chromium://extensions`.
   - Brave: open `brave://extensions`.
   - Enable **Developer mode**.
   - Click **Load unpacked** and choose `extension-chromium/`.
   - Copy the generated extension id.

2. Register the native-messaging host:

   ```bash
   # Google Chrome
   node native-host/install-chrome-host.cjs --browser chrome --extension-id <extension-id>

   # Chromium
   node native-host/install-chrome-host.cjs --browser chromium --extension-id <extension-id>

   # Brave
   node native-host/install-chrome-host.cjs --browser brave --extension-id <extension-id>
   ```

   The installer writes the manifest or registry entry for your selected browser:

   - Chrome on Linux: `~/.config/google-chrome/NativeMessagingHosts/com.google.ai.search.json`
   - Chrome on macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.google.ai.search.json`
   - Chrome on Windows: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.google.ai.search`
   - Chromium on Linux: `~/.config/chromium/NativeMessagingHosts/com.google.ai.search.json`
   - Chromium on macOS: `~/Library/Application Support/Chromium/NativeMessagingHosts/com.google.ai.search.json`
   - Chromium on Windows: `HKCU\Software\Chromium\NativeMessagingHosts\com.google.ai.search`
   - Brave on Linux: `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.google.ai.search.json`
   - Brave on macOS: `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.google.ai.search.json`
   - Brave on Windows: `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.google.ai.search`

   On Windows, the manifest JSON itself is written under
   `%USERPROFILE%\.anima-use-google\<browser>\com.google.ai.search.json`, and
   the registry key points the browser at that file.

3. Reload the extension so `chrome.runtime.connectNative("com.google.ai.search")`
   sees the manifest.

### Switching between Firefox and Chromium-based sidecars

The MCP server always connects to the first browser native host listening on
`127.0.0.1:51784`. When switching browsers during development, make sure the
old sidecar is not still owning that port.

1. Disable or unload the sidecar you are not testing:

   - Firefox: remove or disable the temporary add-on from
     `about:debugging#/runtime/this-firefox`.
   - Chrome/Chromium/Brave: disable or remove the unpacked extension from
     `chrome://extensions`, `chromium://extensions`, or `brave://extensions`.

2. Stop any stale native host:

   ```bash
   ps -ef | rg '[n]ative-host/host\.js'
   kill <pid>
   ```

3. Register the host manifest for the browser you want:

   ```bash
   # Firefox
   node native-host/install-host.cjs

   # Google Chrome
   node native-host/install-chrome-host.cjs --browser chrome --extension-id <chrome-extension-id>

   # Chromium
   node native-host/install-chrome-host.cjs --browser chromium --extension-id <chrome-extension-id>

   # Brave
   node native-host/install-chrome-host.cjs --browser brave --extension-id <brave-extension-id>
   ```

4. Reload the chosen browser extension so it reconnects to native messaging.

5. Confirm which browser owns the host before running an E2E test:

   ```bash
   ps -ef | rg '[n]ative-host/host\.js|[b]rave|[c]hrome|[c]hromium|[f]irefox'
   ss -ltnp 'sport = :51784'
   ```

   For Chromium-based browsers, the host command should include an origin like
   `chrome-extension://<extension-id>/`. For Firefox, it is normally launched
   without that Chrome extension-origin argument.

### 3. Use it

Ask your agent normally:

> Search Google AI Mode for: Next.js 15 App Router best practices

The agent calls `search_google_ai`, your browser sidecar opens the `udm=50` search in your profile, the extension parses the AI answer with inline `[1][2]` citations, and the agent gets a grounded markdown response.

## How it works

```
Agent (stdio) <---> MCP server <---> localhost TCP <---> host.js
       <---> browser native port <---> background script
       <---> opens google.com/search?udm=50&q=...
       <---> content.js parses AI answer + sources
       <---> response back along the same chain
```

Your logged-in Google cookies are reused because the tab is opened in your own browser profile - if you have AI Mode enabled, it works; CAPTCHAs don't trigger (real user profile, no stealth games).

The multilanguage completion detection (SVG thumbs-up → aria-label → text markers → 40s fallback) and SERPO-style citation parsing are ported from the Battle-tested [google-ai-mode-mcp](https://github.com/PleasePrompto/google-ai-mode-mcp).

## Developers

Want to hack on the MCP server or build from source:

```bash
npm install
npm run build     # tsc -> dist/
npm test          # node:test regression suite
npm link          # then `anima-use-google` on PATH
```

Project layout:

- `src/` + `dist/` - TypeScript MCP server publishing as `anima-use-google`.
- `native-host/` - `host.js` bridges browser native messaging <-> localhost TCP; `install-host.cjs` writes the Firefox manifest; `install-chrome-host.cjs` writes the Chrome/Chromium/Brave manifest.
- `extension/` - Firefox MV3 sidecar.
- `extension-chromium/` - Chrome/Chromium/Brave MV3 sidecar using a service worker background.
- Selector constants live in each extension's `src/selectors.js` - update both if Google's AI Mode DOM shifts.

## Tuning

Cutoff markers (end-of-answer disclaimers, language-aware) and citation selectors are in `extension/src/selectors.js` and `extension-chromium/src/selectors.js`. If extraction fails on your locale, add your language's markers there.

## License

MIT. See `LICENSE`.
