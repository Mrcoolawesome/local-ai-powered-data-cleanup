# Docker Sandbox — Phase 0 Spike

Validates the execution-sandbox design in [`/docs/06-security-sandboxing.md`](../../docs/06-security-sandboxing.md) — the mechanism every LLM-generated cleaning script, chat-triggered edit, and scraper command will run through in the real system. This spike proves the mechanism itself works, isolated from any of those real callers.

**Status: done, all checks passing.**

```bash
./run-all-tests.sh
```

Builds the sandbox image and runs four real scenarios against it, each asserting the actual observed behavior rather than just checking exit codes:

| Test | Proves | Result |
|---|---|---|
| `good_clean.py` | File I/O across the read-only input / read-write output mounts, and stdout capture — the happy path a real cleaning script takes | PASS |
| `try_network.py` | `--network none` actually blocks outbound network calls, not just that the flag was passed | PASS — `[Errno 101] Network is unreachable` |
| `infinite_loop.py` | The host-side `timeout` wrapper kills a runaway container within the configured window, rather than the sandbox hanging forever on a buggy/adversarial script | PASS — killed within 5s, `timeout`'s own exit code (124) surfaced correctly |
| `try_write_input.py` | The input mount is genuinely read-only, not just "the script is supposed to not write there" | PASS — `[Errno 30] Read-only file system`, original file unmodified |

## One real issue found and fixed

First run: `good_clean.py` failed with `PermissionError` writing its output file. Cause: the Dockerfile's `USER sandbox` runs as a fixed `uid 10001`, but the bind-mounted output directory is freshly created by the *host* user invoking the script — different UIDs, so the container process didn't own (or have write access to) the host directory it was mounted into.

Fix (in `run-sandboxed.sh`): pass `--user "$(id -u):$(id -g)"` at `docker run` time, overriding the Dockerfile default so the container process runs as the *invoking host user's* own uid/gid. Bind-mount ownership then lines up automatically. This stays just as non-root as the fixed-uid approach (the host user here isn't root either) and is what the real FastAPI orchestration service would do too — run sandbox containers as its own uid, not root.

This is a real, easy-to-hit gotcha for anyone bind-mounting host directories into a fixed-non-root-uid container — worth remembering if `06-security-sandboxing.md`'s design gets implemented by someone who didn't see this spike.

## What this doesn't cover yet

This spike validates the sandbox *mechanism* — file I/O, network isolation, timeout enforcement, read-only mounts. It does not yet validate:
- The actual FastAPI service invoking this pattern programmatically (subprocess/Docker SDK calls instead of a shell script) — that's Phase 3 work.
- Memory-limit enforcement under real pressure (a script that actually tries to allocate past `--memory=256m`) — the flag is set and trusted to work per Docker's own documented behavior, but not independently stress-tested here.
- CPU-limit enforcement under real load — same caveat.

Those are worth a quick check during Phase 3 implementation, not blocking here since the core isolation properties (network, filesystem, timeout) are the ones with actual security consequences if wrong.
