#!/bin/bash
# Exercises all four sandbox properties docs/06-security-sandboxing.md
# requires, against the real container runtime — not just reading the
# `docker run` flags and assuming they do what they say.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

echo "== Building sandbox image =="
docker build -t data-cleanup-sandbox . || { echo "Build failed"; exit 1; }

WORKDIR="$(mktemp -d)"
PASS=0
FAIL=0

check() {
  local name="$1" condition="$2"
  if eval "$condition"; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name"
    FAIL=$((FAIL + 1))
  fi
}

echo
echo "== Test 1: well-behaved script (file I/O + stdout capture) =="
OUT1="$WORKDIR/out1"
LOG1=$(./run-sandboxed.sh test-scripts/good_clean.py fixtures/input "$OUT1" 15 2>&1)
echo "$LOG1"
check "good_clean.py exits 0" "echo \"\$LOG1\" | grep -q 'exited with code 0'"
check "cleaned.csv was written" "[ -f '$OUT1/cleaned.csv' ]"
check "cleaned.csv has the derived full_name column" "grep -q 'full_name' '$OUT1/cleaned.csv'"
check "stdout from inside the container was captured" "echo \"\$LOG1\" | grep -q 'Cleaned 2 rows'"

echo
echo "== Test 2: network access should be blocked (--network none) =="
OUT2="$WORKDIR/out2"
LOG2=$(./run-sandboxed.sh test-scripts/try_network.py fixtures/input "$OUT2" 15 2>&1)
echo "$LOG2"
check "network call was blocked, not reached" "echo \"\$LOG2\" | grep -q 'blocked as expected' && ! echo \"\$LOG2\" | grep -q 'REACHED NETWORK'"

echo
echo "== Test 3: runaway script should be killed by the timeout backstop =="
START=$(date +%s)
OUT3="$WORKDIR/out3"
LOG3=$(./run-sandboxed.sh test-scripts/infinite_loop.py fixtures/input "$OUT3" 5 2>&1)
END=$(date +%s)
ELAPSED=$((END - START))
echo "$LOG3"
echo "(elapsed: ${ELAPSED}s)"
check "infinite loop did NOT exit 0 (it was killed)" "! echo \"\$LOG3\" | grep -q 'exited with code 0'"
check "killed within the timeout window, not left hanging" "[ $ELAPSED -le 10 ]"

echo
echo "== Test 4: input mount should be read-only =="
OUT4="$WORKDIR/out4"
LOG4=$(./run-sandboxed.sh test-scripts/try_write_input.py fixtures/input "$OUT4" 15 2>&1)
echo "$LOG4"
check "write to read-only input was blocked" "echo \"\$LOG4\" | grep -q 'blocked as expected' && ! echo \"\$LOG4\" | grep -q 'WROTE TO READ-ONLY'"
check "the original input file was not modified" "! grep -q 'tampered' fixtures/input/data.csv"

echo
echo "== Summary: $PASS passed, $FAIL failed =="
rm -rf "$WORKDIR"
[ "$FAIL" -eq 0 ]
