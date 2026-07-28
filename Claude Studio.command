#!/bin/bash
# Double-click launcher for Claude CLI Studio on macOS.
# Finder needs the executable bit once:  chmod +x "Claude Studio.command"
# Path is derived from the script location, so the folder can be moved freely.
cd "$(dirname "$0")/claudewebui" || {
  echo "Could not find the claudewebui folder next to this launcher."
  read -r -p "Press return to close."
  exit 1
}

# Finder launches with a bare PATH, so pick up Homebrew and nvm installs too.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed, or not on your PATH."
  echo "Install Node 20.10 or newer from https://nodejs.org and run this again."
  read -r -p "Press return to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run - installing dependencies, this takes a minute..."
  npm install || {
    echo "npm install failed. Scroll up for the reason."
    read -r -p "Press return to close."
    exit 1
  }
fi

echo "Starting Claude CLI Studio... close this window to stop it."
npm start
