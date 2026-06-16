# CLAUDE.md

Guidance for working on this repo (Claude Token Resume / "Claude Watch").

## What this project is

A small, dependency-free **Windows** utility that waits out the Claude Code
**usage-limit cooldown** and then **auto-continues** the user's work headlessly,
with desktop toast + sound notifications. The user runs it *after* hitting the
cap; it detects when the rolling usage window resets and resumes the selected
project(s).

This is a personal tool, not a library. Prioritize: it must never act
surprisingly (no runaway autonomous runs), the GUI must never freeze, and it
must never interfere with the user's real interactive Claude Code sessions.

## How it works (the important mental model)

- **No token estimation.** Plan-limit token math is unreliable. Instead the tool
  *probes*: a rate-limited `claude -p` call fails instantly and **costs no
  tokens**, so it retries on an interval until one succeeds. That success is the
  signal the window reset.
- **Account-wide cap.** A single probe covers every selected project.
- **Resume only on a real capped -> lifted transition.** `$script:SawCap` must
  become true (an observed capped probe) before any resume can fire. If the
  first probe shows "not capped", the tool tells the user there's nothing to
  wait for and stops. **Do not regress this** — an early version resumed
  immediately when started while not capped, which was the worst bug.
- **Everything is async.** Probe and resume run as PowerShell background jobs
  polled by a `System.Windows.Forms.Timer`. Nothing blocks the UI thread. Do not
  reintroduce synchronous `& claude ...` calls on the UI thread — that froze the
  window so it couldn't be closed.

## Files

| File | Purpose |
|------|---------|
| `claude-watch-ui.ps1` | WinForms GUI — the main tool |
| `Claude Watch.cmd` | Double-click launcher (`%~dp0`-relative; rename-safe) |
| `CLAUDE.md` / `README.md` | Docs |
| `logs/` | Resume run output — git-ignored, may contain session content |

## Architecture of the GUI (`claude-watch-ui.ps1`)

State machine driven by one timer. Phases: `idle -> probing -> waiting ->
probing -> ... -> resuming -> idle`.

- **Explicit project list, NOT auto-discovery.** The user adds project folders
  via the Add button; paths persist to `projects.txt` (git-ignored). An earlier
  version auto-listed every folder under `%USERPROFILE%\.claude\projects`, which
  surfaced every cwd Claude had ever run from (`C:\Windows\System32`, drive
  roots, `Documents`, etc.) — privacy noise. **Do not bring auto-discovery
  back.** `Get-ConfigPaths`/`Save-Config` manage the list; `Resolve-Project`
  maps each path to its newest session id (jsonl filename, used with
  `claude --resume <id>`) and reports "(no Claude session yet)" if none, which
  the start guard blocks.
- `Start-Probe` / `Read-ProbeResult` — async probe + classifier returning
  `capped` / `lifted` / `unknown`.
- `Start-Resumes` — launches one background job per ticked project running
  `claude -p --resume <session> <prompt>`, output to `logs\resume-*.log`.
- `Invoke-Tick` — the state machine body.
- `Clear-Jobs` — stops/removes **only this tool's** jobs. Called by both the
  Stop button and `FormClosing`. **Never kill `claude` by process name** — that
  would kill the user's real Claude Code sessions.

## Conventions / gotchas

- Pure Windows PowerShell 5.1 + WinForms. **No external modules** (toasts use the
  native `Windows.UI.Notifications` WinRT API with a NotifyIcon fallback).
- Paths derive from `$PSScriptRoot`, not hardcoded — keep it that way so the
  folder can be renamed/moved freely.
- Cap-detection wording lives in `Read-ProbeResult`:
  `usage limit | rate limit | resets at | 429`. The exact live
  rate-limit text is unverified; if it differs, this regex is the one knob to
  tune.
- After editing, syntax-check with
  `[System.Management.Automation.Language.Parser]::ParseFile(...)` before
  claiming it works. Do not launch the GUI non-interactively — `ShowDialog()`
  blocks.

## Repo

- GitHub: https://github.com/mghurston/claudetokenresume (branch `main`).
- Local path: `G:\claudetokenresume`.
