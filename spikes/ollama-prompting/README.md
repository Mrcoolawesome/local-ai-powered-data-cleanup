# Ollama / Gemma Prompting — Phase 0 Spike

Validates the cleaning-script-generation prompting design in [`/docs/05-llm-prompting.md`](../../docs/05-llm-prompting.md) against the real model (`gemma4-e4b-262k:latest` on `devin-server:11434`), and validates that a real LLM-generated script actually runs correctly through the Docker sandbox from [`/spikes/docker-sandbox`](../docker-sandbox/README.md) — the full pipeline end to end, not each piece in isolation.

**Status: done. The model's generated script was verified 100% correct, row by row, against the cleaning rules.**

```bash
python3 build_and_run.py
```

## What it does

1. `build_prompt.py` computes a schema summary (columns, dtypes, null%, up to 3 sample values) from `sample_input.csv` — a synthetic (not real customer data) messy contacts sheet modeled on the dirty-data patterns in [`docs/10-target-schema-reference.md`](../../docs/10-target-schema-reference.md) — and builds the exact system prompt shape `docs/05-llm-prompting.md` specifies: source schema + target schema + structured cleaning rules, never the full dataset.
2. `build_and_run.py` sends that prompt to the real model, extracts the returned `clean(df)` function, splices it into a fixed harness (`harness_template.py`) that does the actual file I/O — matching the design principle that the model only ever produces the transformation logic, never touches file paths itself — and runs the combined script through the Docker sandbox spike.
3. Compares the model's self-reported summary against independently measured stats (row counts, null counts) computed by the harness itself, per `docs/04-ai-cleaning-and-audit.md`'s "verify, don't blindly trust the model's own claims" principle.

## Real result

Given three cleaning rules (combine mobile/home phone preferring mobile, combine first/last name, combine address parts) against 6 synthetic dirty rows, the generated script's output was checked by hand against every rule for every row:

| Row | Expected | Got | Correct? |
|---|---|---|---|
| Alice Nguyen | mobile phone, all fields present | matched exactly | ✓ |
| Bob (no last name) | `full_name="Bob"`, mobile preferred over home | matched exactly | ✓ |
| Carla Reyes | mobile missing → fall back to home phone, dots stripped | matched exactly | ✓ |
| David Chen | phone present, email/address partial | matched exactly | ✓ |
| Emma Patel | **no phone data at all** — required field | left null, not fabricated | ✓ |
| Frank Osei | all fields present | matched exactly | ✓ |

**6/6 rows correct**, including the one genuinely hard case (Emma, with no phone data in either source column) — the model left the required `phone` field null rather than inventing a value, which is exactly the "never fabricate data" instruction working as intended.

## Two real issues found and fixed (in our harness, not the model)

1. **Harness bug:** the splice-point marker text (`# GENERATED_CODE_GOES_HERE`) also appeared in the harness's own docstring, explaining what the marker does. `str.replace()` matched *both* occurrences and spliced the generated code into the middle of the docstring, corrupting it (`IndentationError`). Fixed by renaming the marker to something that isn't also used in prose (`# __SPLICE_POINT__`), and by making `build_and_run.py` assert exactly one match before splicing.
2. **Output-contract mismatch:** the model returned `(cleaned_df, report)` as a tuple rather than following the letter of the contract (`clean(df) -> pd.DataFrame`, with `report` left as a separately accessible variable). This is a natural Python idiom for "return two related things," and a 7.5B-class quantized model reached for it despite the prompt's explicit instruction not to. **Fixed defensively in the harness**, not by re-fighting the prompt: it now accepts either a bare DataFrame return or a `(df, report)` tuple. Recommendation for the real implementation ([docs/05-llm-prompting.md](../../docs/05-llm-prompting.md)): build the orchestrator's harness to tolerate this from the start rather than assuming strict contract compliance — prompt wording alone isn't reliable enough at this model size to skip that defensive handling.

## What this proves

The prompting design in `docs/05-llm-prompting.md` — schema/samples-only context, structured rules, strict-but-not-perfectly-followed output contract — produces genuinely correct cleaning logic from this model on a representative dirty dataset, and the full generate → sandbox-execute pipeline works end to end. The one gap (contract compliance) has a known, already-implemented mitigation.
