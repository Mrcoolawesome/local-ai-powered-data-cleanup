#!/bin/bash
# Combined stage-1 + stage-2 integration test: boots Xvfb + Chromium (the
# test page from ../test-page), finds the real X11 window ID for the
# rendered page, builds the ZOOM_SHARE_X_WINDOW_HANDLE string the SDK's
# StartAppShare expects, and runs the real join_and_share binary against a
# live Zoom meeting using the credentials in .env.
#
# Everything here shares ONE X server (:99) on purpose — StartAppShare only
# works if the SDK process and the browser window it's sharing are on the
# same display. Run inside a container (see the `docker run` invocation
# this was developed with, in the spike's session notes) so build tooling
# doesn't have to be installed on the host.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

if [ ! -f .env ]; then
  echo "Missing .env — copy .env.example and fill in real values first." >&2
  exit 1
fi

echo "== Building zoom_join_and_share (fresh, against this container's own toolchain) =="
rm -rf build
cmake -S . -B build
cmake --build build

echo "== Starting Xvfb :99 =="
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
XVFB_PID=$!
export DISPLAY=:99
sleep 1

echo "== Serving the test page and opening it in Chromium =="
python3 -m http.server 8080 --directory ../test-page &
HTTP_PID=$!
sleep 1

chromium \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --window-size=1280,720 --window-position=0,0 --kiosk \
  "http://localhost:8080" &
CHROME_PID=$!
sleep 5

echo "== Finding the real X11 window ID =="
WINID=$(xdotool search --name "Zoom Spike Test Page" | head -1)
if [ -z "$WINID" ]; then
  echo "Could not find the Chromium window via xdotool — is it still loading? Dumping all windows:" >&2
  xdotool search --name "" >&2 || true
  kill "$CHROME_PID" "$HTTP_PID" "$XVFB_PID" 2>/dev/null || true
  exit 1
fi
echo "Window ID: $WINID"

# Format per meeting_sharing_interface.h's StartAppShare doc comment:
# "hostname:display_number-screen_number(x,y,width,height)-app_id"
WINDOW_HANDLE=":99-0(0,0,1280,720)-${WINID}"
echo "Computed ZOOM_SHARE_X_WINDOW_HANDLE=${WINDOW_HANDLE}"

echo "== Loading credentials from .env and running the join/share binary =="
set -a
source .env
set +a
export ZOOM_SHARE_X_WINDOW_HANDLE="$WINDOW_HANDLE"

# Bounded run — this is a real join against a real meeting; don't let it
# hang the script indefinitely if something never calls back.
timeout 60 ./build/zoom_join_and_share || echo "(exited or timed out — see output above for the actual callback trail)"

echo "== Cleaning up =="
kill "$CHROME_PID" "$HTTP_PID" "$XVFB_PID" 2>/dev/null || true
