#!/usr/bin/env bash
# Launch Google Chrome with CDP enabled for the moodboard scout/stage agents.
set -euo pipefail

PROFILE="${CHROME_PROFILE_PATH:-$HOME/chrome-debug-profile2}"
PORT="${CHROME_DEBUG_PORT:-9222}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [[ ! -x "$CHROME" ]]; then
  echo "Google Chrome not found at: $CHROME" >&2
  exit 1
fi

if curl -sf --max-time 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "CDP already running on port ${PORT}."
  curl -s "http://127.0.0.1:${PORT}/json/version" | python3 -m json.tool 2>/dev/null || true
  exit 0
fi

mkdir -p "$PROFILE"
echo "Starting Chrome (CDP port ${PORT}, profile ${PROFILE})…"
exec "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  "$@"
