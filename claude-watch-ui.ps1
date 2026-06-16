<#
.SYNOPSIS
    GUI for Claude Watch. Pick one or more projects; when the usage-limit window
    resets, each selected project's most recent session is auto-continued
    headlessly and you get a toast + sound.

.NOTES
    The usage cap is account-wide, so a single probe detects the reset for all
    selected projects. A capped probe costs no tokens. Launch with:
      powershell -ExecutionPolicy Bypass -File G:\claudetokenresume\claude-watch-ui.ps1
#>
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
$projectsRoot = Join-Path $env:USERPROFILE ".claude\projects"
$logDir = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$defaultPrompt = "The usage limit has reset. Continue exactly where you left off. Re-read the last few messages for context, then keep going until the task is done. If anything is ambiguous, make the most reasonable choice and note it."

# --- Discover projects from the local session logs --------------------------
function Get-Projects {
    $items = @()
    if (-not (Test-Path $projectsRoot)) { return $items }
    foreach ($dir in Get-ChildItem $projectsRoot -Directory) {
        $j = Get-ChildItem $dir.FullName -Filter *.jsonl -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $j) { continue }
        # Real cwd lives inside the log; fall back to the flattened folder name.
        $cwd = $null
        foreach ($line in (Get-Content $j.FullName -TotalCount 40 -ErrorAction SilentlyContinue)) {
            if ($line -match '"cwd"\s*:\s*"([^"]+)"') { $cwd = ($Matches[1] -replace '\\\\','\'); break }
        }
        if (-not $cwd) { $cwd = $dir.Name }
        # Skip non-project noise (drive roots, system dirs).
        $norm = $cwd.TrimEnd('\','/')
        if ($norm -in @('G:','C:','D:') -or $norm -match '(?i)\\Windows\\System32$') { continue }
        $items += [PSCustomObject]@{
            Path    = $cwd
            Session = $j.BaseName
            Last    = $j.LastWriteTime
            Display = ("{0,-40}  last: {1:MM/dd HH:mm}" -f $cwd, $j.LastWriteTime)
        }
    }
    $items | Sort-Object Last -Descending
}

# --- Native toast (no modules) ---------------------------------------------
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
    } catch { }
    try { [console]::Beep(880,250); [console]::Beep(1175,400) } catch { }
}

# --- Build the window -------------------------------------------------------
$form = New-Object System.Windows.Forms.Form
$form.Text = "Claude Watch"
$form.Size = New-Object System.Drawing.Size(640, 600)
$form.StartPosition = "CenterScreen"
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = "Select the project(s) to auto-continue when the usage window resets:"
$lbl.Location = '15,12'; $lbl.AutoSize = $true
$form.Controls.Add($lbl)

$clb = New-Object System.Windows.Forms.CheckedListBox
$clb.Location = '15,38'; $clb.Size = '595,210'
$clb.CheckOnClick = $true; $clb.DisplayMember = 'Display'; $clb.Font = New-Object System.Drawing.Font("Consolas", 9)
$form.Controls.Add($clb)

$btnRefresh = New-Object System.Windows.Forms.Button
$btnRefresh.Text = "Refresh"; $btnRefresh.Location = '15,254'; $btnRefresh.Size = '90,26'
$form.Controls.Add($btnRefresh)

$lblInt = New-Object System.Windows.Forms.Label
$lblInt.Text = "Check every (min):"; $lblInt.Location = '360,258'; $lblInt.AutoSize = $true
$form.Controls.Add($lblInt)

$num = New-Object System.Windows.Forms.NumericUpDown
$num.Location = '475,256'; $num.Size = '60,24'; $num.Minimum = 5; $num.Maximum = 240; $num.Value = 30
$form.Controls.Add($num)

$lblP = New-Object System.Windows.Forms.Label
$lblP.Text = "Wake prompt sent on resume:"; $lblP.Location = '15,290'; $lblP.AutoSize = $true
$form.Controls.Add($lblP)

$txtPrompt = New-Object System.Windows.Forms.TextBox
$txtPrompt.Location = '15,312'; $txtPrompt.Size = '595,70'
$txtPrompt.Multiline = $true; $txtPrompt.ScrollBars = 'Vertical'; $txtPrompt.Text = $defaultPrompt
$form.Controls.Add($txtPrompt)

$btnStart = New-Object System.Windows.Forms.Button
$btnStart.Text = "Start watching"; $btnStart.Location = '15,392'; $btnStart.Size = '140,32'
$btnStart.BackColor = [System.Drawing.Color]::FromArgb(46,160,67); $btnStart.ForeColor = 'White'
$form.Controls.Add($btnStart)

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Text = "Idle."; $lblStatus.Location = '170,400'; $lblStatus.AutoSize = $true
$form.Controls.Add($lblStatus)

$log = New-Object System.Windows.Forms.TextBox
$log.Location = '15,432'; $log.Size = '595,120'
$log.Multiline = $true; $log.ScrollBars = 'Vertical'; $log.ReadOnly = $true
$log.Font = New-Object System.Drawing.Font("Consolas", 8)
$form.Controls.Add($log)

function Write-Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg
    $log.AppendText($line + "`r`n")
}

function Load-List {
    $clb.Items.Clear()
    foreach ($p in Get-Projects) { [void]$clb.Items.Add($p) }
    Write-Log "Loaded $($clb.Items.Count) project(s)."
}

# --- State machine (all async so the window never freezes) ------------------
# Phases: idle -> probing -> waiting -> probing -> ... -> resuming -> idle
$timer = New-Object System.Windows.Forms.Timer
$script:Watching   = $false
$script:Phase      = 'idle'
$script:SawCap     = $false   # have we OBSERVED a real capped state yet?
$script:ProbeJob   = $null
$script:ResumeJobs = @()

# Stop & remove only THIS tool's jobs (never touches your real claude sessions).
function Clear-Jobs {
    if ($script:ProbeJob) {
        Stop-Job   $script:ProbeJob -ErrorAction SilentlyContinue
        Remove-Job $script:ProbeJob -Force -ErrorAction SilentlyContinue
        $script:ProbeJob = $null
    }
    foreach ($r in @($script:ResumeJobs)) {
        if ($r.Job.State -eq 'Running') {
            Stop-Job $r.Job -ErrorAction SilentlyContinue
            Write-Log "Stopped resume: $($r.Path)"
        }
        Remove-Job $r.Job -Force -ErrorAction SilentlyContinue
    }
    $script:ResumeJobs = @()
}

function Stop-Watch([string]$status) {
    $timer.Stop(); $script:Watching = $false; $script:Phase = 'idle'
    Clear-Jobs
    $btnStart.Text = "Start watching"; $btnStart.BackColor = [System.Drawing.Color]::FromArgb(46,160,67)
    $clb.Enabled = $true; $num.Enabled = $true; $txtPrompt.Enabled = $true; $btnRefresh.Enabled = $true
    $lblStatus.Text = $status
}

# Classify a probe's text output. Returns 'capped', 'lifted', or 'unknown'.
function Read-ProbeResult([string]$out) {
    if (-not $out) { return 'unknown' }
    if ($out -match '(?i)usage limit|rate limit|limit reached|resets? at|too many requests|429') { return 'capped' }
    if ($out -match '(?i)READY') { return 'lifted' }
    if ($out.Trim().Length -gt 0) { return 'lifted' }
    return 'unknown'
}

# Start a quick probe in the background; the timer polls for its result.
function Start-Probe {
    $script:Phase = 'probing'
    $lblStatus.Text = "Checking the cap..."
    $script:ProbeJob = Start-Job -ScriptBlock {
        & claude -p "Reply with the single word READY." 2>&1 | Out-String
    }
    $timer.Interval = 1500   # poll the job, keep UI responsive
    $timer.Start()
}

# Launch the resumes as background jobs (so a long run never freezes the UI).
function Start-Resumes {
    $targets = @($clb.CheckedItems)
    Send-Toast "Claude resuming" "Window reset. Launching $($targets.Count) project(s) in the background..."
    $script:ResumeJobs = @()
    foreach ($p in $targets) {
        $stamp  = Get-Date -Format "yyyyMMdd-HHmmss"
        $runLog = Join-Path $logDir ("resume-{0}-{1}.log" -f ($p.Session.Substring(0,8)), $stamp)
        Write-Log "Launching resume: $($p.Path)"
        $job = Start-Job -ScriptBlock {
            param($dir, $sess, $prompt, $log)
            Set-Location $dir
            "=== Resume $(Get-Date -Format yyyyMMdd-HHmmss) | $dir | session $sess ===" | Out-File $log -Encoding utf8
            & claude -p --resume $sess $prompt 2>&1 | Out-File $log -Append -Encoding utf8
        } -ArgumentList $p.Path, $p.Session, $txtPrompt.Text, $runLog
        $script:ResumeJobs += [PSCustomObject]@{ Job = $job; Path = $p.Path; Log = $runLog }
    }
    $script:Phase = 'resuming'
    $lblStatus.Text = "Resuming $($targets.Count) project(s) in background..."
    $timer.Interval = 4000
    $timer.Start()
}

function Invoke-Tick {
    $timer.Stop()
    if (-not $script:Watching) { return }

    switch ($script:Phase) {

        'probing' {
            if ($script:ProbeJob.State -eq 'Running') { $timer.Start(); return }
            $out = (Receive-Job $script:ProbeJob -ErrorAction SilentlyContinue | Out-String)
            Remove-Job $script:ProbeJob -Force -ErrorAction SilentlyContinue
            $script:ProbeJob = $null
            $script:LastProbe = $out
            switch (Read-ProbeResult $out) {
                'capped' {
                    $script:SawCap = $true
                    $reset = ""
                    if ($out -match '(?i)resets? at\s+([^\r\n\.]+)') { $reset = " (reset: $($Matches[1].Trim()))" }
                    Write-Log "Still capped$reset. Next check in $($num.Value) min."
                    $lblStatus.Text = "Watching. Still capped$reset."
                    $script:Phase = 'waiting'
                    $timer.Interval = [int]$num.Value * 60 * 1000
                    $timer.Start()
                }
                default {
                    # 'lifted' (or unknown-but-responsive)
                    if (-not $script:SawCap) {
                        Write-Log "Not currently rate-limited - nothing to resume."
                        Stop-Watch "Not rate-limited - idle."
                        [System.Windows.Forms.MessageBox]::Show(
                            "You are NOT currently hitting the usage limit, so there is nothing to wait for.`n`nStart Claude Watch only AFTER you have hit the cap in a session. It will then wait for the window to reset and continue your selected project(s).",
                            "Nothing to resume", 'OK', 'Information') | Out-Null
                        return
                    }
                    Write-Log "Cap lifted -> resuming."
                    Start-Resumes
                }
            }
        }

        'waiting' {
            Start-Probe   # interval elapsed; probe again
        }

        'resuming' {
            $running = @($script:ResumeJobs | Where-Object { $_.Job.State -eq 'Running' })
            if ($running.Count -gt 0) {
                $lblStatus.Text = "Resuming... $($running.Count) still running."
                $timer.Start(); return
            }
            foreach ($r in $script:ResumeJobs) {
                Receive-Job $r.Job -ErrorAction SilentlyContinue | Out-Null
                Remove-Job $r.Job -Force -ErrorAction SilentlyContinue
                Write-Log "Finished: $($r.Path) -> $($r.Log)"
            }
            $n = $script:ResumeJobs.Count
            $script:ResumeJobs = @()
            Send-Toast "Claude finished" "Resumed $n project(s). Logs in $logDir"
            Stop-Watch "Done. See logs."
            Write-Log "Watch complete."
        }
    }
}

$timer.Add_Tick({ Invoke-Tick })

$btnStart.Add_Click({
    if ($script:Watching) {
        Stop-Watch "Stopped."; Write-Log "Stopped by user. All background jobs cancelled."
        return
    }
    if (-not $claude) { [System.Windows.Forms.MessageBox]::Show("claude CLI not found on PATH."); return }
    if (@($clb.CheckedItems).Count -eq 0) { [System.Windows.Forms.MessageBox]::Show("Tick at least one project."); return }

    $script:Watching = $true
    $script:SawCap   = $false
    $btnStart.Text = "Stop"; $btnStart.BackColor = [System.Drawing.Color]::FromArgb(207,34,46)
    $clb.Enabled = $false; $num.Enabled = $false; $txtPrompt.Enabled = $false; $btnRefresh.Enabled = $false
    Write-Log "Watching $(@($clb.CheckedItems).Count) project(s), checking every $($num.Value) min."
    # First probe confirms you are actually capped. If not, it tells you and stops.
    Start-Probe
})

$btnRefresh.Add_Click({ Load-List })

# Closing the window cancels anything this tool started (your real claude
# sessions are untouched).
$form.Add_FormClosing({ $timer.Stop(); Clear-Jobs })

Load-List
[void]$form.ShowDialog()
