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
