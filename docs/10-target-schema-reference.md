# Target Schema Reference

`apps/web/lib/target-schema.ts`'s `TARGET_SCHEMA_TEMPLATES` is seeded directly from the customer's own real migration template ("Copy of Podium Migration Template.xlsx", provided directly by the project owner — not derived or inferred from a sample export). It's the authoritative field list for what a Podium migration actually needs, covering all 8 sheets the template defines. This doc records how those columns/flags were read from that file, so the mapping stays traceable without needing to re-open the spreadsheet.

**Supersedes an earlier version of this doc** derived from a real Jobber-platform customer export (`/example-data`, gitignored — contained live PII). That version only covered 3 entity types (Contacts, Jobs, Invoices) and used different column names in places (e.g. `job_number` vs. this template's `job_id`) — useful at the time for confirming the target schema could be platform-agnostic (Jobber and House Call Pro data normalize to the same rough shape), but no longer an accurate reference for what's actually implemented now that the customer's own authoritative template exists.

## How `required` was read

The template's header row color-codes every column — dark red fill (`C00000`) for required, blue fill (`2F5597`) for optional-but-expected. That's what `required: true/false` in `TARGET_SCHEMA_TEMPLATES` maps to directly, read from the actual cell fill colors (`openpyxl`), not inferred from anything else. `structurallyOptional` is a separate judgment call this doc's earlier version already established the pattern for — a column can be real and expected (not `required: false` because it's unimportant) while still being sparse in practice for structural reasons (e.g. `unit` empty because most addresses aren't multi-unit, `next_auto_renewal` empty because most memberships aren't auto-renewing) — that's the flag the Phase 3 audit report uses to avoid drowning genuine gaps in expected sparseness.

## The 8 sheets

| Sheet (template) | Entity type (this app) | Columns | Required |
|---|---|---|---|
| Customers | `Contacts` | 15 | 1 (`first_name`) |
| Job History | `Jobs` | 18 | 4 (`job_id`, `customer_name`, `job_title`, `job_start_date`) |
| Invoices | `Invoices` | 13 | 3 (`external_id`, `status`, `total_cents`) |
| Estimates | `Estimates` | 14 | 3 (`name`, `total_cents`, `subtotal_cents`) |
| Pricebook - Services | `Pricebook - Services` | 16 | 2 (`category`, `name`) |
| Pricebook - Materials | `Pricebook - Materials` | 13 | 2 (`category`, `name`) |
| Equipment | `Equipment` | 23 | 1 (`equipment_type`) |
| Members | `Memberships` | 15 | 1 (`contact_name`) |

Column names/types/required flags are in `apps/web/lib/target-schema.ts` itself, not duplicated here — this table is for cross-checking against the source spreadsheet, not a copy of the schema.

**One data quirk in the source template, handled rather than silently reproduced:** the Members sheet has two separate columns both literally labeled `notes` (positions 13 and 16) — almost certainly a copy-paste artifact in the original spreadsheet, since nothing distinguishes what each would hold. Merged into a single `notes` column in `TARGET_SCHEMA_TEMPLATES.Memberships` rather than kept as a literal duplicate name, since this app's own column-identity model (`schemas/[id]/page.tsx`'s `addColumn`/`removeColumn`, keyed by `name`) assumes names are unique within a `TargetSchema` — two columns both named `notes` would make removing one ambiguously remove both.

**No sample data in the source file** — every sheet's data rows (beyond the header) are empty; this is a pure template, not an export with real rows to derive missingness statistics from (unlike the superseded Jobber-export version of this doc, which had real row counts and % -missing numbers). `structurallyOptional` judgment calls here are carried over from that earlier version's reasoning (the same *kind* of field tends to be structurally sparse regardless of source platform — a `unit` column is still usually empty because most addresses aren't multi-unit, independent of which platform produced the export) rather than re-measured against this file, since there's no data in it to measure.

## Verified for real

Created a `TargetSchema` from all 8 templates through the actual running app (`/schemas`'s "Create from template" form) and confirmed in Postgres that every sheet's column count and required-column count matched the source spreadsheet exactly — not just spot-checked, all 8.

## Design implication (carried over, still applies)

A recurring pattern across every sheet: a large fraction of "missing" data is likely to be **structurally absent, not a data-quality defect** — `unit` empty because most addresses aren't multi-unit, `notes` empty because the field goes unused, cost/duration fields on pricebook entries sparsely filled because they're rarely tracked closely. The audit report generator ([04-ai-cleaning-and-audit.md](./04-ai-cleaning-and-audit.md)) needs a way to distinguish "missing and required" from "missing and structurally expected" per column — otherwise every audit report drowns the genuinely actionable gaps in noise from fields that are supposed to be sparse. This is naturally where `CleaningRule`/`TargetSchema`'s `required`/`structurallyOptional` flags ([02-data-model.md](./02-data-model.md)) do the work — required-and-missing gets surfaced prominently, structurally-optional-and-missing gets summarized quietly or omitted.
