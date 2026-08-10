"""Cleaning-script generation prompt, per docs/05-llm-prompting.md.

The OUTPUT CONTRACT here deliberately does NOT ask the model for a `report`
variable/return value, unlike the original spikes/ollama-prompting version.
Two independent real test runs against gemma4-e4b-262k each produced a
different broken/deviant attempt at satisfying that part of the contract:
the spike got `return cleaned_df, report` (a tuple, not the documented
`-> pd.DataFrame`); a later live test against this exact endpoint got
`report = {...}` followed later by `global report` in the same function —
which is an actual Python SyntaxError ("name 'report' is assigned to
before global declaration"), not just a stylistic deviation. Prompt wording
alone clearly isn't reliable at this model size for a two-channel return.

Since the harness always has ground truth for what "should" be present
(TargetSchema's required/structurallyOptional flags) and docs/04's
"Verification, not blind trust" principle already meant the model's
self-report was only ever a claim to be cross-checked, not authoritative —
dropping it from the model's job entirely and computing the report
post-hoc from the actual output DataFrame is strictly more reliable, not
just a workaround. See app/sandbox.py for where that report is built.
"""
import re


def build_system_prompt(source_schema: list[dict], target_schema: list[dict], cleaning_rules: list[dict]) -> str:
    import json

    return f"""You are a Python/Pandas code generator embedded in a data-cleaning pipeline.

OUTPUT CONTRACT (strict):
- Respond with EXACTLY ONE fenced Python code block. No prose before or after.
- The code must define a single function: clean(df: pd.DataFrame) -> pd.DataFrame
- Do not read files, do not print anything, do not import anything beyond
  pandas/numpy/re/datetime.
- Never fabricate data. If a required target column cannot be derived from
  the available source columns, leave it null — do not invent a value.
- Follow every rule in CLEANING RULES exactly — they are non-negotiable, not
  suggestions to weigh against your own judgment.

CONTEXT: SOURCE SCHEMA
{json.dumps(source_schema, indent=2)}

CONTEXT: TARGET SCHEMA
{json.dumps(target_schema, indent=2)}

CONTEXT: CLEANING RULES
{json.dumps(cleaning_rules, indent=2)}"""


class NoCodeBlockError(Exception):
    """Raised when the model's response doesn't contain a fenced code block."""


def extract_code_block(text: str) -> str:
    # Same extraction pattern spikes/ollama-prompting/build_and_run.py used
    # successfully — a model at this size occasionally still wraps the code
    # in a little prose despite the OUTPUT CONTRACT, so this deliberately
    # doesn't require the fence to be the *entire* response.
    match = re.search(r"```(?:python)?\s*\n(.*?)```", text, re.DOTALL)
    if not match:
        raise NoCodeBlockError(f"No fenced code block found in model output:\n{text}")
    return match.group(1).strip()
