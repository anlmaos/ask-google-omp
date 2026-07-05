## Fix: `background.js` never sends `run-search` to the content script

### Root cause (confirmed by reading both repos)
`extension/background.js` → `startSearch(requestId, query, timeoutMs)` opens the Google AI Mode tab with `browser.tabs.create()` and registers a watchdog, but **never calls `browser.tabs.sendMessage(tabId, { type: "run-search", ... })`**. The content script (`content.js`) only runs `runSearch()` when its `browser.runtime.onMessage` listener receives `{ type: "run-search" }`. That message never arrives, so `runSearch` never runs, the tab sits idle, and the MCP server times out after 60s. The reference repo (PleasePrompto/google-ai-mode-mcp) doesn't hit this because it uses patchright/Playwright with direct `page.goto()` + in-page evaluation - no message round-trip needed to start work; our sidecar architecture requires that round-trip and we forgot the send.

Secondary bug: even if we add the send, `browser.tabs.create()` resolves before the page finishes loading and before the content script (`run_at: document_idle`) has registered its listener. We must wait for the tab to load (status `complete` via `tabs.onUpdated`, with a ~15s guard) before sending the message.

### Changes (all confined to `extension/background.js`)
1. Rewrite `startSearch`:
   - `browser.tabs.create({ url: searchUrl, active: false })`
   - Set watchdog + `pendingByRequest.set(requestId, { tabId, timeoutMs, watchdog })` as today
   - **NEW**: `await waitForTabLoaded(tab.id, 15000)` - small helper that listens on `browser.tabs.onUpdated` for status `"complete"` for that tab id, with a 15s guard timeout after which it resolves anyway (content scripts at `document_idle` usually register before `complete`, but we don't want to hang forever on a slow page)
   - **NEW**: `await browser.tabs.sendMessage(tab.id, { type: "run-search", requestId, query, timeoutMs })`
   - **NEW**: wrap sendMessage in try/catch - on failure, clear watchdog, drop pendingByRequest entry, remove the tab, and `sendResult(requestId, false, "failed to send run-search to content script: <err>", null, null)`
2. Add helper `waitForTabLoaded(tabId, timeoutMs)` returning a Promise that resolves on `changeInfo.status === "complete"` for that tab, or after `timeoutMs` via setTimeout (cleared on either path; listener removed on resolve)
3. No changes to `content.js`, `host.js`, `src/*`, or `manifest.json` content_scripts section - all correct as-is

### Publish & re-test
- Bump `package.json` and `extension/manifest.json` from `0.1.2` to `0.1.3`
- Run `npx tsc` to rebuild `dist/`
- `npm publish --access public` (user supplies OTP via runtime)
- User reloads the Firefox extension and restarts the MCP harness
- Re-test `google___search_google_ai({query: "what is the capital of France"})` end-to-end; expect parsed markdown with citations and Sources list

### Risk / rollback
- Change is isolated to two functions in `background.js`. Cannot break parser, native-messaging, or extraction.
- Existing watchdog already recovers with an explicit `extension watchdog: no response` error instead of an opaque 60s hang.
- New `sendMessage` catch returns an immediate error if the content script didn't load (region block, AI Mode unavailable, etc.) instead of timing out.
- Worst case revert: restore the old `startSearch` body.