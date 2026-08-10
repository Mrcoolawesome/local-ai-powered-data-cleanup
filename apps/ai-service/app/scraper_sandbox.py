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

v1 scope note: this runs the scraper to completion (or timeout) and
inspects the FULL captured output afterward for watch_signal matches,
rather than streaming stdout in real time to abort early on a rate-limit
signal. Real-time monitoring is a reasonable future improvement, not
implemented here — documented as a deliberate v1 simplification, not an
oversight.
"""
import os
import time

import docker
from docker.errors import ImageNotFound

from app.config import config

SCRAPER_IMAGE_PYTHON = "data-cleanup-scraper-python:latest"
SCRAPER_IMAGE_NODE = "data-cleanup-scraper-node:latest"
SCRAPER_DOCKERFILE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "scraper-sandbox")


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


def run_scraper(
    scraper_dir_relative_path: str,
    runtime: str,
    setup_commands: list[str],
    run_command: str,
    watch_signals: list[str],
    timeout_seconds: int = 300,
) -> dict:
    """Runs setup_commands then run_command inside the scraper's own
    directory, network-enabled, read-write. Returns
    {exit_code, logs, matched_signals, timed_out}.
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

    container = client.containers.run(
        image,
        command=["sh", "-c", full_script],
        detach=True,
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

    timed_out = False
    try:
        container.wait(timeout=timeout_seconds)
    except Exception:
        timed_out = True
        container.kill()
    logs = container.logs().decode(errors="replace")
    exit_code = container.attrs.get("State", {}).get("ExitCode", -1)
    container.remove(force=True)

    matched_signals = [s for s in watch_signals if s in logs]

    return {"exit_code": exit_code, "logs": logs, "matched_signals": matched_signals, "timed_out": timed_out}


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
        dirs[:] = [d for d in dirs if d not in excluded_dirs]
        for name in files:
            if name in excluded_names or name.endswith(excluded_suffixes):
                continue
            full_path = os.path.join(root, name)
            if os.path.getmtime(full_path) >= since_epoch:
                found.append(os.path.relpath(full_path, local_scraper_dir))
    return found
