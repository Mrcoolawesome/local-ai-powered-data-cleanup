#!/bin/bash
# Boots a virtual display, serves the spike's test page, opens it in
# Chromium against that display, then proves the render is actually live
# (not a frozen frame) by taking two screenshots a few seconds apart and
# diffing them. Output lands in /app/output for the host to inspect.
set -euo pipefail

mkdir -p /app/output

# Virtual framebuffer — this stands in for what a real deployment would use
# to give headless Chromium a display to render into.
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
XVFB_PID=$!
export DISPLAY=:99

# Serve the test page locally rather than using file:// — closer to how the
# real presentation route (a Next.js page over HTTP) will be loaded.
python3 -m http.server 8080 --directory /app/test-page &
HTTP_PID=$!

# Give both background services a moment to bind before Chromium connects.
sleep 2

chromium \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --window-size=1280,720 \
  --window-position=0,0 \
  --kiosk \
  "http://localhost:8080" &
CHROME_PID=$!

# Let the page load and the clock/tick counter start advancing.
sleep 5
import -window root /app/output/screenshot-1.png
echo "Captured screenshot-1.png"

sleep 4
import -window root /app/output/screenshot-2.png
echo "Captured screenshot-2.png"

# AE = absolute error metric: count of differing pixels between the two
# captures. A nonzero count proves the page is actively re-rendering
# (the clock/tick text changed), not just that a static frame was captured.
DIFF=$(compare -metric AE /app/output/screenshot-1.png /app/output/screenshot-2.png /app/output/diff.png 2>&1 || true)
echo "Pixel-difference between the two captures: ${DIFF} pixels"

if [ "${DIFF}" -gt 0 ] 2>/dev/null; then
  echo "RESULT: PASS — Xvfb + Chromium rendered a live, updating page."
else
  echo "RESULT: FAIL — captures were identical; page did not appear to update."
fi

kill "$CHROME_PID" "$HTTP_PID" "$XVFB_PID" 2>/dev/null || true
