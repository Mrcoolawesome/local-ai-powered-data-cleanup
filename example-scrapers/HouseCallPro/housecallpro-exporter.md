# HouseCall Pro — Full Export Scraper

Logs into HouseCall Pro. Most non-invoice categories still use HouseCall Pro's
built-in email export flow. The invoice export is different: it pulls the
invoice list API, fetches each invoice preview, parses Services/Materials line
items, and writes a local workbook.

Default scope intentionally excludes attachments and job notes.

## Setup

```bash
npm install
```

Requires Google Chrome at:

```text
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

## Configure

Create `housecallpro.env` next to this script:

```ini
HOUSECALLPRO_EMAIL=user@example.com
HOUSECALLPRO_PASSWORD=your-password
HEADLESS=false
# HOUSECALLPRO_CUSTOMER_NAME=Marcus Mechanical
# HOUSECALLPRO_SESSION_DIR=/Users/you/.housecallpro-session
# HOUSECALLPRO_OUTPUT_DIR=/Users/you/Downloads
# HOUSECALLPRO_INVOICE_MAX_INVOICES=25
# HOUSECALLPRO_INVOICE_STATUSES=open,paid,pending_payment
```

Never commit `.env` files.

## Run

```bash
node housecallpro-exporter.mjs
```

Run one category:

```bash
node housecallpro-exporter.mjs --only contacts,jobs,invoices
```

## Default Output

Invoice workbook:

```text
~/Downloads/{Customer Name} - HouseCall Pro Invoices.xlsx
```

Other selected non-invoice exports are sent by email from HouseCall Pro.

Expected email-triggered exports:

- Contacts
- Estimates
- Job History
- Services
- Materials
- Equipment

## Default Scope

Included:

- Contacts email export trigger
- Estimates email export trigger
- Job History email export trigger
- Invoices local workbook with line items embedded as JSON
- Services pricebook export trigger
- Materials pricebook export trigger
- Equipment export trigger

Excluded from default:

- Attachments
- Job notes

## Known Behaviors

- Use `HEADLESS=false` for first run or when login/MFA is required.
- The script persists the browser session in `~/.housecallpro-session`.
- `node housecallpro-exporter.mjs --only invoices` does not trigger an email
  export. It writes a local XLSX workbook with `Invoices`, `Invoice Metadata`,
  and `Review` sheets.
- The `Invoices` sheet is the Lighthouse upload shape and includes required
  `line_items_json` built from the parsed preview line items.
- `node housecallpro-exporter.mjs --only estimates` also writes a local XLSX
  workbook. The `Estimates` sheet is the Lighthouse upload shape and includes
  `line_items_json` built from HCP estimate option line items.
- Invoice discovery defaults to all invoice statuses. Set
  `HOUSECALLPRO_INVOICE_STATUSES=open,paid,pending_payment` to match the common
  active invoice-list view.
- Use `HOUSECALLPRO_INVOICE_MAX_INVOICES=25` for a quick smoke test.
- Use `HOUSECALLPRO_ESTIMATE_MAX_ESTIMATES=25` for a quick estimate smoke test.
- Non-invoice/non-estimate categories must still be checked in the registered
  email inbox.

## Manual Column Selection (HCP list-view exports)

When exporting Jobs / Estimates / Invoices from the HCP list view ("Select
columns to view" dialog), check the columns below. They map to the Lighthouse
DataTransformer target schema (`crunchwrap_supreme/.../data_transformer/schemas.ex`).
Required schema fields are marked **[REQ]**. `Job #` / `Estimate #` / `Invoice #`
and `Customer name` are fixed columns that always export (no checkbox).

### Jobs → `@jobs_fields`
NOTE: the required date + title columns are in the LOWER half of the dialog —
you must scroll down to reach them.

- **Job name** → `job_title` **[REQ]** (scroll down)
- **Job scheduled start date** → `job_start_date` **[REQ]** (scroll down)
- Job scheduled end date → `job_end_date`
- Job description → `notes`
- Address components — check the SPLIT columns so they export pre-parsed (do NOT rely on the single combined "Address"): Street → `address_street`, Street 2 → `address_unit`, City → `address_city`, State → `address_state`, Zipcode → `address_postal_code` (all in the lower half, scroll down)
- Job type → `job_type`
- Job status → `status`
- Assigned employees → `technician`
- Customer email → `customer_email`; Customer mobile/home/work number → `customer_phone`
- (fixed) Job # → `job_id` **[REQ]**; Customer name → `customer_name` **[REQ]**

Leave financial/analytics columns (Gross profit, Job revenue, Total job cost,
Tax rate, Total labor hours, etc.) unchecked — not consumed by the jobs schema.

### Estimates → `@estimates_fields`
- **Sub-total** → `subtotal_cents` **[REQ]**
- **Open value / Won value / Lost value** → `total_cents` **[REQ]** (check all three; correct one populates per status. Mapper backfills total from subtotal if missing)
- Estimate status → `estimate_status`
- Description → `name` **[REQ]** source / `notes`
- Created date → estimate date; Discount amount → `discount_amount_cents`; Tax amount (validation)
- Customer email/home/mobile/work number → customer identity
- (fixed) Estimate # → `external_estimate_id`; Customer name → `customer_name`
- Gaps: no dedicated estimate-name column (derive `name` from Estimate #/Description); no valid-until column (`valid_until` unpopulated)

### Invoices → `@invoices_fields`
- **Invoice amount** → `total_cents` **[REQ]** (NOT "Amount due" — that is the balance)
- **Invoice status** → `status` **[REQ]**
- **Job #** → `job_id` (satisfies customer-identity requirement: one of job_id/email/phone)
- Email → `customer_email`; Phone → `customer_phone` (also cover identity)
- Created date → `issue_date`; Due date → `due_date`
- Amount due (validation); Payment date / Payment notes (context)
- NOTE: the invoices target schema has NO address fields — address columns
  (Service address / Billing address) are NOT consumed by the pipeline, so
  selecting them is optional and only useful as human reference. Address only
  matters for the Jobs export.
- (fixed) Invoice # → `invoice_number` **[REQ]**; Customer name → `customer_name`
- Gap: no subtotal/tax columns in list view (those fields stay empty)

Line items (`line_items_json`) are NOT available in any list-view column picker.
They come only from the local invoice/estimate workbook builds (`--only invoices`
/ `--only estimates`), not the manual column exports.

## Verification

A good invoice or estimate run prints the record count, line-item row count, and
saved workbook path.
