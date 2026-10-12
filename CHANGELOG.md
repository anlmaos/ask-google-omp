# Changelog

## [Unreleased]

### Breaking Changes

- The MCP server is gone. `src/index.ts`, the `anima-use-google` bin, the `dist/index.js` path, and the `@modelcontextprotocol/sdk` dependency (92 packages) have been removed. This package is now an oh-my-pi (omp) plugin. `ask_google` keeps its name and its behavior — the browser sidecar and the 127.0.0.1:51784 transport are unchanged — but you consume it via `omp plugin link` instead of an MCP config. Migrate by replacing `claude mcp add ask-google -- npx anima-use-google` with `omp plugin link /path/to/anima-use-google`.

### Added

- oh-my-pi (omp) plugin support: `ask_google` ships as a native omp tool (streaming progress, `approval: "read"`, host socket released on session shutdown) registered from `src/omp-extension.ts` via the `omp.extensions` manifest.
- `NativeMessagingBridge` accepts an `AbortSignal` on `search()`, so an aborted agent operation cancels an in-flight Google AI Mode search instead of waiting out the 90-second bridge ceiling.
- `NativeMessagingBridge` accepts a `log` sink for diagnostic frames and no longer writes to `console.*`, so it is safe to import inside a TUI/rendering host.
- `anima-use-google-cli status` subcommand and host-unreachable diagnostics naming `127.0.0.1:51784`.

### Removed

- MCP server entrypoint (`src/index.ts`), the `anima-use-google` bin, and the `@modelcontextprotocol/sdk` dependency. Transport, browser extension, and native host are unaffected.
- Dead CDP/Chromium driver (`src/cdp.ts`): it referenced a module that does not exist, so `tsc -p .` — and therefore the `prepare` script on install — failed. Nothing referenced it; the browser-sidecar transport is the supported path.
- Stale tests pinned to the removed MCP server (a source-text assertion and a `dist/index.js` orphan check, both now unverifiable).

### Fixed

- `npm install` no longer fails during the `prepare` build step.
- `package.json` `description` now identifies this as an omp plugin rather than an MCP server.
