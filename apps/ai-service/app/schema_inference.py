"""Infers a source_schema (docs/05-llm-prompting.md shape) from a real
uploaded file. Runs un-sandboxed in ai-service's own process — a
deliberately narrower operation than executing LLM-generated code (the
actual threat model in docs/06-security-sandboxing.md): this only ever
calls pandas' own CSV/Excel readers on a file the signed-in user uploaded
themselves, never runs generated or scraped code.
"""
import os

import pandas as pd

from app.config import config


class SchemaInferenceError(Exception):
    pass


def infer_schema(input_relative_path: str, original_filename: str, max_samples: int = 3) -> list[dict]:
    path = os.path.join(config.storage_root, input_relative_path)
    if not os.path.exists(path):
        raise SchemaInferenceError(f"No file at {input_relative_path}")

    ext = os.path.splitext(original_filename)[1].lower()
    try:
        if ext in (".xlsx", ".xls"):
            df = pd.read_excel(path, dtype=str)
        else:
            df = pd.read_csv(path, dtype=str)
    except Exception as e:
        raise SchemaInferenceError(f"Could not parse {original_filename}: {e}") from e

    total = len(df)
    schema = []
    for col in df.columns:
        values = df[col]
        non_null = values.dropna()
        non_null = non_null[non_null.astype(str).str.strip() != ""]
        null_pct = round(100 * (total - len(non_null)) / total, 1) if total else 0.0
        schema.append(
            {
                "name": str(col),
                "inferred_dtype": "string",
                "null_pct": null_pct,
                "sample_values": [str(v) for v in non_null.head(max_samples).tolist()],
            }
        )
    return schema


def get_current_columns(dataset_file_relative_path: str) -> list[str]:
    """Just the column names of an already-cleaned file — used to build the
    edit prompt's CONTEXT: CURRENT COLUMNS (app/prompting.py's
    build_edit_system_prompt), not a full schema inference.
    """
    path = os.path.join(config.storage_root, dataset_file_relative_path)
    if not os.path.exists(path):
        raise SchemaInferenceError(f"No file at {dataset_file_relative_path}")
    return pd.read_csv(path, dtype=str, nrows=0).columns.tolist()


def compute_summary_stats(dataset_file_relative_path: str, low_cardinality_threshold: int = 10) -> dict:
    """Aggregates only, never raw rows — docs/05-llm-prompting.md's rule for
    chat/reasoning prompts. Used to answer questions about the data without
    the model ever seeing individual rows.
    """
    path = os.path.join(config.storage_root, dataset_file_relative_path)
    if not os.path.exists(path):
        raise SchemaInferenceError(f"No file at {dataset_file_relative_path}")
    df = pd.read_csv(path, dtype=str)

    null_counts = {}
    distinct_value_counts = {}
    for col in df.columns:
        values = df[col]
        non_null = values.dropna()
        non_null = non_null[non_null.astype(str).str.strip() != ""]
        null_counts[col] = int(len(df) - len(non_null))
        distinct = non_null.value_counts()
        if len(distinct) <= low_cardinality_threshold:
            distinct_value_counts[col] = {str(k): int(v) for k, v in distinct.items()}

    return {
        "row_count": len(df),
        "columns": df.columns.tolist(),
        "null_counts_per_column": null_counts,
        "distinct_value_counts_for_low_cardinality_columns": distinct_value_counts,
    }
