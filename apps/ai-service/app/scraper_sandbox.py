"""Docker sandbox executor for scraper runs — docs/03-ingestion-and-scrapers.md.

Deliberately different from app/sandbox.py's cleaning-script sandbox in two
ways, both required by what a scraper actually is, not a relaxation of the
threat model without reason (docs/06-security-sandboxing.md):

1. Network IS allowed — a scraper's entire job is reaching the target
   platform. Cleaning scripts never need network; scrapers always do.
2. The mount is read-write over the scraper's OWN directory (script,
   README, saved session/.env), not a strict read-only-input/read-write-
   output split — scrapers are stateful by design (session reuse,
   resumable checkpoints; see the real HCP v2 scraper's session.json/
   progress.json in example-scrapers/), so "input" and "output" are the
   same directory here.

Everything else stays the same discipline as the cleaning sandbox: fixed,
code-reviewed container flags the LLM's plan can never influence (only
`run_command`/`setup_commands` text goes into the container as arguments,
never as additional Docker flags), non-root, resource-limited, no secrets
in the LLM's own context — the credential files are mounted directly by
the orchestrator, never read into the plan or shown to the model.

Real-time execution model: a run is started (start_scraper), then polled
(poll_scraper) until it reports "exited" — FastAPI never blocks a single
request for a whole scraper run. This isn't just responsiveness: it's
what makes AWAITING_INPUT possible at all. Found running a real scraper
against HouseCall Pro (docs/03-ingestion-and-scrapers.md): a site's own
SMS/device-verification screen can't be satisfied by anything the
orchestrator or a synthetic fixture can produce — only a human with a
phone can. A scraper that hits such a screen prints a single-line marker
(AWAITING_INPUT_MARKER below) to stdout and then blocks reading a line
from stdin (Node's `readline`, same mechanism its own interactive-login
prompt already used for a visible browser window — this just also allows
it when headless). poll_scraper recognizes that marker as the container's
current state; send_scraper_input relays a human-submitted value into the
still-running container's stdin via a raw attach socket, proven for real
against Node's readline before wiring this up (docs/03). None of this is
platform-specific — any scraper that adopts the same marker convention
gets the same pause/resume behavior for free.
"""
import os
import time

import docker
from docker.errors import ImageNotFound, NotFound

from app.config import config

SCRAPER_IMAGE_PYTHON = "data-cleanup-scraper-python:latest"
SCRAPER_IMAGE_NODE = "data-cleanup-scraper-node:latest"
SCRAPER_DOCKERFILE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "scraper-sandbox")

# A scraper prints this prefix on its own stdout line, immediately followed
# by whatever it needs from a human (e.g. "A verification code was sent to
# (XXX) XXX-1234."), then blocks reading one line from stdin. Documented in
# docs/03-ingestion-and-scrapers.md as the general convention any scraper
# can opt into — not HouseCallPro-specific.
AWAITING_INPUT_MARKER = "AWAITING_INPUT::"


class ScraperSandboxError(Exception):
    """Raised when the scraper run fails, times out, or the runtime is unsupported."""


def _client() -> docker.DockerClient:
    return docker.from_env()


def _ensure_image(client: docker.DockerClient, runtime: str) -> str:
    image = SCRAPER_IMAGE_PYTHON if runtime == "PYTHON" else SCRAPER_IMAGE_NODE
    dockerfile = f"Dockerfile.{runtime.lower()}"
    try:
        client.images.get(image)
    except ImageNotFound:
        client.images.build(path=SCRAPER_DOCKERFILE_DIR, dockerfile=dockerfile, tag=image, rm=True)
    return image


def _get_container(client: docker.DockerClient, container_id: str):
    try:
        return client.containers.get(container_id)
    except NotFound as e:
        raise ScraperSandboxError(f"No such running scraper container: {container_id}") from e


def start_scraper(
    scraper_dir_relative_path: str,
    runtime: str,
    setup_commands: list[str],
    run_command: str,
) -> dict:
    """Launches setup_commands then run_command inside the scraper's own
    directory, network-enabled, read-write, and returns immediately with
    {container_id} — does not wait for it to finish. Call poll_scraper
    with the returned id to find out what happened.
    """
    if not config.host_scrapers_path:
        raise ScraperSandboxError(
            "AI_SERVICE_HOST_SCRAPERS_PATH is not set — required to launch sandbox "
            "containers as siblings of this one. See docs/11-deployment.md."
        )
    if runtime not in ("PYTHON", "NODE"):
        raise ScraperSandboxError(f"Unsupported runtime: {runtime}")

    local_scraper_dir = os.path.join(config.scrapers_root, scraper_dir_relative_path)
    if not os.path.isdir(local_scraper_dir):
        raise ScraperSandboxError(f"No scraper directory at {scraper_dir_relative_path}")
    host_scraper_dir = os.path.join(config.host_scrapers_path, scraper_dir_relative_path)

    client = _client()
    image = _ensure_image(client, runtime)
    uid, gid = os.getuid(), os.getgid()

    # setup_commands + run_command come from the LLM's plan, but they are
    # DATA passed as a shell string to run inside the container — never
    # interpreted as additional Docker flags/mounts/capabilities. The
    # container's own isolation (network scope aside, per this module's
    # docstring) is entirely fixed by the flags below, which the plan has
    # no path to influence.
    full_script = " && ".join([*setup_commands, run_command]) if setup_commands else run_command

    environment = {"HOME": "/tmp"}
    if runtime == "NODE":
        # Found the hard way running a real Puppeteer-based scraper: its
        # own `npm install` step triggers Puppeteer's postinstall download
        # of a full Chrome build, which failed outright in this sandbox
        # ("no zip archiver is available" — no `unzip`, and even with one,
        # downloading a whole browser on every run is wasteful). Fixed by
        # bundling a system Chromium in the Node sandbox image itself
        # (Dockerfile.node) and pointing Puppeteer at it directly instead
        # — skips the download entirely rather than just making it work.
        environment["PUPPETEER_SKIP_DOWNLOAD"] = "true"
        environment["PUPPETEER_EXECUTABLE_PATH"] = "/usr/bin/chromium"

    run_kwargs = dict(
        # Wrapped in a virtual X server unconditionally, not just for
        # scripts known to need one — found for real running a Playwright
        # scraper that hardcodes a headed (non-headless) browser launch,
        # which fails outright in a container with no real display.
        # xvfb-run is a no-op in every way that matters for a script that
        # never opens a window (headless scripts, or ones with no browser
        # at all), so there's no reason to special-case which scrapers get
        # it (Dockerfile.python/Dockerfile.node both install `xvfb`).
        command=["xvfb-run", "-a", "sh", "-c", full_script],
        detach=True,
        # Required for xvfb-run specifically, found the hard way: without a
        # real init process, the sandboxed command runs as PID 1, which the
        # kernel gives special (and here, breaking) signal-handling
        # semantics — xvfb-run's own readiness handshake with Xvfb waits on
        # a SIGUSR1 that a PID-1 shell never correctly receives/forwards,
        # so it hung forever with Xvfb started but the wrapped command
        # never actually launched (confirmed via `docker exec ... ps aux`
        # showing only xvfb-run + Xvfb, nothing else, no matter how long
        # given). `init=True` runs Docker's bundled tini as real PID 1,
        # which reaps/forwards signals correctly — same fix, same reason,
        # as any "why does my container hang with a wrapper script as
        # PID 1" issue.
        init=True,
        # Keeps stdin open (and unbuffered, non-tty) for the run's whole
        # life so send_scraper_input can write to it later, in a
        # completely separate request — without this a scraper blocked on
        # readline would just see EOF immediately instead of actually
        # waiting for a human's answer.
        stdin_open=True,
        tty=False,
        working_dir="/work",
        cpu_quota=100000,  # 1.0 CPU (cpu_period defaults to 100000)
        mem_limit="1g",  # scrapers (esp. Playwright/browser automation) need more headroom than the cleaning sandbox
        memswap_limit="1g",
        pids_limit=256,
        cap_drop=["ALL"],
        security_opt=["no-new-privileges"],
        user=f"{uid}:{gid}",
        # Overriding --user to an arbitrary uid not present in the image's
        # /etc/passwd (same pattern as sandbox.py, for the same host/
        # container UID-mismatch reason) leaves $HOME unset/unwritable —
        # pip and npm both write cache files under $HOME by default and
        # fail outright without this. /tmp is writable regardless of uid
        # in both base images.
        environment=environment,
        volumes={host_scraper_dir: {"bind": "/work", "mode": "rw"}},
        remove=False,
    )
    if config.scraper_vpn_container:
        # Joins that container's existing network namespace instead of the
        # default bridge — the scraper's outbound traffic rides whatever
        # tunnel/IP that container already has set up. Nothing about the
        # VPN container itself is touched or depended on beyond its name;
        # this app has no opinion on how it's configured.
        run_kwargs["network_mode"] = f"container:{config.scraper_vpn_container}"

    container = client.containers.run(image, **run_kwargs)
    return {"container_id": container.id}


def _cleanup_stale_browser_locks(scraper_dir_relative_path: str) -> None:
    """A container that gets force-killed (timeout, or a human clicking
    Cancel — either path below) never gives a Chromium process inside it a
    chance to release its profile's SingletonLock/SingletonSocket/
    SingletonCookie files. Found for real: the NEXT run then refuses to
    launch Chromium at all — "the profile appears to be in use by another
    Chromium process on another computer <old container's short hostname>"
    — because every sandbox container gets a fresh hostname, so Chromium
    can't verify the process the stale lock references is actually dead
    (it would only trust that check within the SAME hostname). Safe to
    remove unconditionally: these three names are always safe-to-regenerate
    Chromium runtime state, never scraped data, and by construction nothing
    in a just-killed container can still be holding them.
    """
    local_scraper_dir = os.path.join(config.scrapers_root, scraper_dir_relative_path)
    lock_names = {"SingletonLock", "SingletonSocket", "SingletonCookie"}
    for root, _dirs, files in os.walk(local_scraper_dir):
        for name in files:
            if name in lock_names:
                try:
                    os.remove(os.path.join(root, name))
                except OSError:
                    pass


def poll_scraper(
    container_id: str,
    scraper_dir_relative_path: str,
    watch_signals: list[str],
    timeout_seconds: int,
    started_at: float,
) -> dict:
    """Checks a container started by start_scraper. Returns one of:
      {"state": "running", "logs": ...}
      {"state": "awaiting_input", "pending_prompt": ..., "logs": ...}
      {"state": "exited", "exit_code": ..., "logs": ..., "matched_signals": ..., "timed_out": ...}
    A container still genuinely executing past timeout_seconds is killed
    here (same protection run_scraper used to provide) — but a container
    blocked in AWAITING_INPUT is exempt, since it's correctly idle
    waiting on a human, not stuck.
    """
    client = _client()
    container = _get_container(client, container_id)
    container.reload()
    status = container.attrs.get("State", {}).get("Status")
    logs = container.logs().decode(errors="replace")

    if status == "running":
        lines = [line for line in logs.splitlines() if line.strip()]
        last_line = lines[-1] if lines else ""
        if last_line.startswith(AWAITING_INPUT_MARKER):
            return {
                "state": "awaiting_input",
                "pending_prompt": last_line[len(AWAITING_INPUT_MARKER):].strip(),
                "logs": logs,
            }

        if time.time() - started_at > timeout_seconds:
            container.kill()
            container.reload()
            logs = container.logs().decode(errors="replace")
            exit_code = container.attrs.get("State", {}).get("ExitCode", -1)
            container.remove(force=True)
            _cleanup_stale_browser_locks(scraper_dir_relative_path)
            return {
                "state": "exited",
                "exit_code": exit_code,
                "logs": logs,
                "matched_signals": [s for s in watch_signals if s in logs],
                "timed_out": True,
            }

        return {"state": "running", "logs": logs}

    # Any terminal Docker status ("exited", but also e.g. "dead") — same
    # container.reload()-before-ExitCode requirement as above; already
    # satisfied since this function always reloads before reading status.
    exit_code = container.attrs.get("State", {}).get("ExitCode", -1)
    container.remove(force=True)
    return {
        "state": "exited",
        "exit_code": exit_code,
        "logs": logs,
        "matched_signals": [s for s in watch_signals if s in logs],
        "timed_out": False,
    }


def send_scraper_input(container_id: str, text: str) -> None:
    """Writes text + a newline into a still-running container's stdin —
    the other half of the AWAITING_INPUT marker convention poll_scraper
    detects. Requesting stdin+stdout+stderr together in attach_socket's
    params is required, not cosmetic: proved for real that requesting
    stdin alone silently delivered nothing to a blocked `readline` call,
    while requesting all three streams worked (docs/03).
    """
    client = _client()
    container = _get_container(client, container_id)
    sock = container.attach_socket(params={"stdin": 1, "stdout": 1, "stderr": 1, "stream": 1})
    try:
        sock._sock.sendall((text + "\n").encode())
    finally:
        sock.close()


def cancel_scraper(container_id: str, scraper_dir_relative_path: str) -> dict:
    """Kills and removes a still-running (RUNNING or, just as often in
    practice, AWAITING_INPUT — e.g. paused on a 2FA code that's simply
    never coming) container on request. Returns whatever it had logged up
    to that point, for the record. Idempotent: a container that already
    exited on its own between the UI click and this call (or was already
    canceled once) is treated as already-gone, not an error.
    """
    client = _client()
    try:
        container = client.containers.get(container_id)
    except NotFound:
        return {"logs": ""}
    try:
        container.kill()
    except Exception:
        pass
    container.reload()
    logs = container.logs().decode(errors="replace")
    container.remove(force=True)
    _cleanup_stale_browser_locks(scraper_dir_relative_path)
    return {"logs": logs}


def list_files_modified_since(scraper_dir_relative_path: str, since_epoch: float) -> list[str]:
    """Real, adaptive ingestion — walks the scraper's directory for files
    that changed during THIS run, rather than requiring a hardcoded
    per-platform output parser. Excludes the scraper's own source/config
    (script files, .env, session/checkpoint files) so only genuinely new
    output gets ingested. Returns paths relative to the scraper's own
    directory.
    """
    local_scraper_dir = os.path.join(config.scrapers_root, scraper_dir_relative_path)
    excluded_names = {".env", "session.json", "progress.json", "jobs_api_cache.json"}
    excluded_dirs = {"venv", "node_modules", "__pycache__", ".git"}
    excluded_suffixes = (".py", ".mjs", ".js", ".md", ".json.lock")

    found = []
    for root, dirs, files in os.walk(local_scraper_dir):
        # Any hidden directory (dot-prefixed), not just the explicitly named
        # ones above — found for real setting up a persistent login-session
        # directory (docs/03-ingestion-and-scrapers.md's credentials
        # SESSION_DIR fix): a real browser profile dir holds dozens of
        # cookies/local-storage/preference files that would otherwise all
        # look like "new output" and get ingested as bogus Attachment rows
        # pointing at Chrome-internal binary state, not scraped customer data.
        dirs[:] = [d for d in dirs if d not in excluded_dirs and not d.startswith(".")]
        for name in files:
            if name in excluded_names or name.endswith(excluded_suffixes):
                continue
            full_path = os.path.join(root, name)
            if os.path.getmtime(full_path) >= since_epoch:
                found.append(os.path.relpath(full_path, local_scraper_dir))
    return found
