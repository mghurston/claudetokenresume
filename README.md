# Claude Token Resume (Claude Watch)

> **Made by mghurston** · Website: **https://www.michaelghurston.com/** · Links: **https://linktr.ee/mghurston**

A small Windows tool that waits out the Claude Code **usage-limit cooldown** and
then **auto-continues** your work headlessly, with a desktop toast + sound when
it starts and finishes.

You start it *after* you hit the cap in a session. It reads your **exact reset
time** from Anthropic's rate-limit data, waits until then, and the moment the
window resets it resumes the most recent session of each project you selected by
running:

```
claude -p --resume <session-id> "<your wake prompt>"
```

## Why it works this way

- **Reads the real limit, doesn't guess.** The tool makes a tiny
  `/v1/messages` call with the OAuth token Claude Code already stores, and reads
  the **unified rate-limit headers** — the same data behind the Claude app's
  Usage panel (`Settings → Usage`). That tells it, precisely, whether you're
  capped and the exact time the 5-hour window resets. While you're capped the
  call is rejected (HTTP 429) and **costs nothing**, but it still reports the
  reset time — so the tool knows exactly when to resume.
- **Account-wide cap.** One check covers every selected project, so watching 4
  projects costs the same as watching 1.
- **Survives long waits without touching your login.** It records the reset time
  from the first check and waits it out; if the stored token expires meanwhile it
  falls back to that known time. It never rewrites your credentials file (doing
  so could log you out of Claude Code), and the resume runs through the `claude`
  CLI, which refreshes its own auth.
- **Resume-on-transition only.** It resumes *only* after it has observed a real
  capped → lifted transition. If you start it when you are **not** capped, it
  tells you there is nothing to wait for and stops — it will not run anything.

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
just works. The token is **read-only** — the tool never writes your credentials
file. Your watched-project list (`projects.txt`) and resume output (`logs/`) are
git-ignored and never leave your machine.

## Requirements

- Windows 10/11 (uses native toast notifications; no modules to install)
- [Claude Code](https://claude.com/claude-code) CLI on your `PATH`
- Windows PowerShell 5.1+

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
4. Edit the **wake prompt** if you want.
5. Click **Start watching**.

On reset it resumes each ticked project as a background job, toasts you, and
writes each run to `logs\resume-*.log`.

### Stopping

- **Stop button** or **closing the window** cancels the limit check and any
  in-progress resume jobs. Only jobs *this tool* started are touched — your real
  interactive Claude Code sessions are never killed.

## Caveats

- **Autonomous resume.** The resume runs one long headless turn with no human in
  the loop. Keep the wake prompt scoped and review the saved logs.
- **Weekly caps.** Detection watches the **5-hour session** window. If you've hit
  the separate *weekly* limit, the 5h reset won't lift you, so the resume can
  immediately re-cap. (The weekly status is available in the same headers
  — `anthropic-ratelimit-unified-7d-*` — if you want to extend the tool.)
- **Login required.** Detection reads your OAuth token from
  `~/.claude/.credentials.json`. If you're signed out, it can't check the limit;
  run `claude` once to sign in.

## Troubleshooting

- **"running scripts is disabled"** — launch via `Claude Watch.cmd`, or include
  `-ExecutionPolicy Bypass` as shown above. The scripts are not signed.
- **A dialog says "Nothing to resume."** — you started the watcher while you were
  **not** rate-limited. That is the safety guard working; start it only after you
  hit the cap.
- **No toast appears** — Focus Assist / Do Not Disturb suppresses Windows
  notifications. You will still hear the two beeps, and every run is written to
  `logs\`. (The tool falls back to a tray balloon if the toast API is blocked.)
- **A row shows "(no Claude session yet)"** — Claude has never run in that folder,
  so there is nothing to resume. Run `claude` there once, then **Refresh**.
- **"Couldn't read limit status"** — the tool couldn't read your OAuth token or
  reach the API. Run `claude` once to confirm you're signed in, check your
  network, then try again. The log line shows the HTTP detail.

## Files

| File | Purpose |
|------|---------|
| `claude-watch-ui.ps1` | WinForms GUI (main tool) |
| `Claude Watch.cmd` | Double-click launcher for the GUI |
| `projects.txt` | Your saved list of watched project paths (git-ignored) |
| `logs/` | Resume run output (git-ignored) |
