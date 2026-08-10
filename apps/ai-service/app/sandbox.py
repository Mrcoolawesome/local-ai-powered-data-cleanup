"""Docker sandbox executor — productionizes spikes/docker-sandbox's proven
pattern (9/9 checks: file I/O, network isolation, timeout enforcement,
read-only mounts) inside the real ai-service.

Docker-outside-of-Docker (docs/11-deployment.md "sandbox-orchestration"):
ai-service runs inside its own container but launches sandbox containers as
*siblings* via the host's Docker daemon (mounted socket), not nested inside
itself. The critical consequence: every bind-mount source passed to the
daemon must be a HOST filesystem path, not a path in ai-service's own
container. config.host_storage_path is how ai-service translates "a file I
can see at {storage_root}/x" into "the path the daemon needs for a sibling
container's mount" — see config.py.
"""
import json
import os
import shutil
import uuid

import docker
from docker.errors import ImageNotFound

from app.config import config

SANDBOX_IMAGE = "data-cleanup-sandbox:latest"
SANDBOX_DOCKERFILE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "sandbox")


class SandboxError(Exception):
    """Raised when the sandboxed execution fails, times out, or produces no output."""


def _client() -> docker.DockerClient:
    return docker.from_env()


def _ensure_image(client: docker.DockerClient) -> None:
    """Builds the sandbox image on first use. Image builds send the whole
    context as data over the Docker API — unlike a bind-mount source, the
    Dockerfile's path only needs to exist in ai-service's OWN container,
    not on the host. No host-path translation needed here, only for the
    bind mounts in run_cleaning below.
    """
    try:
        client.images.get(SANDBOX_IMAGE)
    except ImageNotFound:
        client.images.build(path=SANDBOX_DOCKERFILE_DIR, tag=SANDBOX_IMAGE, rm=True)


def _read_call_for(original_filename: str) -> str:
    ext = os.path.splitext(original_filename)[1].lower()
    if ext in (".xlsx", ".xls"):
        return 'pd.read_excel("/work/input/data' + ext + '", dtype=str)'
    return 'pd.read_csv("/work/input/data.csv", dtype=str)'


def _build_harness(generated_code: str, target_schema: list[dict], original_filename: str) -> str:
    read_call = _read_call_for(original_filename)
    # The harness computes the report itself from TargetSchema's
    # required/structurallyOptional flags cross-referenced against the
    # ACTUAL output — the model no longer produces a report at all, per
    # docs/05-llm-prompting.md's "Verification, not blind trust" (two
    # independent real generations broke trying to satisfy that part of
    # an earlier contract; the harness has better ground truth anyway).
    return f'''import json
import pandas as pd

df = {read_call}

{generated_code}

cleaned_df = clean(df)
cleaned_df.to_csv("/work/output/cleaned.csv", index=False)

target_schema = {target_schema!r}

report = {{"unmapped_fields": [], "flagged_gaps": []}}
for col in target_schema:
    name = col["name"]
    # A column the model's clean() didn't produce at all is exactly as
    # much a gap as one that exists but is 100% null — found the hard way
    # in a real end-to-end run: a required column the model never
    # attempted was recorded in unmapped_fields but skipped by `continue`
    # before the required/severity check ever ran, so the report claimed
    # "no required fields missing" while a required field was, in fact,
    # entirely missing. Treat "absent" as "null on every row" for scoring,
    # while still recording it in unmapped_fields for visibility into
    # *why* (the model didn't even try, vs. it tried and produced nulls).
    if name not in cleaned_df.columns:
        report["unmapped_fields"].append(name)
        null_count = len(cleaned_df)
    else:
        null_count = int(cleaned_df[name].isna().sum() + (cleaned_df[name].astype(str) == "").sum())
        if null_count == 0:
            continue
    if col["required"]:
        report["flagged_gaps"].append({{"column": name, "null_count": null_count, "severity": "required_missing"}})
    elif not col["structurallyOptional"]:
        report["flagged_gaps"].append({{"column": name, "null_count": null_count, "severity": "unexpected_gap"}})
    # required=False and structurallyOptional=True: expected sparsity, not flagged.

measured = {{
    "input_row_count": len(df),
    "output_row_count": len(cleaned_df),
    "output_columns": list(cleaned_df.columns),
}}

with open("/work/output/report.json", "w") as f:
    json.dump({{"report": report, "measured": measured}}, f, indent=2)

print(json.dumps({{"report": report, "measured": measured}}))
'''


def run_cleaning(
    generated_code: str,
    input_relative_path: str,
    original_filename: str,
    target_schema: list[dict],
    output_relative_dir: str,
    timeout_seconds: int = 60,
) -> dict:
    """Runs generated_code's clean(df) against the file at
    {storage_root}/{input_relative_path} inside the locked-down sandbox,
    writing cleaned.csv + report.json into {storage_root}/{output_relative_dir}.
    Returns {cleaned_file_relative_path, report, measured, sandbox_logs}.
    """
    if not config.host_storage_path:
        raise SandboxError(
            "AI_SERVICE_HOST_STORAGE_PATH is not set — required to launch sandbox "
            "containers as siblings of this one. See docs/11-deployment.md."
        )

    run_id = uuid.uuid4().hex[:12]
    scratch_relative = f".sandbox-tmp/{run_id}"

    local_scratch_dir = os.path.join(config.storage_root, scratch_relative)
    local_output_dir = os.path.join(config.storage_root, output_relative_dir)
    os.makedirs(local_scratch_dir, exist_ok=True)
    os.makedirs(local_output_dir, exist_ok=True)

    script_content = _build_harness(generated_code, target_schema, original_filename)
    local_script_path = os.path.join(local_scratch_dir, "script.py")
    with open(local_script_path, "w") as f:
        f.write(script_content)

    # Host-side paths for the daemon — see module docstring. Every one of
    # these must correspond to a real path on the HOST, not inside this
    # container, or the sibling container's mounts silently point nowhere.
    host_script_path = os.path.join(config.host_storage_path, scratch_relative, "script.py")
    host_input_file = os.path.join(config.host_storage_path, input_relative_path)
    host_output_dir = os.path.join(config.host_storage_path, output_relative_dir)

    ext = os.path.splitext(original_filename)[1].lower() or ".csv"
    input_target_name = f"data{ext}"

    client = _client()
    _ensure_image(client)

    uid, gid = os.getuid(), os.getgid()

    container = client.containers.run(
        SANDBOX_IMAGE,
        command=["python3", "/work/script.py"],
        detach=True,
        network_mode="none",
        nano_cpus=1_000_000_000,  # 1.0 CPU
        mem_limit="256m",
        memswap_limit="256m",
        pids_limit=64,
        cap_drop=["ALL"],
        security_opt=["no-new-privileges"],
        read_only=True,
        tmpfs={"/tmp": f"size=64m,uid={uid},gid={gid}"},
        # Overrides the sandbox image's fixed `USER sandbox` (uid 10001) —
        # the exact host/container UID mismatch already found and fixed in
        # spikes/docker-sandbox. Running as ai-service's own uid instead
        # means it can write into host_output_dir, which ai-service itself
        # (also running as this uid — docker-compose.yml) just created.
        user=f"{uid}:{gid}",
        volumes={
            host_script_path: {"bind": "/work/script.py", "mode": "ro"},
            host_input_file: {"bind": f"/work/input/{input_target_name}", "mode": "ro"},
            host_output_dir: {"bind": "/work/output", "mode": "rw"},
        },
        remove=False,
    )

    try:
        result = container.wait(timeout=timeout_seconds)
        exit_code = result.get("StatusCode", -1)
    except Exception as e:
        container.kill()
        exit_code = -1
        logs = f"Sandbox run exceeded {timeout_seconds}s and was killed: {e}"
    else:
        logs = container.logs().decode(errors="replace")
    finally:
        container.remove(force=True)
        shutil.rmtree(local_scratch_dir, ignore_errors=True)

    report_path = os.path.join(local_output_dir, "report.json")
    if exit_code != 0 or not os.path.exists(report_path):
        raise SandboxError(f"Sandbox run failed (exit code {exit_code}):\n{logs}")

    with open(report_path) as f:
        result_data = json.load(f)

    return {
        "cleaned_file_relative_path": os.path.join(output_relative_dir, "cleaned.csv"),
        "report": result_data["report"],
        "measured": result_data["measured"],
        "sandbox_logs": logs,
    }
