# CLAUDE.md

Guidance for working on this repo (Claude Token Resume / "Claude Watch").

## What this project is

A small, dependency-free **Windows** utility that waits out the Claude Code
**usage-limit cooldown** and then **auto-continues** the user's work by reopening
each session in its own **visible terminal** (`claude --resume <id>`), with
desktop toast + sound notifications. The user can arm it *before* hitting the cap
(it stays armed and keeps polling); it detects when the rolling usage window
resets and resumes the selected project(s) in windows the user can watch / drive.

This is a personal tool, not a library. Prioritize: it must never act
surprisingly (no runaway autonomous runs), the GUI must never freeze, and it
must never interfere with the user's real interactive Claude Code sessions.

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
| `logs/` | Resume run output — git-ignored, may contain session content |

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
