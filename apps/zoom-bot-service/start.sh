#!/bin/bash
# Zoom Bot Service entrypoint — production version of the validated spike's
# start-xvfb-chromium.sh + run-integration-test.sh, combined and adapted to
# run as a long-lived service instead of a one-shot test:
#
#   1. Boot Xvfb (a virtual display Chromium and the Zoom SDK share — this
#      is required, not incidental: StartAppShare only works if the SDK
#      process and the browser window it's sharing are on the same display).
#   2. Launch Chromium in kiosk mode pointed at the real PRESENT_URL
#      (a live /present/[sessionId] route — spikes/zoom-presentation-bot
#      pointed this same setup at a static test page instead).
#   3. Find its X11 window. Unlike the spike (which matched a fixed test
#      page <title>), this looks for "the one window on this display" —
#      /present/[sessionId] has no unique per-session title, and a title
#      match would be a needless coupling to page content anyway, since
#      Chromium is deliberately the only GUI application running here.
#   4. Fetch the meeting ID/passcode for this session from the web app
#      (GET /api/presentations/[id]/zoom-meeting) rather than a fixed
#      .env value — a meeting number is a per-presentation fact set
#      through the UI (app/presentations/[id]/page.tsx), not a deployment
#      secret like ZOOM_SDK_KEY/ZOOM_SDK_SECRET, which stay in .env since
#      they're the same for every meeting this app ever joins.
#   5. Compute the ZOOM_SHARE_X_WINDOW_HANDLE string StartAppShare expects
#      and exec the compiled zoom_bot_service binary in the foreground, so
#      Docker's own process supervision (PID 1, restart policy, SIGTERM on
#      `docker stop`) governs this service's lifecycle directly rather than
#      through a detached background process this script would have to
#      babysit.
set -euo pipefail

: "${PRESENT_URL:?PRESENT_URL must be set — e.g. http://web:3000/present/<sessionId>}"
: "${ZOOM_SDK_KEY:?ZOOM_SDK_KEY must be set}"
: "${ZOOM_SDK_SECRET:?ZOOM_SDK_SECRET must be set}"

# The session id is PRESENT_URL's own last path segment — no separate env
# var needed to track "which session," since PRESENT_URL already has to
# name it.
SESSION_ID="${PRESENT_URL##*/}"
WEB_BASE_URL="${PRESENT_URL%/present/*}"

echo "== Fetching Zoom meeting ID/passcode for session ${SESSION_ID} =="
# No `curl -f` here — found the hard way that it suppresses the response
# body on a 4xx/5xx status, which is exactly when the API returns a JSON
# `{"error": "..."}` body worth showing the operator (e.g. no meeting ID
# set yet). A transport-level failure (connection refused, DNS) still
# produces an empty/non-JSON body, caught separately by the jq parse below.
ZOOM_MEETING_JSON=$(curl -s "${WEB_BASE_URL}/api/presentations/${SESSION_ID}/zoom-meeting")
if [ -z "${ZOOM_MEETING_JSON}" ] || ! echo "${ZOOM_MEETING_JSON}" | jq -e . >/dev/null 2>&1; then
  echo "Could not reach ${WEB_BASE_URL}/api/presentations/${SESSION_ID}/zoom-meeting — is the web service up and PRESENT_URL correct?" >&2
  exit 1
fi
ZOOM_MEETING_ERROR=$(echo "${ZOOM_MEETING_JSON}" | jq -r '.error // empty')
if [ -n "${ZOOM_MEETING_ERROR}" ]; then
  echo "${ZOOM_MEETING_ERROR}" >&2
  exit 1
fi
export ZOOM_MEETING_NUMBER=$(echo "${ZOOM_MEETING_JSON}" | jq -r '.meetingId')
export ZOOM_MEETING_PASSWORD=$(echo "${ZOOM_MEETING_JSON}" | jq -r '.meetingPassword')

DISPLAY_NUM="${ZOOM_BOT_DISPLAY_NUM:-99}"
WIDTH="${ZOOM_BOT_WIDTH:-1280}"
HEIGHT="${ZOOM_BOT_HEIGHT:-720}"

CHILD_PIDS=()
cleanup() {
  echo "== Shutting down =="
  for pid in "${CHILD_PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT TERM INT

# The SDK itself is never baked into this image (spikes/zoom-presentation-bot/README.md:
# "never redistribute") — it's bind-mounted read-write from the host at
# runtime (docker-compose.yml's zoom-bot service), same as the validated
# spike's run-integration-test.sh does. Built fresh on every container
# start rather than at image-build time, for the same reason: the image
# never contains the proprietary SDK, so there's nothing to build against
# until the mount is present. A cold build takes on the order of seconds —
# acceptable for a service that starts once per presentation, not something
# restarted in a hot loop.
: "${ZOOM_SDK_DIR:?ZOOM_SDK_DIR must be set (bind-mounted SDK path)}"
if [ ! -f "${ZOOM_SDK_DIR}/libmeetingsdk.so" ]; then
  echo "No libmeetingsdk.so at ${ZOOM_SDK_DIR} — is the SDK bind mount present? See docs/07-zoom-bot.md." >&2
  exit 1
fi

# libmeetingsdk.so's embedded SONAME is libmeetingsdk.so.1, but Zoom ships
# the file as libmeetingsdk.so with no version suffix — the dynamic loader
# looks for the SONAME, not the filename (spikes/zoom-presentation-bot/README.md's
# "Two real, non-obvious build issues" #1). Recreated on every container
# start since this is a bind mount of the host's SDK directory, not
# something this image can permanently modify.
ln -sf libmeetingsdk.so "${ZOOM_SDK_DIR}/libmeetingsdk.so.1"

echo "== Building zoom_bot_service =="
cmake -S /app -B /app/build -DZOOM_SDK_DIR="${ZOOM_SDK_DIR}" >/dev/null
cmake --build /app/build -j"$(nproc)"

echo "== Starting Xvfb :${DISPLAY_NUM} =="
Xvfb ":${DISPLAY_NUM}" -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp &
CHILD_PIDS+=("$!")
export DISPLAY=":${DISPLAY_NUM}"
sleep 1

echo "== Opening ${PRESENT_URL} in Chromium =="
chromium \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --window-size="${WIDTH},${HEIGHT}" --window-position=0,0 --kiosk \
  "${PRESENT_URL}" &
CHILD_PIDS+=("$!")

echo "== Waiting for the Chromium window to appear =="
WINID=""
for _ in $(seq 1 30); do
  WINID=$(xdotool search --onlyvisible --class "chromium" 2>/dev/null | head -1 || true)
  [ -n "$WINID" ] && break
  sleep 1
done
if [ -z "$WINID" ]; then
  echo "Could not find the Chromium window after 30s — is chromium still starting, or did it crash?" >&2
  xdotool search --onlyvisible "" >&2 || true
  exit 1
fi
echo "Window ID: $WINID"

# Format per meeting_sharing_interface.h's StartAppShare doc comment:
# "hostname:display_number-screen_number(x,y,width,height)-app_id"
export ZOOM_SHARE_X_WINDOW_HANDLE=":${DISPLAY_NUM}-0(0,0,${WIDTH},${HEIGHT})-${WINID}"
echo "ZOOM_SHARE_X_WINDOW_HANDLE=${ZOOM_SHARE_X_WINDOW_HANDLE}"

echo "== Joining the meeting and starting the share =="
exec /app/build/zoom_bot_service
