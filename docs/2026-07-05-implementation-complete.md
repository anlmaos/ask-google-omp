Build is complete. Files:

- `mcp-server/` - TS MCP server (`npm install && npm run build` -> `dist/`)
- `native-host/host.js` - stdin/stdout <-> localhost TCP bridge; `install-host.cjs` registers Firefox native messaging manifest
- `extension/` - Firefox MV3 sidecar with content.js parser (ported SERPO method from ref repo), web-ext lint clean

Verified: tsc clean, web-ext lint 0 errors/warnings, host.js listens on 127.0.0.1:51784 and accepts framed requests, install-host.cjs wrote the manifest to `~/.mozilla/native-messaging-hosts/com.google.ai.search.json`.

Next steps for user: `npm install && npm run build` in mcp-server, run `node native-host/install-host.cjs`, load the extension, then `claude mcp add google-ai-search node /<absolute>/mcp-server/dist/index.js`.
