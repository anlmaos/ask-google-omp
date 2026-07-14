# CLI Client for Harnesses Without MCP Support

## Goal
Create a simple command-line client that invokes the MCP server's `ask_google` tool directly without requiring full MCP client support in the harness/agent.

## Implementation Plan

### 1. Create `src/cli.ts` (new file)
- Uses `@modelcontextprotocol/sdk/client` (already a dependency) to connect directly to the MCP server via stdio
- Accepts command-line arguments:
  - `query` (positional) - the search query string
  - `--timeout-ms <number>` (optional) - timeout for AI response
  - `--stdin` (flag) - read query from stdin for piped usage
- Outputs the markdown result to stdout (or error to stderr)

### 2. Update `package.json` bin entry
- Add `"anima-use-google-cli": "dist/cli.js"` alongside existing `"anima-use-google": "dist/index.js"`

### 3. Update `AGENTS.md` 
- Add a new section "CLI Client for Test Harnesses" explaining:
  - How to use the CLI client directly: `npx anima-use-google <query>` or `echo "query" | npx anima-use-google --stdin`
  - Use case: agents/harnesses that lack MCP support
  - The CLI uses the same underlying MCP SDK but wraps it in a simple interface
- Remove/update the "Codex MCP Workaround" section since we now have a proper CLI

### CLI Usage Examples
```bash
# Basic search
npx anima-use-google "What is quantum computing?"

# With timeout
npx anima-use-google "Latest React features" --timeout-ms 30000

# Piped input
echo "Explain TypeScript 5.5" | npx anima-use-google --stdin
```