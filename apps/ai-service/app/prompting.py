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
import json
import re


def build_system_prompt(source_schema: list[dict], target_schema: list[dict], cleaning_rules: list[dict]) -> str:
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


# --- Chat (Phase 4, docs/04-ai-cleaning-and-audit.md) ---------------------

INTENT_EDIT = "edit_request"
INTENT_AUDIT = "audit_request"
INTENT_QUESTION = "question"


def build_intent_classification_prompt() -> str:
    # Deliberately tiny and separate from the main chat prompts — docs/05's
    # "keep it a separate, minimal prompt... should be cheap and fast."
    # Signal phrases are pattern-generous, not a keyword match ("Audit the
    # Contacts sheet" and "Audit all data" aren't the same phrasing), so
    # this still needs a real classification call, just a minimal one.
    return f"""Classify the user's message into exactly one category. Respond with
EXACTLY ONE WORD, no punctuation, no explanation: {INTENT_EDIT}, {INTENT_AUDIT}, or {INTENT_QUESTION}.

- {INTENT_EDIT}: the user wants the data changed (fix, correct, remove, combine, reformat, ...).
- {INTENT_AUDIT}: the user is explicitly asking for a full audit/quality report of the data
  (e.g. "audit this", "audit the Contacts sheet", "give me a full report", "check everything").
- {INTENT_QUESTION}: anything else — the user is asking about the data without requesting a change or a full audit."""


class UnrecognizedIntentError(Exception):
    pass


def parse_intent(text: str) -> str:
    normalized = text.strip().lower().rstrip(".")
    for intent in (INTENT_EDIT, INTENT_AUDIT, INTENT_QUESTION):
        if intent in normalized:
            return intent
    raise UnrecognizedIntentError(f"Could not parse an intent from: {text!r}")


def build_edit_system_prompt(
    target_schema: list[dict], cleaning_rules: list[dict], current_columns: list[str]
) -> str:
    # Same OUTPUT CONTRACT as the initial cleaning prompt (no `report` —
    # see this module's top docstring for why) but framed around a single
    # user-requested change to data that's ALREADY in the target shape,
    # not an initial raw-to-target transformation. Still routed through
    # the identical sandbox as the initial clean — docs/04: "There is no
    # 'trusted' tier of LLM-generated code just because it came from a
    # chat turn instead of the initial upload."
    return f"""You are a Python/Pandas code generator embedded in a data-cleaning pipeline.
The DataFrame you receive is ALREADY in the target shape (see CONTEXT: CURRENT COLUMNS) — the
user is requesting ONE additional, specific change to it, not a from-scratch transformation.

OUTPUT CONTRACT (strict):
- Respond with EXACTLY ONE fenced Python code block. No prose before or after.
- The code must define a single function: clean(df: pd.DataFrame) -> pd.DataFrame
- Make ONLY the change the user asked for. Do not alter columns/rows the request
  doesn't concern, and do not re-apply or undo any of the original CLEANING RULES —
  those already happened; this is an incremental edit on top of their result.
- Do not read files, do not print anything, do not import anything beyond
  pandas/numpy/re/datetime.
- Never fabricate data.

CONTEXT: CURRENT COLUMNS
{json.dumps(current_columns)}

CONTEXT: TARGET SCHEMA (for reference — already applied once; don't redo it)
{json.dumps(target_schema, indent=2)}

CONTEXT: ORIGINAL CLEANING RULES (for reference — already applied once; don't redo them)
{json.dumps(cleaning_rules, indent=2)}"""


def build_question_system_prompt(target_schema: list[dict], summary_stats: dict) -> str:
    # Aggregates only, never raw rows — docs/05's "Chat/reasoning prompts...
    # get the same schema-level context plus small aggregate summaries...
    # rather than raw rows."
    return f"""You are a data assistant answering questions about a cleaned dataset. Answer the
user's question conversationally and concisely using ONLY the aggregate information below —
you do not have access to individual rows. If the question can't be answered from these
aggregates, say so rather than guessing.

CONTEXT: TARGET SCHEMA
{json.dumps(target_schema, indent=2)}

CONTEXT: DATASET SUMMARY
{json.dumps(summary_stats, indent=2)}"""
