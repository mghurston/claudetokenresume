<#
.SYNOPSIS
    GUI for Claude Watch. Pick one or more projects, then arm the watch at any
    time (even before you're capped). When the usage-limit window resets, each
    selected project's most recent session is reopened in its own VISIBLE
    terminal running `claude --resume <id>`, so you watch it continue exactly
    where you left off and can take over. You also get a toast + sound.

.NOTES
    Cap detection reads Anthropic's unified rate-limit headers (the same data
    behind the Claude app's Usage panel) from a tiny /v1/messages call using the
    OAuth token Claude Code already stores. While capped the call returns HTTP
    429 and costs nothing; the headers still report the exact 5h reset time, so
    the tool learns precisely when to resume without parsing terminal text.
    Resume opens a real terminal window (not a headless `claude -p` run) so the
    work is visible and the session stays interactive.
    The cap is account-wide, so one check covers all selected projects. Launch:
      powershell -ExecutionPolicy Bypass -File G:\claudetokenresume\claude-watch-ui.ps1
#>
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# Lets us paint the window's title bar dark to match the theme (Win10 1809+).
try {
    Add-Type -Namespace Native -Name Dwm -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("dwmapi.dll")]
public static extern int DwmSetWindowAttribute(System.IntPtr hwnd, int attr, int[] val, int size);
'@
} catch { }

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
    $disp = if ($session) { "{0,-40}  {1}  last: {2:MM/dd HH:mm}" -f $norm, $session.Substring(0,8), $last }
            else          { "{0,-40}  (no Claude session yet)" -f $norm }
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
# Flat dark theme. Palette:
$cBg     = [System.Drawing.Color]::FromArgb(32, 33, 38)    # window
$cPanel  = [System.Drawing.Color]::FromArgb(24, 25, 30)    # list / log
$cInput  = [System.Drawing.Color]::FromArgb(43, 45, 52)    # editable fields
$cText   = [System.Drawing.Color]::FromArgb(224, 226, 232) # primary text
$cMuted  = [System.Drawing.Color]::FromArgb(150, 152, 162) # secondary text
$cAccent = [System.Drawing.Color]::FromArgb(120, 170, 255) # title accent
$cGreen  = [System.Drawing.Color]::FromArgb(46, 160, 67);  $cGreenH = [System.Drawing.Color]::FromArgb(56, 178, 82)
$cRed    = [System.Drawing.Color]::FromArgb(207, 34, 46);  $cRedH   = [System.Drawing.Color]::FromArgb(224, 49, 61)
$cBtn    = [System.Drawing.Color]::FromArgb(52, 54, 63);   $cBtnH   = [System.Drawing.Color]::FromArgb(66, 68, 80)

function Set-FlatButton($b, $bg, $hover, $fore) {
    $b.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $b.FlatAppearance.BorderSize = 0
    $b.FlatAppearance.MouseOverBackColor = $hover
    $b.FlatAppearance.MouseDownBackColor = $hover
    $b.BackColor  = $bg
    $b.ForeColor  = $fore
    $b.Cursor     = [System.Windows.Forms.Cursors]::Hand
    $b.TextAlign  = [System.Drawing.ContentAlignment]::MiddleCenter
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Claude Watch"
$form.ClientSize = New-Object System.Drawing.Size(660, 694)
$form.StartPosition = "CenterScreen"
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9.5)
$form.BackColor = $cBg
$form.ForeColor = $cText
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false

# Dark title bar to match the theme (DWMWA_USE_IMMERSIVE_DARK_MODE: 20, or 19 on
# older builds). Best-effort; silently ignored where unsupported.
$form.Add_Shown({
    try {
        $on = [int[]]@(1)
        foreach ($attr in 20, 19) { [Native.Dwm]::DwmSetWindowAttribute($form.Handle, $attr, $on, 4) | Out-Null }
    } catch { }
})

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = "Claude Watch"
$lblTitle.Location = '20,16'; $lblTitle.AutoSize = $true
$lblTitle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 16)
$lblTitle.ForeColor = $cAccent
$form.Controls.Add($lblTitle)

$lblSub = New-Object System.Windows.Forms.Label
$lblSub.Text = "Arm it any time. It waits out the cap, then opens your session so it keeps going."
$lblSub.Location = '22,52'; $lblSub.AutoSize = $true
$lblSub.ForeColor = $cMuted
$form.Controls.Add($lblSub)

$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = "Projects to auto-continue when the window resets:"
$lbl.Location = '20,88'; $lbl.AutoSize = $true
$lbl.ForeColor = $cText
$form.Controls.Add($lbl)

$clb = New-Object System.Windows.Forms.CheckedListBox
$clb.Location = '20,112'; $clb.Size = '620,200'
$clb.CheckOnClick = $true; $clb.DisplayMember = 'Display'
$clb.Font = New-Object System.Drawing.Font("Consolas", 9)
$clb.BackColor = $cPanel; $clb.ForeColor = $cText
$clb.BorderStyle = 'None'
$form.Controls.Add($clb)

$btnAdd = New-Object System.Windows.Forms.Button
$btnAdd.Text = "+  Add project"; $btnAdd.Location = '20,324'; $btnAdd.Size = '124,30'
Set-FlatButton $btnAdd $cBtn $cBtnH $cText
$form.Controls.Add($btnAdd)

$btnRemove = New-Object System.Windows.Forms.Button
$btnRemove.Text = "Remove"; $btnRemove.Location = '152,324'; $btnRemove.Size = '96,30'
Set-FlatButton $btnRemove $cBtn $cBtnH $cText
$form.Controls.Add($btnRemove)

$btnRefresh = New-Object System.Windows.Forms.Button
$btnRefresh.Text = "Refresh"; $btnRefresh.Location = '256,324'; $btnRefresh.Size = '96,30'
Set-FlatButton $btnRefresh $cBtn $cBtnH $cText
$form.Controls.Add($btnRefresh)

$lblInt = New-Object System.Windows.Forms.Label
$lblInt.Text = "Poll at most every (min):"; $lblInt.Location = '418,331'; $lblInt.AutoSize = $true
$lblInt.ForeColor = $cMuted
$form.Controls.Add($lblInt)

$num = New-Object System.Windows.Forms.NumericUpDown
$num.Location = '580,328'; $num.Size = '60,24'; $num.Minimum = 5; $num.Maximum = 240; $num.Value = 30
$num.BackColor = $cInput; $num.ForeColor = $cText; $num.BorderStyle = 'FixedSingle'
$form.Controls.Add($num)

$lblP = New-Object System.Windows.Forms.Label
$lblP.Text = "Wake prompt sent on resume:"; $lblP.Location = '20,368'; $lblP.AutoSize = $true
$lblP.ForeColor = $cText
$form.Controls.Add($lblP)

# How autonomous the resumed (unattended) session is. acceptEdits keeps it
# moving on file edits but still pauses for risky ops; bypassPermissions runs
# everything; default makes it wait for you to approve each tool use.
$lblPerm = New-Object System.Windows.Forms.Label
$lblPerm.Text = "Permissions:"; $lblPerm.Location = '452,368'; $lblPerm.AutoSize = $true
$lblPerm.ForeColor = $cMuted
$form.Controls.Add($lblPerm)

$cboPerm = New-Object System.Windows.Forms.ComboBox
$cboPerm.Location = '534,364'; $cboPerm.Size = '106,24'
$cboPerm.DropDownStyle = 'DropDownList'; $cboPerm.FlatStyle = 'Flat'
$cboPerm.BackColor = $cInput; $cboPerm.ForeColor = $cText
[void]$cboPerm.Items.AddRange(@('acceptEdits','bypassPermissions','default'))
$cboPerm.SelectedIndex = 0
$form.Controls.Add($cboPerm)

$txtPrompt = New-Object System.Windows.Forms.TextBox
$txtPrompt.Location = '20,392'; $txtPrompt.Size = '620,72'
$txtPrompt.Multiline = $true; $txtPrompt.ScrollBars = 'Vertical'; $txtPrompt.Text = $defaultPrompt
$txtPrompt.BackColor = $cInput; $txtPrompt.ForeColor = $cText; $txtPrompt.BorderStyle = 'FixedSingle'
$form.Controls.Add($txtPrompt)

$btnStart = New-Object System.Windows.Forms.Button
$btnStart.Text = "Start watching"; $btnStart.Location = '20,484'; $btnStart.Size = '160,40'
$btnStart.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 10)
Set-FlatButton $btnStart $cGreen $cGreenH ([System.Drawing.Color]::White)
$form.Controls.Add($btnStart)

# Continuous = ride out every cap cycle (the 24h autonomous mode). Unchecked =
# stop after the first cap->lift->resume. Read live at resume time, so you can
# flip it mid-run. Checked by default since unattended long runs are the point.
$chkContinuous = New-Object System.Windows.Forms.CheckBox
$chkContinuous.Text = "Keep watching after each reset (run until I stop)"
$chkContinuous.Location = '198,485'; $chkContinuous.AutoSize = $true
$chkContinuous.Checked = $true
$chkContinuous.ForeColor = $cText; $chkContinuous.BackColor = $cBg
$chkContinuous.FlatStyle = 'Flat'
$form.Controls.Add($chkContinuous)

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Text = "Idle."; $lblStatus.Location = '198,508'; $lblStatus.AutoSize = $true
$lblStatus.ForeColor = $cMuted
$form.Controls.Add($lblStatus)

$log = New-Object System.Windows.Forms.TextBox
$log.Location = '20,536'; $log.Size = '620,108'
$log.Multiline = $true; $log.ScrollBars = 'Vertical'; $log.ReadOnly = $true
$log.Font = New-Object System.Drawing.Font("Consolas", 8.5)
$log.BackColor = $cPanel; $log.ForeColor = $cMuted; $log.BorderStyle = 'FixedSingle'
$form.Controls.Add($log)

# Attribution banner for anyone who downloads this from the repo. Two clickable
# links (website + Linktree); each region opens its own URL via LinkData.
$banner = New-Object System.Windows.Forms.LinkLabel
$banner.Text = "Made by mghurston   -   michaelghurston.com   -   linktr.ee/mghurston"
$banner.Location = '20,656'; $banner.AutoSize = $true
$banner.BackColor = $cBg
$banner.ForeColor = $cMuted
$banner.LinkColor = $cAccent
$banner.ActiveLinkColor = $cAccent
$banner.LinkBehavior = [System.Windows.Forms.LinkBehavior]::HoverUnderline
$banner.Links.Clear()
[void]$banner.Links.Add($banner.Text.IndexOf('michaelghurston.com'), 'michaelghurston.com'.Length, 'https://www.michaelghurston.com/')
[void]$banner.Links.Add($banner.Text.IndexOf('linktr.ee/mghurston'), 'linktr.ee/mghurston'.Length, 'https://linktr.ee/mghurston')
$banner.Add_LinkClicked({ param($s, $e) try { Start-Process ([string]$e.Link.LinkData) } catch { } })
$form.Controls.Add($banner)

function Write-Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg
    $log.AppendText($line + "`r`n")
}

function Load-List {
    $clb.Items.Clear()
    foreach ($p in Get-ConfigPaths) {
        $r = Resolve-Project $p
        [void]$clb.Items.Add($r)
        if ($r.Session) {
            Write-Log ("  {0} -> session {1} (last {2:MM/dd HH:mm})" -f $r.Path, $r.Session.Substring(0,8), $r.Last)
        } else {
            Write-Log "  $($r.Path) -> (no Claude session yet)"
        }
    }
    Write-Log "Loaded $($clb.Items.Count) project(s) from $([System.IO.Path]::GetFileName($configPath))."
}

# --- State machine (all async so the window never freezes) ------------------
# Phases: idle -> probing -> waiting -> probing -> ... -> (cap->lift) -> open
# resume windows -> RE-ARM (back to waiting) -> ... and so on. The watch loops
# through every cap cycle so it can run unattended for a full day; only Stop or
# closing the window ends it.
$timer = New-Object System.Windows.Forms.Timer
$script:Watching   = $false
$script:Phase      = 'idle'
$script:SawCap     = $false   # have we OBSERVED a real capped state yet?
$script:ResetEpoch = $null    # unix secs when the 5h window resets (from headers)
$script:ProbeJob   = $null
$script:Cycle      = 0        # how many cap->lift resumes we've fired this run

# Stop & remove only THIS tool's probe job (never touches your real claude
# sessions). Resume windows are real terminals you drive - we never close them.
function Clear-Jobs {
    if ($script:ProbeJob) {
        Stop-Job   $script:ProbeJob -ErrorAction SilentlyContinue
        Remove-Job $script:ProbeJob -Force -ErrorAction SilentlyContinue
        $script:ProbeJob = $null
    }
}

function Stop-Watch([string]$status) {
    $timer.Stop(); $script:Watching = $false; $script:Phase = 'idle'
    Clear-Jobs
    $btnStart.Text = "Start watching"
    $btnStart.BackColor = $cGreen; $btnStart.FlatAppearance.MouseOverBackColor = $cGreenH
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

# Reopen each ticked project's session in its OWN visible terminal, resuming the
# SAME conversation interactively (`claude --resume <id>`). We deliberately do
# NOT run headless `claude -p`: the whole point is that the work is visible, the
# session stays interactive, and you can watch it or take over. Each window is a
# tiny generated .cmd so the wake prompt's spaces/quotes survive intact.
#
# After launching, we RE-ARM rather than stop: the tool goes back to waiting so
# it rides out the next cap cycle too, enabling unattended multi-cap (24h) runs.
function Start-Resumes {
    $script:Cycle++
    $targets = @($clb.CheckedItems)
    $mode = "$($cboPerm.SelectedItem)"
    Send-Toast "Claude resuming" "Window reset (cycle $($script:Cycle)). Opening session(s) so they keep going."
    $opened = 0
    foreach ($t in $targets) {
        # Re-resolve to the project's CURRENT newest session: an earlier resume
        # in this run may have advanced the conversation into a new session id,
        # so the captured-at-arm-time id can be stale by now.
        $p = Resolve-Project $t.Path
        if (-not $p.Session) {
            Write-Log "Skip $($p.Path): no Claude session found to resume."
            continue
        }
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $name  = Split-Path $p.Path -Leaf
        # Escape for a double-quoted batch argument: %->%% and "->' (rare).
        $safePrompt = ($txtPrompt.Text -replace '%','%%') -replace '"',"'"
        $modeArg = if ($mode -and $mode -ne 'default') { "--permission-mode $mode " } else { "" }
        $launcher = Join-Path $logDir ("resume-{0}-{1}.cmd" -f ($p.Session.Substring(0,8)), $stamp)
        @(
            '@echo off'
            "title Claude Watch resume - $name (cycle $($script:Cycle))"
            "cd /d `"$($p.Path)`""
            "echo Resuming session $($p.Session)"
            "echo in $($p.Path)"
            'echo.'
            "claude --resume $($p.Session) $modeArg`"$safePrompt`""
            'echo.'
            'echo === Claude session ended. You can close this window. ==='
            'pause'
        ) | Set-Content -LiteralPath $launcher -Encoding ascii
        Start-Process -FilePath $env:ComSpec -ArgumentList '/c', "`"$launcher`""
        Write-Log "Opened resume window: $name (session $($p.Session.Substring(0,8)))"
        $opened++
    }
    # One-shot mode (toggle off): resume once, then go idle as before.
    if (-not $chkContinuous.Checked) {
        Send-Toast "Claude resumed" "Opened $opened live window(s). They continue where you left off."
        Stop-Watch "Resumed - see the new terminal window(s)."
        Write-Log "Watch complete (one-shot) - the resume windows are now yours to drive."
        return
    }

    Send-Toast "Claude resumed" "Opened $opened live window(s). Re-arming for the next cap."

    # Continuous mode: re-arm for the next cap instead of going idle. We do NOT
    # re-probe instantly: right after a lift a stale 'capped' header could
    # otherwise fire a second resume immediately. Waiting the normal poll interval
    # lets the lift settle and gives the freshly resumed session time to start
    # consuming again. The next observed cap re-sets SawCap and the cycle repeats.
    $script:SawCap     = $false
    $script:ResetEpoch = $null
    $script:Phase      = 'waiting'
    $lblStatus.Text = "Re-armed (cycle $($script:Cycle) done). Watching for the next cap..."
    Write-Log "Re-armed after cycle $($script:Cycle); will resume again after the next cap resets. (Stop to end the run.)"
    $timer.Interval = [int]$num.Value * 60 * 1000
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
                        # Not capped yet. Don't resume (resuming while uncapped was
                        # the worst-ever bug) - just stay armed and keep polling
                        # until a real cap appears.
                        Write-Log "Not capped yet - armed. Will auto-resume after you hit the cap and it resets."
                        $lblStatus.Text = "Armed. Watching for the cap$resetTxt..."
                        $script:Phase = 'waiting'
                        $timer.Interval = [int]$num.Value * 60 * 1000
                        $timer.Start()
                        return
                    }
                    Write-Log "Limit reset -> resuming."
                    Start-Resumes
                }
                default {
                    # 'unknown' (e.g. expired token -> 401, or a network blip).
                    $why = if ($res) { $res.detail } else { 'no response' }
                    if (-not $script:SawCap) {
                        # A fatal login problem makes arming pointless - stop and explain.
                        if ($why -match 'credential|OAuth token') {
                            Write-Log "Could not read your login ($why)."
                            Stop-Watch "Couldn't read login."
                            [System.Windows.Forms.MessageBox]::Show(
                                "Couldn't read your Claude login from .credentials.json.`n`nDetail: $why`n`nMake sure you're logged in (run 'claude' once), then try again.",
                                "Login unavailable", 'OK', 'Warning') | Out-Null
                            return
                        }
                        # Transient (network/401 blip). Stay armed and keep polling.
                        Write-Log "Status unreadable for now ($why); staying armed."
                        $lblStatus.Text = "Armed (status unclear); retrying..."
                        $script:Phase = 'waiting'
                        $timer.Interval = [int]$num.Value * 60 * 1000
                        $timer.Start()
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

    foreach ($p in @($clb.CheckedItems)) {
        Write-Log "Armed to resume $($p.Path) -> session $($p.Session)"
    }
    $script:Watching   = $true
    $script:SawCap     = $false
    $script:ResetEpoch = $null
    $script:Cycle      = 0
    $btnStart.Text = "Stop"
    $btnStart.BackColor = $cRed; $btnStart.FlatAppearance.MouseOverBackColor = $cRedH
    $clb.Enabled = $false; $num.Enabled = $false; $txtPrompt.Enabled = $false
    $btnRefresh.Enabled = $false; $btnAdd.Enabled = $false; $btnRemove.Enabled = $false
    Write-Log "Watching $(@($clb.CheckedItems).Count) project(s); polling at most every $($num.Value) min."
    # You can arm this before you're capped: if not capped yet it stays armed and
    # keeps polling, and only resumes after a real capped -> lifted transition.
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
