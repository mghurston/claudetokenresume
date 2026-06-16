# Claude Token Resume (Claude Watch)

A small Windows tool that waits out the Claude Code **usage-limit cooldown** and
then **auto-continues** your work headlessly, with a desktop toast + sound when
it starts and finishes.

You start it *after* you hit the cap in a session. It cheaply checks whether the
rolling usage window has reset, and the moment it has, it resumes the most recent
session of each project you selected by running:

```
claude -p --resume <session-id> "<your wake prompt>"
```

## Why it works this way

- **No token estimation.** Token-count guesses against plan limits are
  unreliable. Instead the tool *probes*: a rate-limited `claude` call fails
  instantly and **costs no tokens**, so it can retry every N minutes until one
  succeeds. That success is the reliable signal the window reset.
- **Account-wide cap.** One probe covers every selected project, so watching 4
  projects costs the same as watching 1.
- **Resume-on-transition only.** It resumes *only* after it has observed a real
  capped → lifted transition. If you start it when you are **not** capped, it
  tells you there is nothing to wait for and stops — it will not run anything.

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
3. Set **Check every (min)** (default 30).
4. Edit the **wake prompt** if you want.
5. Click **Start watching**.

On reset it resumes each ticked project as a background job, toasts you, and
writes each run to `logs\resume-*.log`.

### Stopping

- **Stop button** or **closing the window** cancels the probe and any
  in-progress resume jobs. Only jobs *this tool* started are touched — your real
  interactive Claude Code sessions are never killed.

## CLI-only variant

`claude-watch.ps1` is a no-GUI version that watches a **single** project from the
command line. It is a simple blocking loop — it occupies the terminal until the
cap lifts (or you press **Ctrl+C**).

```powershell
powershell -ExecutionPolicy Bypass -File .\claude-watch.ps1 -Project G:\myproject -PollMinutes 30
```

Parameters: `-Project` (defaults to the current directory), `-Prompt` (the wake
instruction), `-Session` (a specific session id; defaults to the newest for the
project), `-PollMinutes` (default 10).

Two differences from the GUI to be aware of:

- **It assumes you are already capped.** Unlike the GUI, it has no "not currently
  rate-limited" guard — if you start it when you are *not* capped, the first
  probe succeeds and it resumes immediately. Only run it after you have hit the
  cap.
- **Always pass `-Project`.** If the given project has no session log, it falls
  back to the newest session found *anywhere*, which could resume a different
  project. Passing `-Project` (and optionally `-Session`) avoids that.

For everyday use prefer the GUI — it has the not-capped guard, multi-project
support, and never blocks a terminal.

## Caveats

- **Autonomous resume.** The resume runs one long headless turn with no human in
  the loop. Keep the wake prompt scoped and review the saved logs.
- **Weekly caps.** If you have hit a *weekly* limit, a short cooldown wait will
  not help.
- **Rate-limit wording.** Cap detection matches `usage limit / rate limit /
  resets at / 429`. If Claude's live message uses different wording, adjust the
  pattern in `Read-ProbeResult` (UI) / `Test-CapLifted` (CLI).

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
- **Cap not detected / detected wrongly** — see the rate-limit wording caveat
  above; tune the pattern in `Read-ProbeResult`.

## Files

| File | Purpose |
|------|---------|
| `claude-watch-ui.ps1` | WinForms GUI (main tool) |
| `Claude Watch.cmd` | Double-click launcher for the GUI |
| `claude-watch.ps1` | CLI-only single-project watcher |
| `projects.txt` | Your saved list of watched project paths (git-ignored) |
| `logs/` | Resume run output (git-ignored) |
