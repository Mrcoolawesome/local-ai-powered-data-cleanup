"""Fixed harness the orchestrator wraps around LLM-generated code before
executing it in the sandbox. The model only ever produces a `clean(df)`
function + a `report` dict (per the OUTPUT CONTRACT in build_prompt.py) —
it never handles file paths itself. This harness does the file I/O and
writes both the model's self-reported summary and independently measured
stats, per docs/04-ai-cleaning-and-audit.md's "Verification, not blind
trust" principle.

The splice point below is deliberately not described by name in this
docstring — build_and_run.py does a literal, one-time str.replace() on it,
and an earlier version of this file mentioned the marker's exact text here
too, which meant replace() (with no count limit) matched *both* spots and
spliced the generated code into the middle of this docstring, corrupting
it. Keep the marker's literal text out of prose anywhere in this file.
"""
import json
import pandas as pd

df = pd.read_csv("/work/input/data.csv", dtype=str)

# __SPLICE_POINT__

clean_result = clean(df)  # noqa: F821 — defined by the spliced-in generated code

# The OUTPUT CONTRACT asks the model for `clean(df) -> pd.DataFrame` plus a
# separate module-level `report` variable — but real generations (gemma4,
# tested) commonly bundle both into a `return cleaned_df, report` tuple
# instead, a very natural Python idiom that stricter wording alone doesn't
# reliably suppress on a model this size. Rather than hard-failing on a
# near-contract-compliant script, accept either shape.
if isinstance(clean_result, tuple):
    cleaned_df, report = clean_result
else:
    cleaned_df = clean_result
    if "report" not in globals():
        report = {"note": "model did not produce a report; defaulting to empty"}

cleaned_df.to_csv("/work/output/cleaned.csv", index=False)

measured = {
    "input_row_count": len(df),
    "output_row_count": len(cleaned_df),
    "output_columns": list(cleaned_df.columns),
    "null_counts_per_output_column": {
        col: int(cleaned_df[col].isna().sum() + (cleaned_df[col] == "").sum())
        for col in cleaned_df.columns
    },
}

with open("/work/output/report.json", "w") as f:
    json.dump({
        "model_self_reported": report,  # noqa: F821 — defined by generated code
        "independently_measured": measured,
    }, f, indent=2)

print("Model self-reported:", json.dumps(report))
print("Independently measured:", json.dumps(measured))
