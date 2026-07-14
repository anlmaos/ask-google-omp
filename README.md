<div align=center>

<img width="1672" height="941" alt="anima-use-google-logo" src="https://github.com/user-attachments/assets/5a51ffd2-e1e4-495a-b08f-8b24a3239db4" />

### MCP server + browser sidecar extension that lets AI agents run [Google AI Mode](https://blog.google/products/search/ai-mode-search/) searches using your **own logged-in browser session**, then return the synthesized answer and citations as an MCP tool result.

#### No headless browser, no stealth tricks, no CAPTCHA fighting. Your real browser profile does the work.

</div>

## Quickest path (5 minutes)

You need three things: the MCP server, the native-messaging host, and either the Firefox or Chromium extension. Then wire the server into your agent.

### 1. Wire the MCP server into your agent

The stable npm release is `0.1.6`. Pin it in agent configs if you want the same
server every time instead of whatever npm's `latest` tag points at later.

Claude Code:

```bash
claude mcp add ask-google -- npx anima-use-google@0.1.6
```

Other agents - add to your MCP config:

```json
{
  "mcpServers": {
    "ask-google": {
      "command": "npx",
      "args": ["anima-use-google@0.1.6"]
    }
  }
}
```

If you prefer installing straight from GitHub, pin the stable commit:

```bash
claude mcp add ask-google -- npm exec --yes --package github:animaios/anima-use-google#4311a84b580713ffd58d95dccbda8a97c635086f -- anima-use-google
```

Equivalent MCP config:

```json
{
  "mcpServers": {
    "ask-google": {
      "command": "npm",
      "args": [
        "exec",
        "--yes",
        "--package",
        "github:animaios/anima-use-google#4311a84b580713ffd58d95dccbda8a97c635086f",
        "--",
        "anima-use-google"
      ]
    }
  }
}
```

That commit is the same stable `0.1.6` release. GitHub installs run the package's
`prepare` script, so the TypeScript server is built from source before npm runs
the `anima-use-google` bin.

The MCP server talks to the sidecar over localhost; it does not bundle a browser.

### 2. Set up a browser sidecar (one-time, non-npm)

The npm tarball ships everything you need. After the first
`npx anima-use-google@0.1.6`, the files live in
`~/.npm/_npx/<hash>/node_modules/anima-use-google/`. For setup, cloning is
usually easier:

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

   - Linux: `~/.mozilla/native-messaging-hosts/com.ask.google.json`
   - macOS: `~/Library/Application Support/Mozilla/NativeMessagingHosts/com.ask.google.json`
   - Windows: `HKCU\Software\Mozilla\NativeMessagingHosts\com.ask.google`, pointing at `%USERPROFILE%\.anima-use-google\com.ask.google.json`

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

   - Chrome on Linux: `~/.config/google-chrome/NativeMessagingHosts/com.ask.google.json`
   - Chrome on macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ask.google.json`
   - Chrome on Windows: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ask.google`
   - Chromium on Linux: `~/.config/chromium/NativeMessagingHosts/com.ask.google.json`
   - Chromium on macOS: `~/Library/Application Support/Chromium/NativeMessagingHosts/com.ask.google.json`
   - Chromium on Windows: `HKCU\Software\Chromium\NativeMessagingHosts\com.ask.google`
   - Brave on Linux: `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.ask.google.json`
   - Brave on macOS: `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.ask.google.json`
   - Brave on Windows: `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.ask.google`

   On Windows, the manifest JSON itself is written under
   `%USERPROFILE%\.anima-use-google\<browser>\com.ask.google.json`, and
   the registry key points the browser at that file.

3. Reload the extension so `chrome.runtime.connectNative("com.ask.google")`
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

The agent calls `ask_google`, your browser sidecar opens the `udm=50` search in your profile, the extension parses the AI answer with inline `[1][2]` citations, and the agent gets a grounded markdown response.

## anima-use-google-cli

The `anima-use-google-cli` binary searches Google AI Mode directly through the native host on `127.0.0.1:51784`. It does **not** spawn the MCP server (`dist/index.js`) and has zero dependency on the `@modelcontextprotocol/sdk` — per invocation it runs as a single pure-Node process.

```
anima-use-google-cli <query>
  ├─ toGoogleAiModeQuery(query)         appends "answer in English" unless already requested
  ├─ new NativeMessagingBridge()        raw TCP to 127.0.0.1:51784 (4-byte LE prefix + JSON)
  ├─ bridge.search(query, timeoutMs)    framed request to host.js → extension → Google AI Mode
  ├─ parseAiResponse(html, citations)  cheerio + turndown → grounded markdown
  └─ stdout: markdown | --json | --raw ; stderr: errors ; exit 0/1/2
```

Designed for harnesses and people who don't want the MCP client interface. The CLI runs on Node 20+ with no new packages — cross-platform by construction (`bridge.dispose()` always runs in a `finally`, no lingering socket or child process).

```bash
# Positional (space-joined)
anima-use-google-cli <query>

# --query flag form is equivalent to positional
anima-use-google-cli --query "your query"

# Piped input
echo "your query" | anima-use-google-cli --stdin

# Or omit the flag — piped stdin is auto-detected when no positional or --query is given
```

Output modes:

- **Default** — parsed markdown answer (inline `[n]` citations + `## Sources` section) goes to **stdout**; errors go to **stderr**, exit 1.
- **`--json`** — a single JSON document to **stdout** and nothing else on any stream. Success: `{"ok":true,"markdown":"...","citations":[...]}` (exit 0). Any failure: `{"ok":false,"error":"..."}` (exit 1). The `citations` field is always present — an empty array when there are none.
- **`--raw`** — the verbatim host frame (`{"requestId",ok,"html","citations",error}`) to **stdout**; no `parseAiResponse` applied (the `html` is the raw host HTML containing `[CITE-N]` markers). Exit 0 on success, 1 on failure; nothing on stderr.
- **Precedence** — when `--json` and `--raw` are both passed, `--raw` wins (consistent on success and failure paths).

The `status` subcommand probes reachability without sending a search:

```bash
anima-use-google-cli status   # --json and --raw are accepted but produce the same schema
# reachable → {"ok":true,"host":"127.0.0.1","port":51784,"reachable":true} (exit 0)
# unreachable → {"ok":false,"host":"127.0.0.1","port":51784,"reachable":false} (exit 1)
# stderr is always empty on the status path
```

Environment (honored by the CLI and by the bridge it loads):

| Variable | Default | Effect |
|---|---|---|
| `GOOGLE_AI_HOST_HOST` | `127.0.0.1` | TCP host for search + status |
| `GOOGLE_AI_HOST_PORT` | `51784` | TCP port for search + status |
| `GOOGLE_AI_TIMEOUT_MS` | `60000` | Default per-request timeout in ms |
| `GOOGLE_AI_BRIDGE_GRACE_MS` | `30000` | Grace period on top of the timeout (for the bridge's rejection) |

`--timeout-ms <ms>` (or the alias `--timeout <ms>`) overrides `GOOGLE_AI_TIMEOUT_MS` for a single invocation.

Exit codes:

- **0** success
- **1** search/host error, including timeout (`default` → stderr; `--json`/`--raw` → structured stdout)
- **2** usage error (`--help`, bad args, empty query, `--stdin` on TTY) — error message on stderr, no network contact

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

<img width="256" height="384" alt="AnimAIOS mascot" src="https://github.com/user-attachments/assets/8df6553c-e975-4ac4-b32c-fc73cdf0eebd" />

Want to hack on the MCP server or build from source:

```bash
npm install
npm run build     # tsc -> dist/
npm test          # node:test regression suite
```
