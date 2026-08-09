# AI Cleaning Engine & Human-in-the-Loop Audit

## Initial upload → cleaning → audit report

1. Next.js sends FastAPI: the raw file's inferred schema (column names, types, a small sample of rows — not the full dataset), the target `TargetSchema`, and the applicable `CleaningRule`s.
2. FastAPI prompts the LLM to produce a Pandas script (see [05-llm-prompting.md](./05-llm-prompting.md)).
3. The script runs against the *actual* file inside the Docker sandbox — this is the only point where the full dataset is touched, and it never enters the LLM's context window.
4. The sandbox returns: the transformed file, and a structured execution summary (rows processed, rows with unmappable/missing required fields, columns the script couldn't confidently map).
5. FastAPI turns that structured summary into the HTML/Markdown audit report — this is templated, not a second LLM call, so the report is consistent and doesn't hallucinate numbers that don't match the actual run.
6. Next.js persists `CleaningRun` + `AuditReport`, and renders the report as the first `ChatMessage` in a new `ChatSession` for that dataset.

## Iterative refinement chat

After the initial report, the user and the LLM go back and forth. Each user message is routed through an **intent classification step** before anything else happens — this is the mechanism behind the spec's requirement that the AI *not* auto-generate a full audit on every turn, but *does* recognize an explicit audit request:

```
User message
     │
     ▼
Intent classifier (cheap, fast prompt — not the full agent)
     │
     ├── "edit_request"   → LangChain/PandasAI agent mutates the Dataset,
     │                       replies conversationally with what changed
     │
     ├── "audit_request"  → regenerate a full AuditReport (step 3-5 above,
     │                       re-run against current Dataset state)
     │
     └── "question"       → agent answers from Dataset state, no mutation
```

Signal phrases for `audit_request` should be pattern-generous rather than an exact-match list (the spec's own examples — "Audit the Contacts sheet," "Audit all data" — aren't the same phrasing), so this is itself a small LLM classification call, not a keyword match. Keep it a *separate*, minimal prompt from the main agent turn — classifying intent doesn't need the full rules/schema context and should be cheap and fast.

## Why PandasAI / LangChain DataFrame agent specifically

- The agent needs to reason about *which* columns/rows a natural-language edit request refers to, then emit an operation the sandbox can execute — this is exactly the DataFrame-agent pattern (LLM writes pandas-manipulating code from an NL instruction, framework executes it, returns the result).
- Every agent-emitted operation — not just the initial cleaning script — goes through the same Docker sandbox as [06-security-sandboxing.md](./06-security-sandboxing.md) describes. There is no "trusted" tier of LLM-generated code just because it came from a chat turn instead of the initial upload.

## On-demand full audit

Same pipeline as the initial audit (step 3-5), just re-triggered against the Dataset's *current* state instead of the freshly-uploaded raw file, and appended to the existing `ChatSession` rather than starting a new one.
