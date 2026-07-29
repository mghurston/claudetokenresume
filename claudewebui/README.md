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
- Queue a message to send itself when your usage limit resets
- Live 5-hour and weekly usage meter in the sidebar
- Slash commands, including `/login` and `/whoami` for your Claude account
- Browse to project folders instead of typing absolute paths
- Restart the server from the sidebar, without touching a terminal
- Rename and delete sessions — both write through to the real transcript
- Light/dark themes, responsive layout

## Requirements

- **Node.js 20.10+**
- **Claude Code** installed and logged in (`claude /login`)

## Install and run

Double-click **`Claude Studio.cmd`** (Windows) or **`Claude Studio.command`**
(macOS) in the folder above this one. Either one installs dependencies on first
run, starts the server, and opens your browser.

**Closing the launcher window does not stop Studio** — it runs in the
background on purpose, so a stray window close can't kill Claude mid-task.

**Closing the Studio window does stop it**, like any application — with one
exception: if Claude is still working, or messages are parked waiting for your
usage window to reset, Studio keeps running and tells you so. Reloading the
page is not closing.

You can also stop it with the **Quit** button at the bottom of the sidebar, or
by running the launcher again and choosing **Stop it**.

Running the launcher while Studio is already up offers to open it, stop it, or
replace it — it never just fails.

On macOS, Finder needs the executable bit once:

```bash
chmod +x "Claude Studio.command"
```

Or from a terminal:

```bash
cd claudewebui
npm install
npm start
```

Studio opens an authenticated browser tab at <http://127.0.0.1:4174> and then
detaches, so the terminal is free. Its output goes to
`~/.claude-cli-studio/studio.log`. Use `npm run server` instead if you want it
in the foreground with `Ctrl+C` to stop it.

## Being told when something happens

Studio is meant to be left alone, so it tells you when Claude **finishes**, when
Claude **needs a permission**, and when a queued message wakes up — with a system
notification, a short chime, and a count in the window title.

It stays quiet while you are actually looking at it. The bell at the bottom of
the sidebar silences it.

A permission prompt no longer expires while nothing is connected. Close the
window mid-task and the prompt is still waiting when you come back.

Queued messages survive Quit, Restart and a reboot — they are saved to
`~/.claude-cli-studio/queue.json` and picked up on the next start.

## Usage

The meter at the bottom of the sidebar shows how much of your 5-hour window is
spent. Click it for both windows — 5-hour and weekly — with each one's exact
reset time and a countdown, plus a Refresh button.

Studio checks once at startup and then rides on what live turns report. It does
not poll: a check is a real API call against your own usage window, so polling
it to keep a bar up to date would spend the thing it is measuring.

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

## Choosing folders

Anywhere Studio asks for a folder — **Scan local folder** and **Add project** —
type the path or hit **Browse…** and walk there: pick Home or a drive,
double-click down through the folders, then **Use this folder**.

Browsing is served by Studio itself, because a browser cannot hand back a real
absolute path (`showDirectoryPicker` gives a handle with only a name, and a
directory file input gives relative paths). The picker lists directory names
only, never file contents, and it sits behind the same session token as the
rest of the API.

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

**Changing the mode takes effect immediately, including in the middle of a
turn.** Pick Autopilot while Claude is working and the turn stops asking from
that moment on — and any prompt already on screen is approved for you, so you
can set it and walk away without leaving a dialog waiting on a click that never
comes. Your choice is remembered across reloads.

`scripts/e2e-permission-mode.mjs` proves this end to end against a real server
and a real CLI. It spends real tokens, so it is not part of `npm test`.

`AskUserQuestion` is disabled, so Claude asks follow-up questions as ordinary
chat messages instead of stalling on a dialog the browser cannot render.

## Slash commands

Type them in the composer as you would in the terminal. `/context`, `/model`,
`/usage`, `/compact`, your own skills and plugin commands all reach the CLI as
ordinary prompt text and answer in the conversation.

Three account commands are Studio's own, because the CLI reserves them for the
interactive terminal and answers "isn't available in this environment" if you
send them through:

| Command | What it does |
| --- | --- |
| `/login` | Runs Claude Code's OAuth flow and opens the authorize page. The card finishes by itself when you approve, or you can paste the `code#state` from the manual page. |
| `/whoami` | Shows the account, plan, and organization the CLI is using |
| `/logout` | Points you at `claude /logout` — there is no logout control request, and Studio will not edit your credentials file itself |

`/login` reaches the CLI through control requests that are not part of the
SDK's published types, so a future SDK release could remove them. If that
happens, the card says so and tells you to run `claude /login` in a terminal
instead of failing obscurely.

## Typing while Claude works

You don't have to wait for a turn to finish. Keep typing and send — the message
shows up greyed out with a **Queued** tag and runs the moment the current turn
ends. Same as the terminal.

`/btw <something>` interjects instead of waiting. The note folds into the turn
already running, so the answer accounts for what you just said — use it to
redirect Claude mid-flight ("/btw skip the tests for now"). It only applies
while something is running.

Both ride the CLI's own command queue, so a queued message behaves exactly as it
does in the terminal. One limitation: a queued message **cannot be cancelled**.
The CLI protocol supports it but the Agent SDK does not expose the call, so
there is no honest Cancel button to offer. **Stop** aborts the running turn; a
message already queued behind it still runs.

## Waiting out the usage limit

Hit your limit mid-thought? Write the message you want run next, click **Queue
for reset**, and send. Nothing goes out; the turn parks, and the note under the
composer counts down to the reset. When the window turns over, Studio sends it
into that same conversation and the answer streams in like any other turn — no
terminal window, no separate tool.

Queue as many conversations as you like. One reset releases all of them, each
with its own message, each in its own project folder.

- **It only fires after a real cap.** Arming while your limit is fine is fine —
  the turn simply waits until you actually hit a limit and it lifts. It will
  never fire just because you happen to be under the limit right now.
- **The banner always names the permission mode** the queued turn will run
  under, because it fires while you are not watching.
- **One queued turn per conversation.** Queueing again replaces it, so a waking
  session can't fire a backlog.
- **Cancel any time** from the composer note, or by deleting the conversation.
- Queued turns live in memory. Restarting the server clears them.

The sidebar meter shows how much of the 5-hour and weekly windows you have used.
It reads the rate-limit information Claude Code already reports on any live
session, which costs nothing. Studio only makes its own limit check while
something is queued and no session is running to report in — and that check is a
1-token request that is free while you're capped.

Note that a spent 5-hour window is not always a cap: if your account has overage
credits and they're covering the request, work keeps flowing and nothing is
queued or released. The meter shows "on overage" when that's happening.

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
- The launcher mints a nonce in a mode-`0700` directory, exchanged for a
  session token held in port-scoped `localStorage`, so other local services and
  OS users cannot drive your Claude sessions or approve actions. The nonce stays
  redeemable for as long as that server runs, so reopening the tab works; it
  dies with the server, and a token from an earlier run gets you a sign-in card
  rather than a dead page.
- No credentials are copied or stored. Studio launches your locally installed
  Claude Code, which uses your existing login. `/login` asks the CLI to run its
  own OAuth flow; Studio never reads or writes `~/.claude/.credentials.json`.
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
| `CLAUDE_STUDIO_TOKEN` | Advanced: fixed launch nonce when browser opening is disabled |
| `CLAUDE_STUDIO_ON_CONFLICT` | Answer the port-conflict prompt without a console: `open`, `restart`, `port`, or `fail` |
| `CLAUDE_CODE_PATH` | Claude Code executable used for the version check |

With `CLAUDE_STUDIO_OPEN=0`, Studio prints the path to a mode-`0600` launch
file. Open it in the intended browser; it stays valid until the server stops.

`CLAUDE_STUDIO_SESSION_TOKEN` and `CLAUDE_STUDIO_RESTARTED` are set by Studio on
itself when you use the Restart button, so the tab that asked for it stays
signed in. Do not set them by hand.

## Restarting Studio

The circular-arrow button in the sidebar footer restarts Studio's server
without leaving the browser. It confirms first, warning you if a turn is still
running or messages are queued, then waits for the server and reloads itself.

The tab stays signed in across the restart, and conversations are untouched —
they live in `~/.claude`, not in Studio.

## If the port is already in use

Starting Studio a second time never fails with a stack trace. It works out
what is holding the port and asks:

```
Claude CLI Studio is already running on port 4174 (node.exe, pid 20072).

What would you like to do?

  [O] Open the one already running  (press Enter)
  [R] Close it and start this version instead
  [Q] Quit
```

Pick **R** after updating Studio and it closes the old one and takes over — no
Task Manager, no terminal.

If the port belongs to some *other* program, Studio says what it is and offers
to start on the next free port instead. It will not stop a program it could not
identify as Studio, because that could be a database or someone's dev server.

When nothing is attached to answer (a service, a CI run), it falls back to
opening the running Studio, or exits with an explanation.

## Troubleshooting

**"This tab isn't signed in to Studio"** — the tab is holding a token from an
earlier run of the server. Studio hands each browser a token when it launches,
and a restarted server issues a new one. Start **Claude Studio** again; if the
server is still running it opens a fresh, signed-in tab rather than starting a
second copy. Keep working in *that* tab.

This is also what to expect after updating Studio: the page is served from disk
on every request, so a running server happily serves a newer UI than itself. If
the sidebar shows features the server does not have, restart it.

**The launcher window flashes and closes** — it should not; it pauses on every
exit path. If it does, the batch file has lost its CRLF line endings (`cmd.exe`
mis-parses `goto` with LF). `.gitattributes` pins them.

**Restart says Studio has not come back** — check the launcher window; it prints
why the replacement could not start. **Reload now** in the dialog gets you back
to a working page once it is up.

## Architecture

| File | Role |
| --- | --- |
| `server.mjs` | HTTP API, SSE event stream, launch-token auth, folder browsing, restart |
| `src/claude-bridge.mjs` | Long-lived `query()` per session, streaming input, permissions, `/login` |
| `src/session-catalog.mjs` | Reads and normalizes Claude Code transcripts |
| `src/project-catalog.mjs` | Groups sessions into project folders |
| `src/state-store.mjs` | Scan roots, pinned projects, manual moves |
| `src/upload-store.mjs` | Attachment staging and content-block conversion |
| `src/permission-decisions.mjs` | Studio choice → SDK `PermissionResult` |
| `src/limit-watch.mjs` | Plan-limit state, from the SDK feed or its own probe |
| `src/turn-queue.mjs` | Turns parked for the reset, one per session |
| `src/model-info.mjs` | Known models, effort levels, permission modes |
| `src/http-utils.mjs` | Static serving, JSON helpers, security headers |
| `public/` | The UI (no build step, no framework) |

One `SessionRunner` wraps one long-lived `query()` in streaming-input mode. That
keeps the CLI warm between turns and is the only mode where `interrupt()` and
`setModel()` work. Runners are disposed after 15 minutes idle.

## Tests

```bash
npm test
```

83 tests covering transcript normalization, permission mapping, project
grouping, state persistence, attachment conversion, cap classification, the
parked-turn queue, the account login guards, and the message queue that turns a
one-shot query into a multi-turn conversation.
