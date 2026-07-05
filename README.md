# anima-use-google

MCP server + Firefox sidecar extension that lets AI agents (Claude Code, Cursor, etc.) run [Google AI Mode](https://blog.google/products/search/ai-mode-search/) searches using your **own logged-in Firefox session**, then return the synthesized answer and citations as an MCP tool result.

No headless browser, no stealth tricks, no CAPTCHA fighting. Your real Firefox profile does the work.

## Quickest path (5 minutes)

You need three things: the MCP server, the Firefox native-messaging host, and the Firefox extension. Then wire the server into your agent.

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

The MCP server talks to the sidecar over localhost; it does not bundle Firefox.

### 2. Set up the Firefox sidecar (one-time, non-npm)

The npm tarball ships everything you need. After the first `npx anima-use-google`, the files live in `~/.npm/_npx/<hash>/node_modules/anima-use-google/` - easiest to clone:

```bash
git clone https://github.com/vi70x4/anima-use-google
cd anima-use-google
```

Then:

1. Register the native-messaging host (writes the OS-specific Firefox manifest):

   ```bash
   node native-host/install-host.cjs
   ```

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

### 3. Use it

Ask your agent normally:

> Search Google AI Mode for: Next.js 15 App Router best practices

The agent calls `search_google_ai`, Firefox opens the `udm=50` search in your profile, the extension parses the AI answer with inline `[1][2]` citations, and the agent gets a grounded markdown response.

## How it works

```
Agent (stdio) <---> MCP server <---> localhost TCP <---> host.js
       <---> Firefox native port <---> background script
       <---> opens google.com/search?udm=50&q=...
       <---> content.js parses AI answer + sources
       <---> response back along the same chain
```

Your logged-in Google cookies are reused because the tab is opened in your own profile - if you have AI Mode enabled, it works; CAPTCHAs don't trigger (real user profile, no stealth games).

The multilanguage completion detection (SVG thumbs-up → aria-label → text markers → 40s fallback) and SERPO-style citation parsing are ported from the Battle-tested [google-ai-mode-mcp](https://github.com/PleasePrompto/google-ai-mode-mcp).

## Developers

Want to hack on the MCP server or build from source:

```bash
npm install
npm run build     # tsc -> dist/
npm test          # (none yet, just tsc --noEdit)
npm link          # then `anima-use-google` on PATH
```

Project layout:

- `src/` + `dist/` - TypeScript MCP server publishing as `anima-use-google@0.1.0`.
- `native-host/` - `host.js` bridges Firefox native-messaging <-> localhost TCP; `install-host.cjs` writes the platform manifest; `manifest/*.json.tmpl` is the template.
- `extension/` - Firefox MV3 sidecar. Selector constants live in `extension/src/selectors.js` - update there if Google's AI Mode DOM shifts. No bundled deps.

## Tuning

Cutoff markers (end-of-answer disclaimers, language-aware) and citation selectors are in `extension/src/selectors.js`. If extraction fails on your locale, add your language's markers there.

## License

MIT. See `LICENSE`.
