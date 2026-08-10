#!/bin/bash
# Runs the Next.js app and the realtime WS control server
# (docs/08-raspberry-pi-controller.md) as sibling processes in the same
# container — see ws-server.ts's header comment for why they need to share
# a hostname (and therefore a container) rather than being split into
# separate compose services. `bash`, not `sh` — `wait -n` (below) is a
# bash-only builtin dash/POSIX sh doesn't have, and node:22-slim (Debian)
# ships bash by default.
set -eu

# Invoke the binaries directly, not via `pnpm exec` — found the hard way:
# `pnpm exec` runs pnpm's own dependency-status check first, which tries
# to write temp files into /app. /app is root-owned (created during the
# Dockerfile's COPY steps, which run as root at build time), but this
# container runs as a non-root uid (docker-compose.yml's `user:`), so that
# check fails with EACCES before Next or the WS server ever start. `node
# server.js` (the old standalone-output entrypoint) never hit this since
# it never went through pnpm at runtime at all — going straight at the
# binaries here restores that same "no package-manager involvement at
# runtime" property.
node_modules/.bin/next start &
NEXT_PID=$!

node_modules/.bin/tsx ws-server.ts &
WS_PID=$!

trap 'kill "$NEXT_PID" "$WS_PID" 2>/dev/null || true' TERM INT

# If either process dies, the container should die too — Docker's restart
# policy (docker-compose.yml) then restarts both fresh, rather than this
# container silently running in a half-working state with one process gone.
wait -n "$NEXT_PID" "$WS_PID"
EXIT_CODE=$?
kill "$NEXT_PID" "$WS_PID" 2>/dev/null || true
exit "$EXIT_CODE"
