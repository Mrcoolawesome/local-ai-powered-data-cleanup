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

## A second real issue, found later (Phase 3) — timeout kills the client, not always the container

Not caught by this spike's own tests at the time, but worth recording here since it's the same `infinite_loop.py` test run implicated: **the `timeout --signal=KILL` wrapper only guarantees the `docker run` CLI client process dies, not the container it started.** A killed client can't forward a signal to the container it was attached to. One of this spike's own test containers was found still running 12 hours after the fact during Phase 3 work — the client-side timeout measurement in the table above was real and correct, but nothing here checked whether the *container* actually stopped too.

If you reuse this shell-script pattern standalone, add a `docker ps --filter ancestor=data-cleanup-sandbox` check after a timeout-triggered run to confirm no orphan survived — don't trust the wrapper's own exit code alone. The production executor (`apps/ai-service/app/sandbox.py`, Phase 3) avoids this entirely by using the Docker SDK to call `container.kill()` directly against the API rather than shelling out through a killable CLI client — confirmed leak-free by deliberately forcing a timeout against it.

## What this doesn't cover — now covered in Phase 3

This spike validated the sandbox *mechanism* in isolation — file I/O, network isolation, timeout enforcement (with the above caveat), read-only mounts. `apps/ai-service/app/sandbox.py` is where that mechanism actually got wired into the real FastAPI service (Docker SDK instead of a shell script, Docker-outside-of-Docker host-path translation, the container-leak fix above). Not yet independently stress-tested anywhere: memory/CPU limits under real pressure — the flags are set and trusted per Docker's documented behavior, but a script that actually tries to exceed `--memory=256m` or burn more than `--cpus=1` hasn't been thrown at either implementation. Worth a check if resource-limit correctness ever becomes suspect, not blocking since network/filesystem/timeout are the properties with real security consequences if wrong.
