# Security & Sandboxing

This is the foundational risk in the whole system: an LLM is generating and triggering execution of code and shell commands, unattended, on a machine that holds customer data and live third-party platform credentials (see the HCP scraper `.env`/`session.json` files in `/example-scrapers`, which their own READMEs flag as holding live customer credentials). Treat this as load-bearing architecture, not a hardening pass added later.

## Threat model (what we're actually defending against)

- A generated Pandas script with a bug that deletes/corrupts data instead of cleaning it.
- A scraped file, or an unusual README, containing content that manipulates the agent into running something it shouldn't (prompt injection via untrusted document content — the agent reads READMEs and file content it didn't author).
- A generated script or triggered command that reaches out to the network in a way that wasn't intended (data exfiltration, or hitting the wrong external endpoint).
- A scraper credential (`.env`, `session.json`) leaking into a log, an LLM prompt, or a committed file.
- Runaway execution (infinite loop, resource exhaustion) taking down the AI server.

## Design: Docker container per execution

Every LLM-directed execution — a generated cleaning script, a chat-triggered DataFrame edit, a scraper-triggered command — runs in its own short-lived Docker container. No execution happens directly in the FastAPI process or its host user.

**Per-container constraints:**
- **No network access by default.** Cleaning-script containers never need network — they operate on a file already on disk. Scraper containers are the one legitimate exception (they need to reach the target platform) and get network access scoped as narrowly as practical for that run, not a blanket-open container.
- **Minimal, explicit filesystem mounts.** A cleaning-script container gets read access to the one input file and write access to one output path — not the whole storage root. A scraper container gets its own scraper directory (script, README, saved session/`.env`) mounted, and nothing else.
- **Resource limits.** CPU/memory caps and a hard execution timeout (config value in `Settings`) on every container, so a runaway script or hung scraper process can't take down the host.
- **Non-root container user**, ephemeral (removed after execution, not reused). Run as the orchestrating service's *own* uid/gid (`--user`) rather than a fixed in-image uid — see "Phase 0 spike status" below for why a fixed uid breaks bind-mounted output.
- **No secrets in the LLM's own context.** The model never sees `.env` contents or session tokens — it only sees the *plan* (which command to run); the actual credential file is mounted directly into the sandbox container by the orchestrator, bypassing the model entirely.

## Credential handling

- Scraper `.env`/session files stay on disk in their scraper's own directory, never copied into the app's database or logs.
- `.gitignore` (already in place at repo root) excludes `*.env` and `session.json` — this is non-negotiable given these files hold live customer platform credentials per the scrapers' own documentation.
- `AuditLog`/`ScraperRun` records store the *command executed* and *outcome*, never environment variable values or file contents from `.env`.

## Prompt-injection awareness

Any content the agent reads that it didn't author — a README, a scraped file's contents — is untrusted input, not instructions. The scraper-planning system prompt ([05-llm-prompting.md](./05-llm-prompting.md)) treats the README strictly as data to extract a plan *from*, and that plan is still subject to the same sandboxing above — a README can't grant itself broader container permissions than the orchestrator's own fixed policy allows, regardless of what it says.

## What this buys us vs. what it doesn't

Containerization limits *blast radius* — a bad script corrupts a mounted file or wastes container resources, not the host filesystem or the database. It does not replace: reviewing generated scripts before they're trusted for a new `TargetSchema`/rule combination the system hasn't run before, monitoring `ScraperRun`/`CleaningRun` logs, or the human-in-the-loop audit step itself. Sandboxing is the containment layer; the audit chat is the correctness layer.

## Phase 0 spike status — RESULT: pattern validated, 9/9 checks passing

Spike lives in [`/spikes/docker-sandbox`](../spikes/docker-sandbox/README.md), run for real (not just read from `docker run` flag documentation):

- **File I/O + stdout capture** — a well-behaved script read from the read-only input mount, wrote to the read-write output mount, and its stdout was captured. PASS.
- **Network isolation (`--network none`)** — a script attempting an outbound socket connection got `[Errno 101] Network is unreachable`, not a successful connection. PASS.
- **Timeout enforcement** — an infinite-loop script was killed within the configured window by the host-side `timeout` wrapper (not left hanging). PASS — **with a real caveat found later.** During Phase 3 the container from this exact test was discovered still *running* 12 hours after the spike, orphaned: `timeout --signal=KILL` killed the `docker run` CLI *client* process, but a killed client can't forward a signal to the container it was attached to, so the container itself never got the kill. The client-side timeout enforcement genuinely worked (the spike's test correctly measured that); container-level cleanup did not, and nothing in the spike's own checks was positioned to catch that gap. **Fixed in the production executor** (`apps/ai-service/app/sandbox.py`, Phase 3): using the Docker SDK to call `container.kill()` directly against the Docker API, independent of any CLI client process, confirmed (by deliberately forcing a timeout) to leave no orphaned container. If this spike's shell-script pattern is ever reused standalone, add an explicit `docker ps` check after a timeout-triggered run, not just a process-level assertion.
- **Read-only input mount** — a script attempting to write into its input file got `[Errno 30] Read-only file system`; the original file was verified unmodified afterward. PASS.

**One real issue found and fixed:** the fixed in-image `uid 10001` (`USER sandbox` in the Dockerfile) couldn't write to a bind-mounted output directory owned by the host user — a classic host/container UID mismatch. Fixed by running the container with `--user "$(id -u):$(id -g)"` (the *invoking* host user's own uid/gid) instead of a fixed in-image uid. Still non-root, still isolated, but ownership of bind-mounted directories now lines up automatically. This is the pattern the real FastAPI orchestration service should use: run sandbox containers as its own service uid, not a hardcoded one baked into the sandbox image.

**Not yet stress-tested:** memory/CPU limits under actual pressure (a script that tries to exceed `--memory=256m`, or burn more than `--cpus=1`) — the flags are set and trusted per Docker's documented behavior, but not independently verified here since network/filesystem/timeout are the properties with real security consequences if wrong. Worth a quick check during Phase 3 implementation.

## Phase 5 scraper sandbox — network-enabled exception, tested for real

`apps/ai-service/app/scraper_sandbox.py` deliberately diverges from the cleaning sandbox in the two ways documented in its own module docstring (network allowed; read-write over the scraper's own directory rather than split input/output mounts). Tested end-to-end against a safe synthetic fixture (a fake scraper hitting only `https://api.github.com`, never a real platform) with `docker-py`, not shell-scripted `docker run` — same orphaned-container lesson from Phase 3 applied up front rather than rediscovered.

**Real bug class re-confirmed, not newly introduced:** during manual ad-hoc testing (invoking the ai-service container directly with `docker run`, outside docker-compose), a `PermissionError` surfaced when the scraper script tried to `os.makedirs()` inside its mounted directory, even though the sandbox container was passed `user="0:0"`. Root cause: `cap_drop=["ALL"]` strips `CAP_DAC_OVERRIDE` even from uid 0, so root loses its usual permission-check bypass and gets evaluated as an ordinary "other" user against the mounted directory's mode bits — denied, since it neither owns the directory nor belongs to its group. This is *not* a bug in `scraper_sandbox.py` itself: in the real docker-compose deployment, `ai-service` runs as `${APP_UID}:${APP_GID}`, which is set to match the actual owner of the bind-mounted scraper directories, so the container's own uid is never a stranger to the mount it's writing into. It only surfaced because my ad-hoc test invocation of the *outer* ai-service container omitted `--user`, defaulting it to root, which then got propagated as the sandbox child's `user=f"{uid}:{gid}"`. Re-ran the outer container with `--user 1000:1000` (matching the actual host directory owner) and the full happy path passed: `exit_code: 0`, `matched_signals` correctly included the watched-for completion string, `new_files` correctly listed the one genuinely-new output file. Lesson for future manual/ad-hoc testing of this service: always invoke it with `--user` matching the mounted directories' owner, exactly as docker-compose does — a bare `docker run` without `--user` is not a faithful reproduction of production and will produce misleading permission failures.
