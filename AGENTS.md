# Agent Notes

## Use Google AI Mode For Fresh Research

This repo provides a local MCP tool, `search_google_ai`, that searches Google AI Mode through the user's logged-in browser session. Future Codex agents should treat it as the preferred research path for current external information:

- Browser extension policy and Manifest V3 behavior
- Current API/package documentation
- Release/version state
- Web platform behavior
- Any user query where fresh web context could materially improve the answer

Use it extensively. Google AI Mode searches through this tool are effectively unlimited for normal development/research use. Do not replace local code inspection, tests, or compiler output with search results; use search to fill external/contextual gaps, then verify against the repository.

## Standard Operating Procedure — Local Helper Scripts

The following scripts are installed at `~/.agents/skills/`. Use them when the
situation calls for it. Soft guidance — apply judgment, not dogma.

### auto-execute (plan runner)

`~/.agents/skills/auto-execute/auto-execute.sh`

Use when the user has an implementation plan (Markdown with `### Task N:` headers)
and wants it executed task-by-task in isolated sessions.

CLI binaries: any `claude`-prefixed command name. Pass 1-5 for failover redundancy.


```bash
auto-execute.sh [--max-turns 80] [--task-timeout 600] [--context-limit 100000]
                [--start-task N] [--log-dir logs/auto-execute]
                <claude-binary> [claude-binary-2..5] <plan-input>
```

Plan input: path to plan file, partial match against `docs/plans/`, or `latest` for
most recent.

Behavior: runs each task as `claude -p "/auto-execute task-N.md"`, monitors for
timeout/context-limit, verifies exit+commit+tree-clean after each step, retries
with next binary on failure. Ctrl+C is trapped cleanly.

Do not use for single-shot tasks, exploratory work, or when the user wants to
review each step manually.

### commit (git committer)

`~/.agents/skills/commit/SKILL.md` — Claude Code skill, triggered via `/commit`

Use when the user says "commit" or "save this" or asks for a commit message.
Generates `type: description` format, runs `git diff --staged`, prompts for staging
if nothing staged.

Alternative without skill invocation:

```bash
git diff --staged → git add . → git commit -m "type: description"
```


### humanizer (writer)

`~/.agents/skills/humanizer/SKILL.md` — Claude Code skill, triggered via
`/humanizer`

Use when the user asks to "clean up" writing, "make this sound natural", "de-AI
this", or similar. Applies 25 pattern replacements (significance inflation, copula
avoidance, chatbot artifacts, em dash overuse, etc.) with personality-injection
pass. Repo-agnostic — works on any prose.

### When to invoke automatically

| User says | Invoke |
|-----------|--------|
| "run the plan" / "execute tasks from <file>" | auto-execute |
| "commit this" / "commit changes" | commit skill or manual |
| "fix this text" / "make it sound human" / "de-AI" | humanizer skill |

Platform check: these scripts assume Linux/macOS. On Windows, use PowerShell
equivalents (not yet ported).

## Local Verification Still Wins

Before claiming work is complete, run the relevant local verification:

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

For extension changes, also inspect or test the browser-specific manifest and native-host installer path. Chrome/Chromium/Brave native messaging requires an extension id in `allowed_origins`, so use `native-host/install-chrome-host.cjs --browser <chrome|chromium|brave> --extension-id <id>` after loading the unpacked Chromium extension and obtaining its id.

## Switching Browser Sidecars For E2E Tests

The MCP server talks to whichever native host is listening on `127.0.0.1:51784`. Do not claim a Chrome/Chromium/Brave test passed if a Firefox-started host is still running.

Before switching browsers:

```bash
ps -ef | rg '[n]ative-host/host\.js|[b]rave|[c]hrome|[c]hromium|[f]irefox'
ss -ltnp 'sport = :51784'
```

If the wrong host is active, disable or unload that browser's sidecar extension and stop the stale host process:

```bash
kill <native-host-pid>
```

For Firefox, use:

```bash
node native-host/install-host.cjs
```

Then load `extension/manifest.json` from `about:debugging#/runtime/this-firefox` and restart or reload Firefox.

For Chrome, Chromium, or Brave, load `extension-chromium/` as an unpacked extension, copy the generated extension id, and run:

```bash
node native-host/install-chrome-host.cjs --browser chrome --extension-id <id>
node native-host/install-chrome-host.cjs --browser chromium --extension-id <id>
node native-host/install-chrome-host.cjs --browser brave --extension-id <id>
```

Brave uses the Chromium extension. Its native-messaging registration locations are:

- Linux: `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.google.ai.search.json`
- macOS: `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.google.ai.search.json`
- Windows: `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.google.ai.search`

The installer writes those locations for `--browser brave`; then reload the Brave extension from `brave://extensions`.

After reloading, confirm the active host. A Chromium-based host should show the extension origin as an argument, for example:

```text
node /path/to/native-host/host.js chrome-extension://<extension-id>/
```

Firefox hosts usually do not include that Chrome extension-origin argument.
