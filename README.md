# Claude Token Resume — Claude Watch &amp; Claude CLI Studio

> **Made by mghurston** · Website: **https://www.michaelghurston.com/** · Links: **https://linktr.ee/mghurston**

Two tools for the same problem — Claude Code stopping because you hit a usage
limit:

- **Claude Watch** (`claude-watch-ui.ps1`) — a Windows desktop app that waits out
  the **usage-limit cooldown** and reopens each project in its own visible
  terminal the moment the window resets, with a desktop toast + sound.
- **[Claude CLI Studio](claudewebui/)** (`claudewebui/`) — a local, cross-platform
  **web UI** for Claude Code, with the same watch built in. A turn you send while
  capped parks and releases itself into the conversation you already have open.

## Claude Watch

Arm it **before or after** you hit the cap. It reads your **exact reset time**
from Anthropic's rate-limit data, waits until then, and the moment work is
flowing again it reopens the most recent session of each selected project in its
**own visible terminal**:

```
claude --resume <session-id> [--permission-mode <mode>] "<your wake prompt>"
```

Those windows are yours to watch and drive — this is deliberately **not** a
headless `claude -p` run, so nothing happens out of sight. By default it then
re-arms and rides out the next cap too, so it can run unattended all day.

## Why it works this way

- **Reads the real limit, doesn't guess.** The tool makes a tiny
  `/v1/messages` call with the OAuth token Claude Code already stores, and reads
  the **unified rate-limit headers** — the same data behind the Claude app's
  Usage panel (`Settings → Usage`). That tells it, precisely, whether you're
  capped and the exact time the blocking window resets. While you're capped the
  call is rejected (HTTP 429) and **costs nothing**, but it still reports the
  reset time — so the tool knows exactly when to resume.
- **"Window used up" is not the same as "you're blocked."** If your account has
  overage credits and they're covering your requests, work keeps flowing even
  though the 5-hour window reads as spent — so the tool keeps waiting instead of
  resuming against a limit you never actually hit. It resumes only when work is
  genuinely being refused.
- **Account-wide cap.** One check covers every selected project, so watching 4
  projects costs the same as watching 1.
- **Survives long waits without touching your login.** It records the reset time
  from the first check and waits it out; if the stored token expires meanwhile it
  falls back to that known time. It never rewrites your credentials file (doing
  so could log you out of Claude Code), and the resume runs through the `claude`
  CLI, which refreshes its own auth.
- **Waits on whichever window is blocking.** If the *weekly* limit is the one
  refusing work, it waits for the 7-day reset rather than the 5-hour one, so a
  resume can't fire into a cap that is still in force.
- **Resume-on-transition only.** It resumes *only* after it has observed a real
  capped → lifted transition. Arm it while you are **not** capped and it simply
  stays armed and keeps polling — it will not run anything until it has seen a
  genuine cap and then seen it lift.
- **Rides out every cycle.** After launching the resume windows it re-arms for
  the next cap instead of going idle, so one click covers a whole day. Untick
  **Keep watching after each reset** for a single shot.

## Your credentials stay yours

This repo contains **no API key and no token** — nothing personal is committed,
and nothing ever was (the history is clean). When you run it, the tool reads the
OAuth token from **your own** machine at a path derived from your environment:

```powershell
$credPath = Join-Path $env:USERPROFILE ".claude\.credentials.json"
```

`%USERPROFILE%` resolves to whoever launched the script, so it uses **your**
existing Claude Code login — there is no way to accidentally use anyone else's.
There's no separate API key to set up; if you're signed in to Claude Code, it
just works. The token is **read-only** — neither tool ever writes your
credentials file. Your watched-project list (`projects.txt`) and generated
resume launchers (`logs/`) are git-ignored and never leave your machine.

Studio is the same: it binds to `127.0.0.1` only, launches your locally
installed Claude Code, and stores its own settings under `~/.claude-cli-studio`.
Its `/login` asks the CLI to run its own OAuth flow rather than handling your
credentials itself.

## Requirements

- [Claude Code](https://claude.com/claude-code) CLI on your `PATH`, signed in
- **Claude Watch:** Windows 10/11 and Windows PowerShell 5.1+ (native toasts, no
  modules to install)
- **Claude CLI Studio:** Node.js 20.10+ (Windows, macOS or Linux)

## Usage

Double-click **`Claude Watch.cmd`**, or run:

```powershell
powershell -ExecutionPolicy Bypass -File .\claude-watch-ui.ps1
```

Then:

1. Click **Add project...** and pick each Claude project folder you want to
   watch. Your list is saved to `projects.txt` (git-ignored) and persists
   between runs. **Remove** drops the highlighted row. The tool does **not**
   auto-discover projects — only folders you add ever appear.
2. Tick the project(s) to auto-continue. Each row shows the newest session and
   last activity (or "no Claude session yet" if Claude has never run there).
3. Set **Poll at most every (min)** (default 30) — the tool waits until the known
   reset time, but re-checks at least this often.
4. Pick **Permissions** for the resumed session. `acceptEdits` (the default) keeps
   it moving through file edits but still pauses for risky operations;
   `bypassPermissions` never pauses; `default` prompts for everything — which
   will stall an unattended resume at the first tool prompt.
5. Edit the **wake prompt** if you want.
6. Leave **Keep watching after each reset** ticked to ride out every cap cycle.
7. Click **Start watching**.

On reset it opens a terminal per ticked project and toasts you. Each window runs
a small generated launcher in `logs\resume-*.cmd`; the windows stay open and are
yours to drive. The tool never closes them, and a later cycle opens fresh ones.

### Stopping

- **Stop button** or **closing the window** ends the run and cancels the limit
  check. Only the job *this tool* started is touched — your real interactive
  Claude Code sessions, and the resume terminals it opened, are never killed.

## Caveats

- **Unattended resume.** The resumed session runs with whatever Permissions mode
  you picked and no one necessarily watching. Keep the wake prompt scoped, and
  prefer `acceptEdits` over `bypassPermissions` unless you trust the folder.
- **Login required.** Detection reads your OAuth token from
  `~/.claude/.credentials.json`. If you're signed out, it can't check the limit;
  run `claude` once to sign in.

## Troubleshooting

- **"running scripts is disabled"** — launch via `Claude Watch.cmd`, or include
  `-ExecutionPolicy Bypass` as shown above. The scripts are not signed.
- **It says "Armed" and nothing happens** — that is correct when you are not
  capped yet. It stays armed and keeps polling; it resumes only after it has
  seen a real cap and then seen it lift.
- **It keeps waiting even though the 5-hour window looks spent** — if overage
  credits are covering your requests, work is still flowing, so there is no cap
  to wait out. It resumes only when work is genuinely being refused.
- **No toast appears** — Focus Assist / Do Not Disturb suppresses Windows
  notifications. You will still hear the two beeps. (The tool falls back to a
  tray balloon if the toast API is blocked.)
- **A row shows "(no Claude session yet)"** — Claude has never run in that folder,
  so there is nothing to resume. Run `claude` there once, then **Refresh**.
- **"Couldn't read limit status"** — the tool couldn't read your OAuth token or
  reach the API. Run `claude` once to confirm you're signed in, check your
  network, then try again. The log line shows the HTTP detail.

## Claude CLI Studio

A local web UI for Claude Code, in [`claudewebui/`](claudewebui/). Same login,
same `CLAUDE.md`, same tools and permission prompts — in a browser, with your
real transcripts in the sidebar. Double-click **`Claude Studio.cmd`** (Windows)
or **`Claude Studio.command`** (macOS); it needs Node 20.10+ and installs its
dependencies on first run.

It carries the same watch, with two differences that matter:

- **It resumes in-app.** A turn you send while capped parks and then streams
  into the conversation you already have open — no extra terminal, no stale
  windows.
- **Detection is mostly free.** The Agent SDK reports plan limits on any live
  query, so it only falls back to its own probe when a turn is parked and
  nothing is running to report in.

See [`claudewebui/README.md`](claudewebui/README.md) for the full guide —
projects and scanning, attachments, permission prompts, `/login` and the other
slash commands, restarting from the UI, and configuration.

## Files

| File | Purpose |
|------|---------|
| `claude-watch-ui.ps1` | WinForms GUI — the Windows watch tool |
| `Claude Watch.cmd` | Double-click launcher for the watch |
| `claudewebui/` | Claude CLI Studio — the local web UI |
| `Claude Studio.cmd` / `.command` | Double-click launchers for Studio (Windows / macOS) |
| `CLAUDE.md` | Guidance for working on this repo |
| `projects.txt` | Your saved list of watched project paths (git-ignored) |
| `logs/` | Generated resume launchers (git-ignored) |
