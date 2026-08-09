#!/bin/bash
# Runs a single Python script inside the locked-down sandbox container.
# This is the actual mechanism docs/06-security-sandboxing.md specs out for
# every LLM-generated cleaning script / chat-triggered edit / scraper
# command in the real system — this spike proves the mechanism itself
# works before any of those callers are built.
#
# Usage: ./run-sandboxed.sh <script.py> <input_dir> <output_dir> [timeout_seconds]
set -euo pipefail

SCRIPT_PATH="$1"
INPUT_DIR="$2"
OUTPUT_DIR="$3"
TIMEOUT_SECONDS="${4:-15}"

mkdir -p "$OUTPUT_DIR"

# timeout wraps the whole `docker run` — this is a host-side backstop in
# addition to whatever the script does internally, so a container that
# somehow ignores SIGTERM still gets torn down. `|| EXIT_CODE=$?` (rather
# than a bare trailing command) because `set -e` would otherwise abort the
# script on a nonzero exit before we get to report it below.
#
# --user "$(id -u):$(id -g)" overrides the Dockerfile's fixed `USER sandbox`
# (uid 10001) at run time. Found the hard way: with the fixed uid, Pandas'
# to_csv() into the bind-mounted output dir failed with PermissionError —
# the container's uid 10001 doesn't own a directory the host user just
# created. Running as the invoking host user's own uid/gid instead makes
# bind-mount ownership line up automatically, while staying just as
# non-root as the Dockerfile default (the host user here isn't root
# either). In the real system, the FastAPI orchestration service's own
# uid — not root — would run these sandbox containers this same way.
EXIT_CODE=0
timeout --signal=KILL "${TIMEOUT_SECONDS}s" docker run --rm \
  --network none \
  --cpus=1 \
  --memory=256m --memory-swap=256m \
  --pids-limit=64 \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --read-only \
  --user "$(id -u):$(id -g)" \
  --tmpfs "/tmp:rw,size=64m,uid=$(id -u),gid=$(id -g)" \
  -v "$(realpath "$SCRIPT_PATH")":/work/script.py:ro \
  -v "$(realpath "$INPUT_DIR")":/work/input:ro \
  -v "$(realpath "$OUTPUT_DIR")":/work/output:rw \
  data-cleanup-sandbox \
  python3 /work/script.py || EXIT_CODE=$?

echo "--- sandbox run exited with code $EXIT_CODE ---"
exit $EXIT_CODE
