<#
.SYNOPSIS
    Watches for the Claude Code usage-limit cooldown to lift, then auto-continues
    the most recent session headlessly and notifies you (toast + sound).

.DESCRIPTION
    Run this AFTER you hit the usage cap in an interactive session.
    It does NOT estimate tokens (those numbers are unreliable). Instead it PROBES:
    a rate-limited `claude -p` call fails instantly and costs no tokens, so we
    cheaply retry every few minutes until one succeeds -- that success IS the
    signal the rolling window reset. Then it resumes your session with -p.

.PARAMETER Project
    Project directory whose session to resume. Defaults to current directory.

.PARAMETER Prompt
    The "wake up and continue" instruction sent on resume.

.PARAMETER Session
    Specific session id (jsonl filename, no extension) to --resume.
    If omitted, the newest session for -Project is used.

.PARAMETER PollMinutes
    Minutes between probes while still capped. Default 10.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File G:\claudetokenresume\claude-watch.ps1 -Project G:\claudefitness
#>
[CmdletBinding()]
param(
    [string]$Project = (Get-Location).Path,
    [string]$Prompt  = "The usage limit has reset. Continue exactly where you left off. Re-read the last few messages for context, then keep going until the task is done. If anything is ambiguous, make the most reasonable choice and note it.",
    [string]$Session = "",
    [int]   $PollMinutes = 10
)

$ErrorActionPreference = "Stop"
$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) { Write-Error "claude CLI not found on PATH."; exit 1 }

# --- Resolve the session id from the local logs -----------------------------
# Claude flattens the cwd into the projects folder name: ':' '\' '/' all -> '-'
$projectsRoot = Join-Path $env:USERPROFILE ".claude\projects"
$flat = ($Project.TrimEnd('\','/')) -replace '[:\\/]', '-'
$folder = Join-Path $projectsRoot $flat

if (-not $Session) {
    $jsonl = $null
    if (Test-Path $folder) {
        $jsonl = Get-ChildItem $folder -Filter *.jsonl -ErrorAction SilentlyContinue |
                 Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }
    if (-not $jsonl) {
        # Fall back to the newest session anywhere
        $jsonl = Get-ChildItem $projectsRoot -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue |
                 Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }
    if (-not $jsonl) { Write-Error "No session logs found under $projectsRoot"; exit 1 }
    $Session = $jsonl.BaseName
    Write-Host "Using newest session: $Session  (project: $Project)"
} else {
    Write-Host "Using session: $Session  (project: $Project)"
}

$logDir = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp  = Get-Date -Format "yyyyMMdd-HHmmss"
$runLog = Join-Path $logDir "resume-$stamp.log"

# --- Notification helper (native toast, no modules) -------------------------
function Send-Toast([string]$Title, [string]$Text) {
    try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
        $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
                 [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $t = $xml.GetElementsByTagName("text")
        $t.Item(0).AppendChild($xml.CreateTextNode($Title)) | Out-Null
        $t.Item(1).AppendChild($xml.CreateTextNode($Text))  | Out-Null
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Claude Watch").Show($toast)
    } catch {
        # Fallback: balloon tip
        Add-Type -AssemblyName System.Windows.Forms
        $n = New-Object System.Windows.Forms.NotifyIcon
        $n.Icon = [System.Drawing.SystemIcons]::Information
        $n.Visible = $true
        $n.ShowBalloonTip(8000, $Title, $Text, [System.Windows.Forms.ToolTipIcon]::Info)
    }
    [console]::Beep(880,250); [console]::Beep(1175,400)
}

# --- Probe: is the cap still in effect? -------------------------------------
# Returns $true if a minimal call SUCCEEDS (cap lifted), $false if rate-limited.
function Test-CapLifted {
    $out = & $claude -p "Reply with the single word READY." 2>&1 | Out-String
    $script:LastProbe = $out
    if ($out -match '(?i)usage limit|rate limit|limit reached|resets at|too many requests|429') { return $false }
    if ($out -match '(?i)READY')  { return $true }
    # Unknown response: treat non-error text as success rather than spinning forever.
    if ($out.Trim().Length -gt 0) { return $true }
    return $false
}

Write-Host ""
Write-Host "Claude Watch armed. Probing every $PollMinutes min until the usage window resets."
Write-Host "A capped probe costs no tokens. Ctrl+C to stop."
Write-Host ""

while ($true) {
    $now = Get-Date -Format "HH:mm:ss"
    if (Test-CapLifted) {
        Write-Host "[$now] Cap lifted -> resuming session $Session"
        break
    }
    $reset = ""
    if ($LastProbe -match '(?i)resets? at\s+([^\r\n\.]+)') { $reset = " (reset: $($Matches[1].Trim()))" }
    Write-Host "[$now] Still capped$reset. Sleeping $PollMinutes min."
    Start-Sleep -Seconds ($PollMinutes * 60)
}

# --- Resume headlessly, capture output, notify ------------------------------
Push-Location $Project
try {
    Send-Toast "Claude resuming" "Window reset. Continuing session $Session..."
    "=== Resume $stamp | session $Session | project $Project ===" | Out-File $runLog -Encoding utf8
    & $claude -p --resume $Session $Prompt 2>&1 | Tee-Object -FilePath $runLog -Append
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($code -eq 0) {
    Send-Toast "Claude finished" "Resumed run complete. Log: $runLog"
    Write-Host "Done. Output saved to $runLog"
} else {
    Send-Toast "Claude resume issue" "Exit code $code. Check $runLog"
    Write-Host "Resume exited with code $code. See $runLog"
}
