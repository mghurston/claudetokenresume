# Claude CLI Studio

A local, browser-based workspace for **Claude Code**. It gives you the
chat interface you get from claude.ai, chatgpt.com, or gemini.com — sidebar of past
conversations, drag-and-drop attachments, streaming answers — while running the
same Claude Code CLI, login, `CLAUDE.md`, settings, and permission prompts you
already use in the terminal.

The backend is built on the Claude Agent SDK, so session history, permissions,
and settings come from Claude Code itself rather than from anything Studio
reimplements.

## What it does

- Lists every local Claude Code session, grouped by the project folder it ran in
- Opens any past session and continues it — the same transcript `claude --resume` sees
- Streams responses token by token, with tool activity shown inline
- Drag several files into a conversation at once (images, PDFs, code, text)
- In-app approval for file edits, commands, and network access
- Permission modes: Ask, Plan, Accept edits, Autopilot
- Model and effort pickers, per message
- Rename and delete sessions — both write through to the real transcript
- Light/dark themes, responsive layout

## Requirements

- **Node.js 20.10+**
- **Claude Code** installed and logged in (`claude /login`)

## Install and run

```bash
cd claudewebui
npm install
npm start
```

Studio opens an authenticated browser tab at <http://127.0.0.1:4174>. Keep the
terminal open while using it; `Ctrl+C` stops it.

`npm install` is required: the Claude Agent SDK ships prebuilt CLI binaries for
every platform plus a few peer packages, so `node_modules` lands around 290 MB.

## How it finds your history

Claude Code stores transcripts as JSONL under
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Studio never parses those
files itself — it reads them through the Agent SDK (`listSessions`,
`getSessionMessages`, `renameSession`, `deleteSession`), so a change to that
format is fixed by an SDK upgrade rather than by this app.

Sessions are grouped by the folder they ran in:

- Your home directory is a scan root by default.
- **On first launch only**, any other drive that already contains Claude Code
  sessions is adopted as a scan root too — so a projects drive like `G:\` groups
  correctly without configuration.
- **Scan local** adds more folders at any time.
- Sessions whose folder is outside every scan root land in **General**.

Discovery is deliberately bounded by scan roots. Studio does not crawl your
filesystem; it only groups working directories already recorded in your own
Claude Code history.

## Permissions

Studio does not loosen anything. Tool calls route through the SDK's
`canUseTool` callback and surface as a dialog:

| Choice | Effect |
| --- | --- |
| Allow once | Approves this single call |
| Allow for session | Applies the SDK's suggested rule, scoped to `session` |
| Deny | Returns your text to Claude as the reason |

"Allow for session" never writes to `settings.json`, and suggestions that would
flip the whole session into a looser permission mode are dropped — it can stop
Claude asking about *that tool*, never about everything.

Autopilot (`bypassPermissions`) skips prompts entirely, and the composer note
turns red while it is on. Use it only in folders you trust.

`AskUserQuestion` is disabled, so Claude asks follow-up questions as ordinary
chat messages instead of stalling on a dialog the browser cannot render.

## Attachments

Up to 12 files, 30 MB combined, 12 MB each. How each file reaches Claude
depends on its type:

| File | Sent as |
| --- | --- |
| PNG / JPEG / GIF / WebP | Native image block |
| PDF | Native document block |
| Text or code under 256 KB | Inlined in the message, so no `Read` round-trip |
| Anything else | Saved locally and named by path for Claude to open |

Because attachments ride in the message itself, they are part of the real
transcript — reopening a conversation shows the images you sent, and so does
the terminal.

## Data and security

- Binds to `127.0.0.1`; it is not exposed to the network.
- Each launch mints a one-time nonce, exchanged for a session token held in
  port-scoped `sessionStorage`, so other local services and OS users cannot
  drive your Claude sessions or approve actions.
- No credentials are copied or stored. Studio launches your locally installed
  Claude Code, which uses your existing login.
- Studio's own organization data (scan roots, projects, manual moves) and
  uploads live in `~/.claude-cli-studio`.
- Deleting a conversation deletes the real transcript file. It cannot be undone.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CLAUDE_STUDIO_ROOT` | Workspace root for grouping; defaults to the OS home directory |
| `CLAUDE_STUDIO_HOST` | Loopback host only; defaults to `127.0.0.1` |
| `CLAUDE_STUDIO_PORT` | Local HTTP port; defaults to `4174` |
| `CLAUDE_STUDIO_DATA_DIR` | Studio state and upload directory |
| `CLAUDE_STUDIO_OPEN=0` | Do not open the browser automatically |
| `CLAUDE_STUDIO_TOKEN` | Advanced: fixed one-time launch nonce when browser opening is disabled |
| `CLAUDE_CODE_PATH` | Claude Code executable used for the version check |

With `CLAUDE_STUDIO_OPEN=0`, Studio prints the path to a mode-`0600` launch
file. Open it in the intended browser within two minutes; the nonce is consumed
once and the file is deleted.

## Architecture

| File | Role |
| --- | --- |
| `server.mjs` | HTTP API, SSE event stream, launch-token auth |
| `src/claude-bridge.mjs` | Long-lived `query()` per session, streaming input, permissions |
| `src/session-catalog.mjs` | Reads and normalizes Claude Code transcripts |
| `src/project-catalog.mjs` | Groups sessions into project folders |
| `src/state-store.mjs` | Scan roots, pinned projects, manual moves |
| `src/upload-store.mjs` | Attachment staging and content-block conversion |
| `src/permission-decisions.mjs` | Studio choice → SDK `PermissionResult` |
| `public/` | The UI (no build step, no framework) |

One `SessionRunner` wraps one long-lived `query()` in streaming-input mode. That
keeps the CLI warm between turns and is the only mode where `interrupt()` and
`setModel()` work. Runners are disposed after 15 minutes idle.

## Tests

```bash
npm test
```

52 tests covering transcript normalization, permission mapping, project
grouping, state persistence, attachment conversion, and the message queue that
turns a one-shot query into a multi-turn conversation.
