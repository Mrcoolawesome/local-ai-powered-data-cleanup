"""On-demand audit recompute (docs/04-ai-cleaning-and-audit.md's "On-demand
full audit"): re-derives the report against the dataset's CURRENT file,
without re-running the LLM or the sandbox — the report is a deterministic
function of (current data, TargetSchema), so recomputing it is just
`compute_report` again, not a new generation.

Reads the file directly, un-sandboxed — same scoped reasoning as
app/schema_inference.py: this only ever reads a file our own pipeline
already produced (the last cleaning/edit run's output), via pandas' mature
CSV reader, never executes generated or scraped code.
"""
import os

import pandas as pd

from app.config import config
from app.report import compute_report


class AuditRecomputeError(Exception):
    pass


def recompute_audit(dataset_file_relative_path: str, target_schema: list[dict]) -> dict:
    path = os.path.join(config.storage_root, dataset_file_relative_path)
    if not os.path.exists(path):
        raise AuditRecomputeError(f"No file at {dataset_file_relative_path}")

    try:
        df = pd.read_csv(path, dtype=str)
    except Exception as e:
        raise AuditRecomputeError(f"Could not read {dataset_file_relative_path}: {e}") from e

    report = compute_report(df, target_schema)
    measured = {
        "input_row_count": len(df),
        "output_row_count": len(df),
        "output_columns": list(df.columns),
    }
    return {"report": report, "measured": measured}
