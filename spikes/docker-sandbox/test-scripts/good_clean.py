"""Well-behaved script: reads input, does a trivial Pandas transform, writes
output, prints a summary. Stands in for a real LLM-generated cleaning script
(docs/04-ai-cleaning-and-audit.md) — proves the happy path: file I/O across
the read-only input mount / read-write output mount, and stdout capture."""
import pandas as pd

df = pd.read_csv("/work/input/data.csv")
df["full_name"] = df["first_name"] + " " + df["last_name"]
df.to_csv("/work/output/cleaned.csv", index=False)

print(f"Cleaned {len(df)} rows.")
print(f"Columns: {list(df.columns)}")
