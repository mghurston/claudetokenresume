@echo off
setlocal
rem Double-click launcher for Claude CLI Studio. %~dp0-relative so the folder
rem can be renamed or moved. The server opens your browser itself.
title Claude CLI Studio

cd /d "%~dp0claudewebui"
if errorlevel 1 (
  echo Could not find the claudewebui folder next to this launcher.
  echo Expected: %~dp0claudewebui
  goto :done
)

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed, or not on your PATH.
  echo Install Node 20.10 or newer from https://nodejs.org then run this again.
  goto :done
)

if not exist "node_modules\" (
  echo First run - installing dependencies, this takes a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Scroll up for the reason.
    goto :done
  )
)

call npm start

:done
echo.
pause
