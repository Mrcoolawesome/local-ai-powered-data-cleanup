"""Report computation, shared between two call sites that must never drift
apart:

1. Inside the Docker sandbox, as part of a cleaning/edit run — embedded
   into the harness script as literal source text (via inspect.getsource()
   in sandbox.py), because code running inside the sandbox can't `import`
   anything from this package.
2. On-demand audit recompute (Phase 4, docs/04's "On-demand full audit") —
   called directly, un-sandboxed, against the dataset's current file.

A subtle bug already lived in this exact logic once (Phase 3: a required
column the model didn't produce at all was skipped by a `continue` before
the required-field check ran, so it never got flagged) — keeping it in
exactly one place, reused by both call sites, is what prevents a second
copy from quietly reintroducing that same class of bug or drifting from a
fix made to the other one.

Because this function's source is embedded verbatim into the sandboxed
harness, it must be self-contained: no imports beyond what the harness
already has in scope (pandas as pd), no closures over outside state, no
calls to anything not defined in its own body.
"""


def compute_report(cleaned_df, target_schema):
    report = {"unmapped_fields": [], "flagged_gaps": []}
    for col in target_schema:
        name = col["name"]
        if name not in cleaned_df.columns:
            report["unmapped_fields"].append(name)
            null_count = len(cleaned_df)
        else:
            null_count = int(cleaned_df[name].isna().sum() + (cleaned_df[name].astype(str) == "").sum())
            if null_count == 0:
                continue
        if col["required"]:
            report["flagged_gaps"].append({"column": name, "null_count": null_count, "severity": "required_missing"})
        elif not col["structurallyOptional"]:
            report["flagged_gaps"].append({"column": name, "null_count": null_count, "severity": "unexpected_gap"})
        # required=False and structurallyOptional=True: expected sparsity, not flagged.
    return report
