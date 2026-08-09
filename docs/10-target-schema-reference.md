# Target Schema Reference (derived from `/example-data`)

`/example-data` holds a real customer export (gitignored — it contains live customer PII: names, emails, phones, addresses, so it never enters git). This doc captures the *structure* only — column names and aggregate missingness stats, nothing identifying — so the target-schema and cleaning-rule design in later phases has a concrete reference without needing to re-open that file or expose its contents anywhere version-controlled.

The export is from a **Jobber**-platform scrape (the user's other scraper source, distinct from the House Call Pro examples in `/example-scrapers`). Its column names closely track the "Lighthouse" field names referenced in the HCP README (`external_id`, `job_number`/`job_id`, `line_items_json`, `subtotal_cents`/`total_cents`, `customer_uid`) — confirming the target schema is meant to be platform-agnostic: both Jobber and HouseCall Pro data normalize down to the same shape. This is what `TargetSchema` should encode per entity type, independent of which of the ~7 scrapers produced the raw file.

The file has 7 sheets; **Attachments Manifest is out of scope here** (per instruction — it's a file-listing sheet, not a business-entity target schema, and belongs with the `Attachment` ingestion path in [03-ingestion-and-scrapers.md](./03-ingestion-and-scrapers.md) instead).

## Contacts (1,563 rows)

`phone, email, first_name, last_name, street_address, unit, city, state, postal_code, country, company_name, is_company, is_lead, is_archived, tags, external_id, created_at, cf:Equipment, cf:Equipment Age, cf:Referred By`

Notable dirtiness: `email` missing ~20%, `country` missing ~49%, `company_name` missing ~58% (expected — most contacts are individuals, not companies), `tags`/custom fields (`cf:*`) missing 94–100%. `unit` missing ~88% is expected (most addresses aren't multi-unit) — a cleaning rule should treat that as normal-empty, not a data-quality flag.

## Jobs (2,564 rows)

`job_number, external_id, job_start_date, start_time, job_end_date, end_time, title, job_type, status, technician, customer_name, customer_email, customer_phone, street_address, unit, city, state, postal_code, notes, attachment_count, attachment_filenames, client_uid, property_uid, created_at, total`

Notable dirtiness: `customer_phone` missing ~22%, `technician` missing ~8%, `attachment_filenames` missing ~28% (jobs with no photos — expected, not an error).

## Invoices (4,234 rows)

`external_id, invoice_number, status, subtotal_cents, total_cents, tax_amount_cents, discount_amount_cents, payments_total, balance, customer_uid, customer_name, customer_email, customer_phone, job_external_ids, issue_date, due_date, created_at, notes, line_items_json`

Relatively clean — biggest gap is `customer_phone` missing ~14%. This is the most complete sheet in the export.

## Estimates (629 rows)

`external_estimate_id, name, estimate_status, subtotal_cents, total_cents, tax_amount_cents, discount_amount_cents, deposit_amount, customer_uid, customer_name, customer_email, customer_phone, property_uid, job_external_ids, created_at, sent_at, notes, line_items_json`

Notable dirtiness: `job_external_ids` missing ~44% (estimates not yet tied to a job — expected for open/lost estimates), `notes` missing ~99% (essentially unused field), `sent_at` missing ~18% (draft estimates never sent).

## Memberships (103 rows)

`membership_plan, contact_name, contact_phone_number, contact_email, address, number_of_systems, start_date, end_date, is_auto_renewal, next_auto_renewal, notes, source_job_number, client_uid, job_type, terms_collapsed`

Notable dirtiness: `number_of_systems` missing ~97% (field essentially unused by this source platform), `next_auto_renewal` missing ~54% (non-auto-renewing memberships).

## Pricebook (585 rows)

`external_id, name, category, description, price, unit_price_template, last_quoted_price, internal_unit_cost, markup, taxable, duration_minutes, visible`

Notable dirtiness: `duration_minutes` missing ~99% (unused field), `internal_unit_cost` missing ~41%, `last_quoted_price` missing ~52% — cost/pricing fields are the least reliably populated here.

## Design implication

A recurring pattern across every sheet: a large fraction of "missing" data is **structurally absent, not a data-quality defect** — `unit` empty because most addresses aren't multi-unit, `notes` empty because the field goes unused, `sent_at` empty because an estimate was never sent. The audit report generator ([04-ai-cleaning-and-audit.md](./04-ai-cleaning-and-audit.md)) needs a way to distinguish "missing and required" from "missing and structurally expected" per column — otherwise every audit report drowns the genuinely actionable gaps (e.g. `customer_phone` missing on ~14–22% of Jobs/Invoices, which *is* worth flagging) in noise from fields that are supposed to be sparse. This is naturally where `CleaningRule`/`TargetSchema`'s `required` flag ([02-data-model.md](./02-data-model.md)) does the work — required-and-missing gets surfaced prominently, optional-and-missing gets summarized quietly or omitted.
