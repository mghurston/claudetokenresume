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

`claude-watch.ps1` is a no-GUI version that watches a single project from the
command line:

```powershell
powershell -ExecutionPolicy Bypass -File .\claude-watch.ps1 -Project G:\myproject -PollMinutes 30
```

## Caveats

- **Autonomous resume.** The resume runs one long headless turn with no human in
  the loop. Keep the wake prompt scoped and review the saved logs.
- **Weekly caps.** If you have hit a *weekly* limit, a short cooldown wait will
  not help.
- **Rate-limit wording.** Cap detection matches `usage limit / rate limit /
  resets at / 429`. If Claude's live message uses different wording, adjust the
  pattern in `Read-ProbeResult` (UI) / `Test-CapLifted` (CLI).

## Files

| File | Purpose |
|------|---------|
| `claude-watch-ui.ps1` | WinForms GUI (main tool) |
| `Claude Watch.cmd` | Double-click launcher for the GUI |
| `claude-watch.ps1` | CLI-only single-project watcher |
| `projects.txt` | Your saved list of watched project paths (git-ignored) |
| `logs/` | Resume run output (git-ignored) |
