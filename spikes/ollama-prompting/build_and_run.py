"""End-to-end Phase 0 quality check: real Ollama call against gemma4-e4b-262k
-> extract the generated clean() function -> splice into the fixed harness
-> execute inside the Docker sandbox spike (spikes/docker-sandbox) -> compare
the model's self-reported summary against independently measured stats.

This is the actual pipeline docs/04-ai-cleaning-and-audit.md and
docs/05-llm-prompting.md describe, run for real rather than just documented.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_prompt import SAMPLE_INPUT, build_system_prompt, summarize_source_schema

HERE = Path(__file__).parent
DOCKER_SANDBOX = HERE.parent / "docker-sandbox"
OLLAMA_URL = "http://devin-server:11434/api/chat"
MODEL = "gemma4-e4b-262k:latest"

import requests


def call_ollama(system_prompt):
    resp = requests.post(OLLAMA_URL, json={
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "Generate the cleaning script."},
        ],
        "stream": False,
        "options": {"temperature": 0.1},
    }, timeout=120)
    resp.raise_for_status()
    return resp.json()["message"]["content"]


def extract_code_block(text):
    match = re.search(r"```(?:python)?\s*\n(.*?)```", text, re.DOTALL)
    if not match:
        raise ValueError(f"No fenced code block found in model output:\n{text}")
    return match.group(1).strip()


def main():
    print("== Building prompt from source schema + target schema + rules ==")
    schema = summarize_source_schema(SAMPLE_INPUT)
    system_prompt = build_system_prompt(schema)
    (HERE / "system_prompt.txt").write_text(system_prompt)

    print(f"== Calling {MODEL} at {OLLAMA_URL} ==")
    raw_response = call_ollama(system_prompt)
    (HERE / "raw_response.txt").write_text(raw_response)
    print(f"Got {len(raw_response)} chars back. Saved to raw_response.txt")

    print("== Extracting generated code ==")
    generated_code = extract_code_block(raw_response)
    (HERE / "generated_clean.py").write_text(generated_code)
    print(generated_code)

    print("== Splicing into harness ==")
    harness = (HERE / "harness_template.py").read_text()
    marker_count = harness.count("# __SPLICE_POINT__")
    if marker_count != 1:
        raise RuntimeError(f"Expected exactly 1 splice marker, found {marker_count} — "
                            "check harness_template.py doesn't mention the marker text elsewhere.")
    combined = harness.replace("# __SPLICE_POINT__", generated_code, 1)
    combined_path = HERE / "combined_script.py"
    combined_path.write_text(combined)

    print("== Preparing sandbox input/output dirs ==")
    input_dir = HERE / "fixtures" / "input"
    output_dir = HERE / "fixtures" / "output"
    input_dir.mkdir(parents=True, exist_ok=True)
    if output_dir.exists():
        shutil.rmtree(output_dir)
    shutil.copy(SAMPLE_INPUT, input_dir / "data.csv")

    print("== Running the generated script in the Docker sandbox ==")
    result = subprocess.run(
        [str(DOCKER_SANDBOX / "run-sandboxed.sh"), str(combined_path), str(input_dir), str(output_dir), "20"],
        capture_output=True, text=True,
    )
    print(result.stdout)
    print(result.stderr, file=sys.stderr)

    report_path = output_dir / "report.json"
    cleaned_path = output_dir / "cleaned.csv"
    if not report_path.exists() or not cleaned_path.exists():
        print("FAIL: sandbox run did not produce expected output files.")
        sys.exit(1)

    print("== report.json ==")
    print(report_path.read_text())
    print("== cleaned.csv ==")
    print(cleaned_path.read_text())


if __name__ == "__main__":
    main()
