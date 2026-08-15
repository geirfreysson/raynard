#!/usr/bin/env bash
# Screenshot the running Raynard window so an agent (or a bug report) can see the
# real UI rather than a description of it.
#
# Captures only the app window when GetWindowID is available:
#     brew install smokris/getwindowid/getwindowid
# Without it, falls back to a full-screen grab, which also captures every other
# window on the desktop — fine for a quick look, poor for privacy.
#
# Usage: scripts/shot-app.sh [output.png]
set -euo pipefail

OUT="${1:-/tmp/raynard-shot.png}"
APP="${RAYNARD_APP_NAME:-raynard}"

if ! pgrep -qf "target/debug/${APP}|Raynard.app"; then
  echo "Raynard does not appear to be running. Start it with: npm run tauri dev" >&2
  exit 1
fi

if command -v GetWindowID >/dev/null 2>&1; then
  # The window title is the Tauri window's, not the process name.
  WINDOW_ID="$(GetWindowID "Raynard" --list 2>/dev/null | head -1 | grep -oE '[0-9]+$' || true)"
  if [ -n "${WINDOW_ID}" ]; then
    # -o drops the drop shadow, -x silences the shutter sound.
    screencapture -x -o -l"${WINDOW_ID}" "${OUT}"
    echo "${OUT}"
    exit 0
  fi
  echo "GetWindowID found no Raynard window; falling back to full screen." >&2
fi

echo "Capturing the whole screen (install GetWindowID for a window-only shot)." >&2
screencapture -x -o "${OUT}"
echo "${OUT}"
