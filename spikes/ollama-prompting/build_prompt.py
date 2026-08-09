"""Builds the exact system prompt shape documented in docs/05-llm-prompting.md
for cleaning-script generation: source schema (columns/dtypes/null%/samples,
NOT the full dataset), target schema, and structured cleaning rules.

This mirrors what the real FastAPI orchestration service would build from
an UploadedFile + TargetSchema + CleaningRule records — hand-assembled here
since those don't exist yet, but same shape.
"""
import csv
import json
from pathlib import Path

HERE = Path(__file__).parent
SAMPLE_INPUT = HERE / "sample_input.csv"


def summarize_source_schema(csv_path, max_samples=3):
    with open(csv_path, newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    columns = reader.fieldnames
    total = len(rows)
    summary = []
    for col in columns:
        values = [r[col] for r in rows]
        non_null = [v for v in values if v.strip()]
        null_pct = round(100 * (total - len(non_null)) / total, 1) if total else 0
        summary.append({
            "name": col,
            "inferred_dtype": "string",
            "null_pct": null_pct,
            "sample_values": non_null[:max_samples],
        })
    return summary


TARGET_SCHEMA = [
    {"name": "full_name", "type": "string", "required": True,
     "description": "Contact's full name."},
    {"name": "phone", "type": "string", "required": True,
     "description": "A single normalized phone number, digits only (no punctuation)."},
    {"name": "email", "type": "string", "required": False,
     "description": "Contact email address."},
    {"name": "address", "type": "string", "required": False,
     "description": "Combined street/city/state/postal address as one string."},
]

CLEANING_RULES = [
    {
        "rule": "combine_phone",
        "description": (
            "Mobile and Landline (home) phone columns must combine into a single "
            "'phone' column. Prefer mobile_phone when both are present; fall back "
            "to home_phone when mobile is missing. Strip all non-digit characters."
        ),
    },
    {
        "rule": "combine_name",
        "description": "Combine first_name and last_name into 'full_name', space-separated. If last_name is missing, use first_name alone.",
    },
    {
        "rule": "combine_address",
        "description": "Combine street_address, city, state, postal_code into a single 'address' string, comma-separated, omitting any parts that are missing.",
    },
]


def build_system_prompt(source_schema):
    return f"""You are a Python/Pandas code generator embedded in a data-cleaning pipeline.

OUTPUT CONTRACT (strict):
- Respond with EXACTLY ONE fenced Python code block. No prose before or after.
- The code must define a single function: clean(df: pd.DataFrame) -> pd.DataFrame
- Do not read files, do not print except for a final summary dict assignment
  to a variable named `report`, do not import anything beyond pandas/numpy/re/datetime.
- Never fabricate data. If a required target column cannot be derived from the
  available source columns, leave it null and record it in report["unmapped_fields"].
- Follow every rule in CLEANING RULES exactly — they are non-negotiable, not
  suggestions to weigh against your own judgment.

CONTEXT: SOURCE SCHEMA
{json.dumps(source_schema, indent=2)}

CONTEXT: TARGET SCHEMA
{json.dumps(TARGET_SCHEMA, indent=2)}

CONTEXT: CLEANING RULES
{json.dumps(CLEANING_RULES, indent=2)}"""


if __name__ == "__main__":
    schema = summarize_source_schema(SAMPLE_INPUT)
    prompt = build_system_prompt(schema)
    (HERE / "system_prompt.txt").write_text(prompt)
    print(prompt)
