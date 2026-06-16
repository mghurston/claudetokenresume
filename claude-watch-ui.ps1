<#
.SYNOPSIS
    GUI for Claude Watch. Pick one or more projects; when the usage-limit window
    resets, each selected project's most recent session is auto-continued
    headlessly and you get a toast + sound.

.NOTES
    Cap detection reads Anthropic's unified rate-limit headers (the same data
    behind the Claude app's Usage panel) from a tiny /v1/messages call using the
    OAuth token Claude Code already stores. While capped the call returns HTTP
    429 and costs nothing; the headers still report the exact 5h reset time, so
    the tool learns precisely when to resume without parsing terminal text.
    The cap is account-wide, so one check covers all selected projects. Launch:
      powershell -ExecutionPolicy Bypass -File G:\claudetokenresume\claude-watch-ui.ps1
#>
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
$projectsRoot = Join-Path $env:USERPROFILE ".claude\projects"
# Claude Code's OAuth token lives here; we read it to query the limit headers.
$credPath = Join-Path $env:USERPROFILE ".claude\.credentials.json"
$logDir = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Your explicit list of project folders (one per line). NOT auto-discovered.
$configPath = Join-Path $PSScriptRoot "projects.txt"

$defaultPrompt = "The usage limit has reset. Continue exactly where you left off. Re-read the last few messages for context, then keep going until the task is done. If anything is ambiguous, make the most reasonable choice and note it."

# --- Explicit project list (you add the paths; nothing is auto-discovered) ---
function Get-ConfigPaths {
    if (Test-Path $configPath) {
        return @(Get-Content $configPath -ErrorAction SilentlyContinue | Where-Object { $_.Trim() -ne '' })
    }
    return @()
}

function Save-Config($paths) {
    @($paths | ForEach-Object { $_.TrimEnd('\','/') } | Sort-Object -Unique) |
        Set-Content -LiteralPath $configPath -Encoding UTF8
}

# For an explicit project path, find its newest Claude session id (needed for
# --resume). Session is $null if Claude has never run in that folder.
function Resolve-Project([string]$path) {
    $norm = $path.TrimEnd('\','/')
    $flat = $norm -replace '[:\\/]', '-'
    $folder = Join-Path $projectsRoot $flat
    if (-not (Test-Path $folder)) {
        # Fall back to matching the cwd recorded inside each log.
        $folder = $null
        foreach ($d in (Get-ChildItem $projectsRoot -Directory -ErrorAction SilentlyContinue)) {
            $jj = Get-ChildItem $d.FullName -Filter *.jsonl -ErrorAction SilentlyContinue |
                  Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if (-not $jj) { continue }
            foreach ($line in (Get-Content $jj.FullName -TotalCount 40 -ErrorAction SilentlyContinue)) {
                if ($line -match '"cwd"\s*:\s*"([^"]+)"') {
                    if ((($Matches[1] -replace '\\\\','\').TrimEnd('\','/')) -ieq $norm) { $folder = $d.FullName }
                    break
                }
            }
            if ($folder) { break }
        }
    }
    $session = $null; $last = $null
    if ($folder) {
        $j = Get-ChildItem $folder -Filter *.jsonl -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($j) { $session = $j.BaseName; $last = $j.LastWriteTime }
    }
    $disp = if ($session) { "{0,-42}  last: {1:MM/dd HH:mm}" -f $norm, $last }
            else          { "{0,-42}  (no Claude session yet)" -f $norm }
    [PSCustomObject]@{ Path = $norm; Session = $session; Last = $last; Display = $disp }
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
$lbl.Text = "Tick the project(s) to auto-continue when the usage window resets:"
$lbl.Location = '15,12'; $lbl.AutoSize = $true
$form.Controls.Add($lbl)

$clb = New-Object System.Windows.Forms.CheckedListBox
$clb.Location = '15,38'; $clb.Size = '595,210'
$clb.CheckOnClick = $true; $clb.DisplayMember = 'Display'; $clb.Font = New-Object System.Drawing.Font("Consolas", 9)
$form.Controls.Add($clb)

$btnAdd = New-Object System.Windows.Forms.Button
$btnAdd.Text = "Add project..."; $btnAdd.Location = '15,254'; $btnAdd.Size = '110,26'
$form.Controls.Add($btnAdd)

$btnRemove = New-Object System.Windows.Forms.Button
$btnRemove.Text = "Remove"; $btnRemove.Location = '131,254'; $btnRemove.Size = '90,26'
$form.Controls.Add($btnRemove)

$btnRefresh = New-Object System.Windows.Forms.Button
$btnRefresh.Text = "Refresh"; $btnRefresh.Location = '227,254'; $btnRefresh.Size = '90,26'
$form.Controls.Add($btnRefresh)

$lblInt = New-Object System.Windows.Forms.Label
$lblInt.Text = "Poll at most every (min):"; $lblInt.Location = '300,258'; $lblInt.AutoSize = $true
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
    foreach ($p in Get-ConfigPaths) { [void]$clb.Items.Add((Resolve-Project $p)) }
    Write-Log "Loaded $($clb.Items.Count) project(s) from $([System.IO.Path]::GetFileName($configPath))."
}

# --- State machine (all async so the window never freezes) ------------------
# Phases: idle -> probing -> waiting -> probing -> ... -> resuming -> idle
$timer = New-Object System.Windows.Forms.Timer
$script:Watching   = $false
$script:Phase      = 'idle'
$script:SawCap     = $false   # have we OBSERVED a real capped state yet?
$script:ResetEpoch = $null    # unix secs when the 5h window resets (from headers)
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
    $clb.Enabled = $true; $num.Enabled = $true; $txtPrompt.Enabled = $true
    $btnRefresh.Enabled = $true; $btnAdd.Enabled = $true; $btnRemove.Enabled = $true
    $lblStatus.Text = $status
}

# Check the live limit status by reading Anthropic's unified rate-limit headers
# off a minimal /v1/messages call. Runs in a background job (keeps the UI free)
# and emits a one-line JSON result: { status; reset; http; detail }.
#   status: 'capped' | 'lifted' | 'unknown'
#   reset : unix secs the 5h window resets (from anthropic-ratelimit-unified-5h-*)
# While capped the call is rejected with HTTP 429 (no token cost) but the reset
# header is still present, so we learn exactly when to resume. An expired token
# yields 401 -> 'unknown'; callers fall back to the reset time learned earlier.
function Start-Probe {
    $script:Phase = 'probing'
    $lblStatus.Text = "Checking the limit..."
    $script:ProbeJob = Start-Job -ScriptBlock {
        param($cred)
        $r = [ordered]@{ status = 'unknown'; reset = $null; http = $null; detail = '' }
        try { $tok = (Get-Content $cred -Raw | ConvertFrom-Json).claudeAiOauth.accessToken }
        catch { $r.detail = 'cannot read credentials'; return ($r | ConvertTo-Json -Compress) }
        if (-not $tok) { $r.detail = 'no OAuth token'; return ($r | ConvertTo-Json -Compress) }

        $headers = @{
            'authorization'    = "Bearer $tok"
            'anthropic-version'= '2023-06-01'
            'anthropic-beta'   = 'oauth-2025-04-20'
            'content-type'     = 'application/json'
        }
        $body = '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"."}]}'

        # Collect response headers from success OR error (429/401 still carry them).
        $H = New-Object System.Collections.Hashtable ([System.StringComparer]::OrdinalIgnoreCase)
        try {
            $resp = Invoke-WebRequest -Uri 'https://api.anthropic.com/v1/messages' -Method Post `
                        -Headers $headers -Body $body -UseBasicParsing -TimeoutSec 30
            $r.http = [int]$resp.StatusCode
            foreach ($k in $resp.Headers.Keys) { $H[$k] = "$($resp.Headers[$k])" }
        } catch {
            $resp = $_.Exception.Response
            if ($null -eq $resp) { $r.detail = $_.Exception.Message; return ($r | ConvertTo-Json -Compress) }
            try { $r.http = [int]$resp.StatusCode } catch { }
            try { foreach ($k in $resp.Headers.AllKeys) { $H[$k] = "$($resp.Headers[$k])" } } catch { }
        }

        $st = $H['anthropic-ratelimit-unified-5h-status']
        if (-not $st) { $st = $H['anthropic-ratelimit-unified-status'] }
        $rs = $H['anthropic-ratelimit-unified-5h-reset']
        if (-not $rs) { $rs = $H['anthropic-ratelimit-unified-reset'] }
        if ($rs -match '^\d+$') { $r.reset = [long]$rs }

        if     ($st)            { $r.status = if ($st -ieq 'allowed') { 'lifted' } else { 'capped' } }
        elseif ($r.http -eq 429){ $r.status = 'capped' }
        elseif ($r.http -eq 200){ $r.status = 'lifted' }
        $r.detail = "http=$($r.http) 5h-status=$st reset=$rs"
        return ($r | ConvertTo-Json -Compress)
    } -ArgumentList $credPath
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
            $raw = (Receive-Job $script:ProbeJob -ErrorAction SilentlyContinue | Where-Object { $_ } | Select-Object -Last 1)
            Remove-Job $script:ProbeJob -Force -ErrorAction SilentlyContinue
            $script:ProbeJob = $null
            $res = $null
            try { $res = $raw | ConvertFrom-Json } catch { }
            $status = if ($res) { $res.status } else { 'unknown' }
            $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
            if ($res -and $res.reset) { $script:ResetEpoch = [long]$res.reset }

            # Local time string for the known reset, if any.
            $resetTxt = ""
            if ($script:ResetEpoch) {
                $resetTxt = " (resets {0:HH:mm})" -f [DateTimeOffset]::FromUnixTimeSeconds($script:ResetEpoch).ToLocalTime().DateTime
            }

            switch ($status) {
                'capped' {
                    $script:SawCap = $true
                    Write-Log "Capped$resetTxt. Waiting for the window to reset."
                    $lblStatus.Text = "Watching. Capped$resetTxt."
                    $script:Phase = 'waiting'
                    # Wait until reset (+30s slack), but re-poll at least every
                    # 'num' minutes so the UI stays alive / catches an early lift.
                    $cap = [int]$num.Value * 60
                    $secs = if ($script:ResetEpoch) { [int]($script:ResetEpoch - $now + 30) } else { 60 }
                    if ($secs -lt 60) { $secs = 60 }
                    if ($secs -gt $cap) { $secs = $cap }
                    $timer.Interval = $secs * 1000
                    $timer.Start()
                }
                'lifted' {
                    if (-not $script:SawCap) {
                        Write-Log "Not currently rate-limited - nothing to resume."
                        Stop-Watch "Not rate-limited - idle."
                        [System.Windows.Forms.MessageBox]::Show(
                            "You are NOT currently hitting the usage limit, so there is nothing to wait for.`n`nStart Claude Watch only AFTER you have hit the cap in a session. It will then wait for the window to reset and continue your selected project(s).",
                            "Nothing to resume", 'OK', 'Information') | Out-Null
                        return
                    }
                    Write-Log "Limit reset -> resuming."
                    Start-Resumes
                }
                default {
                    # 'unknown' (e.g. expired token -> 401, or a network blip).
                    $why = if ($res) { $res.detail } else { 'no response' }
                    if (-not $script:SawCap) {
                        # Never confirmed a cap; can't tell what's going on. Stop and explain.
                        Write-Log "Could not read limit status ($why)."
                        Stop-Watch "Couldn't read limit status."
                        [System.Windows.Forms.MessageBox]::Show(
                            "Couldn't read your usage-limit status from the API.`n`nDetail: $why`n`nMake sure you're logged in (run 'claude' once), then try again.",
                            "Status unavailable", 'OK', 'Warning') | Out-Null
                        return
                    }
                    # We already know a reset time. If it has passed, trust it and
                    # resume (claude refreshes its own auth). Otherwise keep waiting.
                    if ($script:ResetEpoch -and $now -ge $script:ResetEpoch) {
                        Write-Log "Reset time reached (status unverified: $why) -> resuming."
                        Start-Resumes
                    } else {
                        Write-Log "Status unverified ($why); waiting on known reset$resetTxt."
                        $script:Phase = 'waiting'
                        $cap = [int]$num.Value * 60
                        $secs = if ($script:ResetEpoch) { [int]($script:ResetEpoch - $now + 30) } else { 60 }
                        if ($secs -lt 60) { $secs = 60 }
                        if ($secs -gt $cap) { $secs = $cap }
                        $timer.Interval = $secs * 1000
                        $timer.Start()
                    }
                }
            }
        }

        'waiting' {
            Start-Probe   # interval elapsed; check the limit again
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
    $noSession = @($clb.CheckedItems | Where-Object { -not $_.Session })
    if ($noSession.Count -gt 0) {
        [System.Windows.Forms.MessageBox]::Show(
            "These ticked folders have no Claude session yet, so there's nothing to resume:`n`n" +
            (($noSession | ForEach-Object { $_.Path }) -join "`n") +
            "`n`nRun 'claude' in them once, then Refresh.", "No session", 'OK', 'Warning') | Out-Null
        return
    }

    $script:Watching   = $true
    $script:SawCap     = $false
    $script:ResetEpoch = $null
    $btnStart.Text = "Stop"; $btnStart.BackColor = [System.Drawing.Color]::FromArgb(207,34,46)
    $clb.Enabled = $false; $num.Enabled = $false; $txtPrompt.Enabled = $false
    $btnRefresh.Enabled = $false; $btnAdd.Enabled = $false; $btnRemove.Enabled = $false
    Write-Log "Watching $(@($clb.CheckedItems).Count) project(s); polling at most every $($num.Value) min."
    # First check confirms you are actually capped (and learns the reset time).
    # If you are not capped, it tells you and stops.
    Start-Probe
})

$btnAdd.Add_Click({
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = "Select a Claude project folder to watch"
    $dlg.ShowNewFolderButton = $false
    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        Save-Config (@(Get-ConfigPaths) + $dlg.SelectedPath)
        Load-List
        Write-Log "Added: $($dlg.SelectedPath)"
    }
})

$btnRemove.Add_Click({
    $sel = $clb.SelectedItem
    if (-not $sel) { [System.Windows.Forms.MessageBox]::Show("Click a project row (to highlight it), then Remove."); return }
    Save-Config (@(Get-ConfigPaths) | Where-Object { $_.TrimEnd('\','/') -ine $sel.Path })
    Load-List
    Write-Log "Removed: $($sel.Path)"
})

$btnRefresh.Add_Click({ Load-List })

# Closing the window cancels anything this tool started (your real claude
# sessions are untouched).
$form.Add_FormClosing({ $timer.Stop(); Clear-Jobs })

Load-List
[void]$form.ShowDialog()
