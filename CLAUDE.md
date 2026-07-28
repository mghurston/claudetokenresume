# CLAUDE.md

Guidance for working on this repo (Claude Token Resume / "Claude Watch").

## What this project is

**Two** tools that solve the same problem — Claude Code stopping at a usage
limit — sharing one cap-detection model:

1. **Claude Watch** (`claude-watch-ui.ps1`) — a small, dependency-free
   **Windows** WinForms utility that waits out the **usage-limit cooldown** and
   **auto-continues** the user's work by reopening each session in its own
   **visible terminal** (`claude --resume <id>`), with toast + sound. The user
   can arm it *before* hitting the cap (it stays armed and keeps polling); it
   detects when the window resets and resumes the selected project(s) in windows
   the user can watch and drive.
2. **Claude CLI Studio** (`claudewebui/`) — a local, cross-platform **web UI**
   for Claude Code on the Agent SDK, carrying its own copy of the watch. A
   parked turn is released into the conversation already open in the browser.

These are personal tools, not libraries. Prioritize: never act surprisingly (no
runaway autonomous runs), never freeze the UI, and never interfere with the
user's real interactive Claude Code sessions.

**The audience is not necessarily technical.** Both are launched by
double-clicking an icon. Any failure whose only exit is "open a terminal and
run…" is a bug — see the port-conflict and Restart notes below for the shape of
the fix that is expected here.

## How it works (the important mental model)

- **Read the limit, don't parse text.** Detection makes a minimal
  `POST /v1/messages` (max_tokens 1) using the OAuth token Claude Code stores in
  `~/.claude/.credentials.json`, then reads the **unified rate-limit response
  headers** — the same data behind the Claude app's Usage panel:
  `anthropic-ratelimit-unified-5h-status` (`allowed` vs capped) and
  `anthropic-ratelimit-unified-5h-reset` (exact reset, unix secs). While capped
  the call returns **HTTP 429 and costs nothing**, but the reset header is still
  present — so the tool learns *precisely* when to resume. An earlier design
  shelled `claude -p` and regex-matched its stdout for "usage limit" wording;
  that silently broke because the live text said "session limit / resets
  12:40pm". **Do not go back to text-parsing.**
- **Account-wide cap.** A single check covers every selected project.
- **Do NOT write to `.credentials.json`.** We only *read* the token. Claude
  Code's refresh tokens rotate, so refreshing + writing back could invalidate
  the user's login. For long waits the tool instead records the reset epoch from
  the first valid check and falls back to **time-based waiting** if the token
  later expires (401 -> `unknown`); the resume itself runs through the `claude`
  CLI, which manages its own auth.
- **Resume only on a real capped -> lifted transition.** `$script:SawCap` must
  become true (an observed capped check) before any resume can fire. **Do not
  regress this** — an early version resumed immediately when started while not
  capped, which was the worst bug. The tool can be *armed before* the cap: if the
  first check shows "not capped" it stays in `waiting` and keeps polling (it does
  NOT stop, and does NOT resume) until a real cap is observed, then waits for the
  lift. A fatal login error (unreadable credentials / no token) still stops with
  a dialog, since arming is pointless without a readable token.
- **Everything is async.** The limit check and resume run as PowerShell
  background jobs polled by a `System.Windows.Forms.Timer`. Nothing blocks the UI
  thread. Do not put synchronous `Invoke-WebRequest`/`& claude ...` calls on the
  UI thread — that froze the window so it couldn't be closed.

## Files

| File | Purpose |
|------|---------|
| `claude-watch-ui.ps1` | WinForms GUI — the main tool |
| `Claude Watch.cmd` | Double-click launcher (`%~dp0`-relative; rename-safe) |
| `CLAUDE.md` / `README.md` | Docs |
| `logs/` | Generated `resume-*.cmd` launchers — git-ignored, embed the wake prompt |
| `claudewebui/` | Claude CLI Studio — the web UI, with its own copy of the watch |
| `Claude Studio.cmd` / `.command` | Double-click launchers for Studio (Windows / macOS) |
| `.gitattributes` | Pins `*.cmd`/`*.bat` to CRLF and `*.command`/`*.sh` to LF |

## Architecture of the GUI (`claude-watch-ui.ps1`)

State machine driven by one timer. Phases: `idle -> probing -> waiting ->
probing -> ... -> (capped->lifted) -> open resume windows -> RE-ARM (back to
waiting) -> ...`. The watch **loops through every cap cycle** so it can run
unattended for a full day: after launching the resume windows it resets
`$script:SawCap` and returns to `waiting` instead of going idle, so it rides out
the next cap too. Only **Stop** or closing the window ends the run. There is no
`resuming` polling phase: the launched terminals run independently of the GUI,
and each re-arm re-resolves the project's newest session id (a prior resume may
have advanced the conversation into a new jsonl).

- **Explicit project list, NOT auto-discovery.** The user adds project folders
  via the Add button; paths persist to `projects.txt` (git-ignored). An earlier
  version auto-listed every folder under `%USERPROFILE%\.claude\projects`, which
  surfaced every cwd Claude had ever run from (`C:\Windows\System32`, drive
  roots, `Documents`, etc.) — privacy noise. **Do not bring auto-discovery
  back.** `Get-ConfigPaths`/`Save-Config` manage the list; `Resolve-Project`
  maps each path to its newest session id (jsonl filename, used with
  `claude --resume <id>`) and reports "(no Claude session yet)" if none, which
  the start guard blocks.
- `Start-Probe` — async limit check. Background job reads the OAuth token, calls
  `/v1/messages`, and emits one-line JSON `{ status; reset; http; detail }` where
  `status` is `capped` / `lifted` / `unknown`. `Invoke-Tick`'s `probing` branch
  parses it and (when capped) waits until `reset` (+30s), re-polling at most
  every `num` minutes.
- `Start-Resumes` — for each ticked project, writes a tiny generated
  `logs\resume-*.cmd` launcher (`cd` to the project, then `claude --resume
  <session> [--permission-mode <mode>] "<prompt>"`) and `Start-Process`es it so
  each session reopens in its **own visible terminal window** — interactive, not
  headless `claude -p`. The `<mode>` comes from the Permissions dropdown
  (`acceptEdits` default / `bypassPermissions` / `default`); an unattended resume
  needs at least `acceptEdits` or it stalls at the first tool-permission prompt
  (that was the empty-log bug). These windows are the user's to drive — the tool
  never closes them (`Clear-Jobs`/`FormClosing` only touch the probe job). After
  launching, it **re-arms** (resets `SawCap`/`ResetEpoch`, returns to `waiting`)
  rather than calling `Stop-Watch`, so the run continues across caps; it
  re-resolves each project's newest session per cycle so a moved-on conversation
  still resumes correctly. Each cap cycle opens a fresh window (stale ones from
  earlier cycles can be closed manually).
- `Invoke-Tick` — the state machine body.
- `Clear-Jobs` — stops/removes **only this tool's** jobs. Called by both the
  Stop button and `FormClosing`. **Never kill `claude` by process name** — that
  would kill the user's real Claude Code sessions.

## Claude CLI Studio (`claudewebui/`)

A local web UI for Claude Code, built on `@anthropic-ai/claude-agent-sdk`. It
carries its own copy of the watch, with two differences that matter:

- **It resumes in-app, not in a terminal.** A parked turn is released through
  the same `claude.sendMessage()` the composer uses, so the answer streams into
  the conversation you already have open. No generated `.cmd`, no
  `logs/`, no stale windows, and the `acceptEdits` footgun is gone because
  prompts render in the browser.
- **Detection is mostly free.** The SDK streams `rate_limit_event`
  (`SDKRateLimitEvent`, part of the `SDKMessage` union) on any live query, with
  status, reset, and utilization. `src/limit-watch.mjs` prefers that and only
  falls back to its own header probe while a turn is queued *and* no session is
  running to report in — runners self-dispose after 15 min idle, so the SDK feed
  goes quiet exactly then.

Typing while a turn runs is **not** an error — it maps onto the CLI's own
command queue via `priority` on the pushed `SDKUserMessage`:

- `'next'` — runs when the current turn ends. This is plain type-ahead, shown in
  the browser as a greyed bubble with a Queued tag.
- `'now'` — `/btw`. Folds into the turn in flight. The CLI does this by aborting
  the running turn and re-running it with the note included, which surfaces as
  an `error_during_execution` result. **That is bookkeeping, not a failure** —
  `handleMessage` suppresses it while a `'now'` message is pending, or every
  side question would look like a crash.

Model, effort and permission mode are only applied when nothing is running;
they take effect immediately, so applying them for a message that has not
started would silently re-steer the turn already on screen.

A queued message cannot be cancelled: the protocol has `cancel_async_message`
and `interrupt`'s `cancel_queued`, but the SDK's public `Query` API exposes
neither. Do not add a Cancel button until it does.

### Slash commands and `/login`

Ordinary slash commands need **no** special handling — `/context`, `/model`,
`/usage`, skills and plugin commands all reach the CLI as plain prompt text and
come back as an assistant message. Verified live. Do not add interception for
them.

`/login` and `/logout` are the exception: they are **absent from
`supportedCommands()`**, and sending `/login` as text makes the CLI answer
"/login isn't available in this environment" — the flow belongs to the
interactive terminal. So `studioCommands` in `app.js` intercepts three account
commands (`/login`, `/whoami`, `/logout`) and Studio answers them itself.

The login runs on control requests that exist on the runtime `Query` object but
are **not in `sdk.d.ts`**: `claudeAuthenticate(true)` -> `{manualUrl,
automaticUrl}`, then `claudeOAuthWaitForCompletion()` (the CLI listens on its
own loopback port for the redirect) or `claudeOAuthCallback(code, state)` (the
user pastes `code#state`). `accountInfo()` *is* public and backs `/whoami`.
Because they are undocumented, every call is capability-checked via
`AuthChannel.supports()` and a missing method raises `UnsupportedByCli`, which
the UI renders as "run `claude /login` in a terminal". **Keep that guard** — an
SDK bump is the expected way this breaks.

One `AuthChannel` spans the whole flow on purpose: the PKCE verifier and
`state` live in the CLI process that issued the URL, so a second process would
reject the callback. After a successful login every session runner is disposed,
since each authenticated when its process spawned and would otherwise keep
using the old account.

**There is no logout control request**, and `/logout` must NOT be faked by
deleting `.credentials.json` — same rule as everywhere else in this repo. It
tells the user to run `claude /logout`.

### Getting into Studio (do not re-break this)

The browser is authorized by a launch nonce written to a `0700` directory and
swapped for a session token. That handoff used to be **single-use with a
two-minute expiry**, and the token lived in **`sessionStorage`** — so closing
the tab, or opening `127.0.0.1:4174` from history or a second browser, left
every request 401ing with **no way to authenticate and no login surface**. Only
restarting the server helped. Now: the nonce stays redeemable for the server's
lifetime, the token lives in `localStorage`, and a 401 clears the dead token
and shows `#signinOverlay` explaining what to do. **Do not reintroduce
single-use or the expiry.**

The launcher could not deliver that restart either, because `npm start` hit
`EADDRINUSE` against the server still holding the port and died before printing
anything — the "flashes open then closes" symptom, a *different* cause from the
earlier CRLF bug. `resolvePortConflict` now identifies what holds the port and
offers the choice in the launcher console. `runtime.json` (pid, port, origin,
launch nonce) is written only after `listen` succeeds so a loser never clobbers
the winner, and stale `launch-<pid>` directories from killed servers are pruned
at startup.

**A 401 is never a retry.** The token cannot be re-minted from the browser, so
retrying is guaranteed to fail forever — it must raise `#signinOverlay`
instead. Two places got this wrong and both stranded the user with no
explanation: `connectEventStream` retried `/api/events` on 401 in an infinite
backoff loop (hundreds of silent console errors while the page merely looked
"disconnected"), and `restartStudio` treated a 401 on `POST /api/restart` as
"the connection dropped because we are restarting" and then waited for a
server that had never been asked to go down. A stale tab against a *live*
server is the common case here, not an exotic one: `serveStatic` reads from
disk per request, so an old server process happily serves the newest `app.js`
— the UI can be newer than the server backing it.

`POST /api/restart` restarts the server from the sidebar button. It answers
**before** tearing down, since the response rides a connection it is about to
close and the browser needs the 202 to start polling the unauthenticated
`/api/ping`. `restartStudio` carries **both** `LAUNCH_TOKEN` and
`SESSION_TOKEN` to the replacement through the env — a fresh session token
would leave the tab that clicked Restart holding a dead one and staring at the
sign-in card, i.e. the exact lockout this all exists to remove. The replacement
inherits stdio rather than detaching, so the launcher window still owns it and
"close this window to stop it" stays true, and `CLAUDE_STUDIO_RESTARTED=1`
stops it opening a second browser tab. `shutdown()` has to `end()` the SSE
clients and `closeAllConnections()` first or `server.close()` never resolves
and the port is never freed.

Static assets are served `no-cache` (revalidate), **not** `max-age`. They used
to be `public, max-age=300`, which meant an upgraded Studio kept serving the
old `app.js` for five minutes — silently defeating the Restart button, since
that is exactly when you restart. Revalidation is free over loopback.

`GET /api/browse` backs the folder picker behind every "folder path" field.
**A browser cannot produce an absolute path** — `showDirectoryPicker` returns a
handle carrying only a name, and a `webkitdirectory` input returns relative
paths — so a local app that needs a real path has to walk the tree server-side.
`browseRoots` probes drive letters in parallel (a disconnected network drive
can stall for seconds); `browseDirectory` returns directory names only, never
file contents. The text field stays alongside Browse — the picker is an
addition, not a replacement. A path that fails to resolve must fall back to the
drive list, or the dialog is a dead end with nothing to click.

`probePortHolder` classifies the port
holder three ways: `current` (answers `/api/ping`), `legacy` (an older Studio —
`/api/ping` predates it, so the request falls to the auth gate and 401s with
Studio's own wording; this is the upgrade case and it must keep working), and
`foreign`. Studio + `runtime.json` offers Open / Close-and-replace / Quit;
`legacy` defaults to replace since there is no nonce to open with.

**Never stop a process that was not positively identified as Studio.** A
`foreign` holder is named and offered the next free port via `findFreePort` +
re-exec instead — killing a guess could take out a database or a dev server.
`askChoice` returns null off a TTY so an unattended start never blocks on a
prompt, and `CLAUDE_STUDIO_ON_CONFLICT` (`open`/`restart`/`port`/`fail`)
answers it for automation. Exit paths go through `exitAfterCleanup`; the
restart path deliberately does not, because that process goes on to serve with
the launch files it already wrote.

The `SawCap` rule is carried over verbatim and is just as load-bearing here: a
queued turn is released only after an observed capped -> lifted transition.
Arming while uncapped must keep waiting, never fire. `src/turn-queue.mjs` keeps
one turn per session and `drain()`s in one step so a second lift signal cannot
double-send. Queued turns are in memory only — deliberately, so draft prompts
never land on disk in a second place with a different lifetime.

## Conventions / gotchas

- Pure Windows PowerShell 5.1 + WinForms. **No external modules** (toasts use the
  native `Windows.UI.Notifications` WinRT API with a NotifyIcon fallback).
- Paths derive from `$PSScriptRoot`, not hardcoded — keep it that way so the
  folder can be renamed/moved freely.
- Cap detection depends on the header names
  `anthropic-ratelimit-unified-5h-status` / `-5h-reset` (and the `-status` /
  `-reset` fallbacks) returned by `POST /v1/messages` for OAuth/subscription
  users. Verified 2026-06-16: `5h-status: allowed|...`, `5h-reset: <unix secs>`,
  plus `-5h-utilization` and `-7d-*` (weekly) that mirror the Usage panel. The
  OAuth call needs the `anthropic-beta: oauth-2025-04-20` header. If Anthropic
  renames these headers, that is the knob to tune.
- **`5h-status: rejected` does NOT by itself mean you are capped.** Verified
  live 2026-07-27: `5h-status: rejected` with `5h-utilization: 1.0` came back on
  an **HTTP 200**, because `overage-in-use: true` and `overage-status: allowed`
  — the window was spent but overage credits were paying for the request. A cap
  is "work is actually being refused": HTTP 429, or a window says `rejected`
  and no overage is covering it. Anything else that reports a status (including
  `allowed_warning`) is still letting work through. Both tools implement this —
  `classifyProbe` in `claudewebui/src/limit-watch.mjs` and the classification
  block in `Start-Probe`. **Keep the two in sync.** The earlier naive
  `-ne 'allowed'` test reported capped whenever overage was carrying you, which
  would resume every project at the next window rollover for no reason.
- The tool also waits on **whichever window is blocking** — `-7d-reset` when the
  weekly cap is the one rejecting work, not always `-5h-reset`.
- **`-utilization` is a fraction, not a percent.** `0.09` is 9%, `1.0` is a
  spent window. Multiply by 100 before showing it.
- The OAuth token is at `~/.claude/.credentials.json` under
  `claudeAiOauth.accessToken`. Read-only — see "Do not write to .credentials.json".
- After editing, syntax-check with
  `[System.Management.Automation.Language.Parser]::ParseFile(...)` before
  claiming it works. Do not launch the GUI non-interactively — `ShowDialog()`
  blocks.

## Repo

- GitHub: https://github.com/mghurston/claudetokenresume (branch `main`).
- Local path: `G:\claudetokenresume`.
- Author: mghurston — website https://www.michaelghurston.com/, links
  https://linktr.ee/mghurston. The GUI shows both as a clickable banner
  (`$banner` LinkLabel) and the README carries the same attribution; keep them in
  sync if either URL changes.
