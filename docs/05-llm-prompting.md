# LLM Prompting Design (gemma4-e4b-262k)

## Model & connection

- Model: `gemma4-e4b-262k:latest` — the user's custom 262k-context build of `gemma4:e4b-it-qat`, served by Ollama on `devin-server:11434`.
- **The Ollama base URL is not hardcoded anywhere.** It's read from `Settings.ollamaBaseUrl` (default `http://devin-server:11434`), editable in the Next.js Settings UI, and passed down to the FastAPI service on each request (or fetched by FastAPI from the same Settings table via Next.js). This matters because the LLM host is physically separate hardware from wherever the app runs — hardcoding it breaks the moment either machine changes.
- The large context window is *available*, not a license to dump full spreadsheets into it — see below. It's there so schema + all applicable rules + several representative sample rows + prior chat turns can coexist comfortably, not so raw data belongs in-context.

## Core rule: schema and samples in, never the full dataset

The spec is explicit about this (Strict Development Rule #4) and it's also a real cost/reliability issue: a customer spreadsheet can be tens of thousands of rows. Two separate prompt types are needed, and they must never blend:

1. **Script-generation prompts** (LLM writes code) — get column names, inferred dtypes, a handful of representative sample rows (including edge cases: nulls, mixed formats), the target schema, and the applicable cleaning rules. The LLM never sees the full column of data — it writes code that operates on the real data inside the sandbox, where the code, not the model, touches every row.
2. **Chat/reasoning prompts** (LLM answers questions, plans edits) — get the same schema-level context plus small aggregate summaries computed by the sandbox (row counts, null counts per column, distinct-value counts for low-cardinality columns) rather than raw rows, when the user's question needs "what does this data look like" context.

## System prompt: cleaning-script generation

Structure (not verbatim — the actual template lives in the FastAPI prompt-builder code, this is the shape):

```
[SYSTEM]
You are a Python/Pandas code generator embedded in a data-cleaning pipeline.

OUTPUT CONTRACT (strict):
- Respond with EXACTLY ONE fenced Python code block. No prose before or after.
- The code must define a single function: clean(df: pd.DataFrame) -> pd.DataFrame
- Do not read files, do not print anything, do not import anything beyond
  pandas/numpy/re/datetime.
- Never fabricate data. If a required target column cannot be derived from
  the available source columns, leave it null — do not invent a value.
- Follow every rule in CLEANING RULES exactly — they are non-negotiable, not
  suggestions to weigh against your own judgment.

[CONTEXT: SOURCE SCHEMA]
Columns: {name, inferred_dtype, null_pct, sample_values (max 5, redacted if flagged sensitive)}

[CONTEXT: TARGET SCHEMA]
{target column name, type, required flag, description} — from TargetSchema

[CONTEXT: CLEANING RULES]
{structured rules from CleaningRule, rendered deterministically — not paraphrased}

[USER]
Generate the cleaning script.
```

Key choices baked into this:
- **A strict output contract** (one code block, one named function, no narration) is what makes "strictly output executable code, not commentary" enforceable — parse failures on the FastAPI side become an explicit retry-with-correction loop rather than best-effort scraping of the model's prose.
- **Rules rendered from structured `CleaningRule` data**, not the user's raw English — keeps behavior deterministic across runs and avoids the model re-interpreting a rule slightly differently each time it's included in a prompt.
- **No `report` output from the model at all** — an earlier version of this contract asked for one; see "Verification, not blind trust" below for why that was dropped after two separate real failures, not kept as a should-fix-later note.

## System prompt: scraper command planning

A **separate** system prompt (do not reuse the cleaning-script one) — different output contract, different risk profile:

```
[SYSTEM]
You are a command-planning agent for a registered web scraper. You will be
given that scraper's full README. Produce a strict JSON plan (not prose, not
code) with fields: setup_commands, run_command, expected_output_pattern,
watch_signals (stdout patterns indicating success/failure/rate-limiting, as
documented in the README), and a confidence field. If the README does not
clearly document how to run the scraper or interpret its output, set
confidence: "low" and explain why in a `concerns` field instead of guessing.
```

JSON output (not code) here because the plan is consumed by orchestration logic that decides whether to sandbox-execute it, not executed directly — and because guessing a command from an ambiguous README is exactly the failure mode ([03-ingestion-and-scrapers.md](./03-ingestion-and-scrapers.md)'s "README drift") that `confidence`/`concerns` exists to surface to a human instead of silently running something wrong.

## System prompt: chat / iterative refinement

Includes: schema-level context (as above), the `CleaningRule`s, a short window of recent chat turns, and — critically — the intent classification result from [04-ai-cleaning-and-audit.md](./04-ai-cleaning-and-audit.md) already tells this prompt whether it's handling an edit, a question, or an audit, so this prompt doesn't have to re-decide that itself.

## Verification, not blind trust — and why the model doesn't produce a `report` at all anymore

The original design here asked the model to self-report unmapped fields as a `report` dict, with the express intent of cross-checking that claim against the sandbox's own measured stats before trusting it. In practice, that self-report turned out not to be worth collecting in the first place — not just unreliable, but a genuine source of broken generations:

- The [Phase 0 spike](../spikes/ollama-prompting/README.md) got `return cleaned_df, report` — a tuple, deviating from the documented `-> pd.DataFrame` signature.
- A later live test against the real `/clean/generate` endpoint (Phase 3) got something worse: `report = {...}` followed later, in the same function, by `global report` — an actual Python `SyntaxError` ("name 'report' is assigned to before global declaration"), not merely a style deviation.

Two independent failures of the same instruction, on two different real prompts, is enough to call this a model-size limitation rather than a wording problem to keep patching. The fix: **stop asking the model for a report at all.** The harness always has ground truth — `TargetSchema.columns`' `required`/`structurallyOptional` flags — so it computes the report itself from the actual output DataFrame (which required columns ended up null, whether structurally-optional columns being null is expected, actual row count) rather than trusting anything the model claims about its own output. This is strictly more reliable, not a workaround: the model was never going to reliably reason about which gaps are structurally expected anyway (see [10-target-schema-reference.md](./10-target-schema-reference.md)'s Design Implication) — that's exactly the kind of judgment the harness's access to `TargetSchema` metadata is already better positioned to make deterministically. See `apps/ai-service/app/sandbox.py` for where this report actually gets built.

## Phase 0 spike status — RESULT: prompt design produces correct cleaning logic

Spike lives in [`/spikes/ollama-prompting`](../spikes/ollama-prompting/README.md), run for real against `gemma4-e4b-262k:latest` and through the Docker sandbox spike.

- **Correctness: 6/6 rows verified correct by hand** against three cleaning rules (phone preference/normalization, name combination, address joining) on a synthetic dirty dataset, including the one genuinely hard case (a row with no phone data in either source column) — the model correctly left the required field null rather than fabricating a value.
- The tuple-return deviation found here is what eventually led to dropping the `report` requirement entirely in Phase 3 — see "Verification, not blind trust" above.
