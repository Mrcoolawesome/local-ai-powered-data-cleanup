import { z } from "zod";

// Per docs/10-target-schema-reference.md's Design Implication: `required`
// and `structurallyOptional` are separate flags, not one tri-state, so the
// Phase 3 audit report can tell "nobody fills this in and that's normal"
// (e.g. `unit` on most addresses) apart from "this is usually present and
// its absence here is worth a human's attention" (e.g. `customer_phone`).
export const ColumnSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  required: z.boolean(),
  structurallyOptional: z.boolean(),
  description: z.string(),
});
export type Column = z.infer<typeof ColumnSchema>;

export const ColumnsSchema = z.array(ColumnSchema).min(1);

const col = (
  name: string,
  required: boolean,
  structurallyOptional: boolean,
  description: string,
  type = "string"
): Column => ({ name, type, required, structurallyOptional, description });

// Seeded from the real column sets + observed missingness in
// docs/10-target-schema-reference.md (derived from an actual customer
// export) — a starting point for "create from template", not a fixed
// requirement. required/structurallyOptional judgment calls below follow
// that doc's own missingness numbers: fields missing on the large majority
// of real rows (e.g. `unit`, custom fields nobody used) are marked
// structurally optional; fields that were nearly always present but
// occasionally gapped (e.g. `customer_phone`) are marked required=false but
// NOT structurally optional, so a real gap still gets surfaced.
export const TARGET_SCHEMA_TEMPLATES: Record<string, Column[]> = {
  Contacts: [
    col("first_name", true, false, "Given name."),
    col("last_name", false, false, "Family name — present on ~94% of real contacts."),
    col("phone", false, false, "Primary phone number."),
    col("email", false, false, "Email address — missing on ~20% of real contacts, still worth flagging."),
    col("street_address", false, false, "Street address."),
    col("unit", false, true, "Apartment/unit number — most addresses aren't multi-unit."),
    col("city", false, false, "City."),
    col("state", false, false, "State/province."),
    col("postal_code", false, false, "Postal code."),
    col("country", false, true, "Country — often left to a default."),
    col("company_name", false, true, "Company name — most contacts are individuals, not companies."),
    col("tags", false, true, "Free-form tags."),
    col("external_id", true, false, "Source-platform identifier, used for dedup."),
  ],
  Jobs: [
    col("job_number", true, false, "Source-platform job number."),
    col("external_id", true, false, "Source-platform identifier, used for dedup."),
    col("job_start_date", true, false, "Scheduled start date.", "date"),
    col("title", false, false, "Job title/summary."),
    col("status", true, false, "Job status."),
    col("technician", false, false, "Assigned technician — missing means unassigned, worth flagging."),
    col("customer_name", true, false, "Customer name."),
    col("customer_email", false, false, "Customer email."),
    col("customer_phone", false, false, "Customer phone — historically the most-flagged real gap in this data."),
    col("street_address", false, false, "Job site street address."),
    col("unit", false, true, "Apartment/unit number — most addresses aren't multi-unit."),
    col("city", false, false, "Job site city."),
    col("state", false, false, "Job site state."),
    col("postal_code", false, false, "Job site postal code."),
    col("notes", false, true, "Free-text job notes."),
    col("attachment_filenames", false, true, "Attached photo/document filenames — most jobs have none."),
    col("total", false, false, "Job total value.", "decimal"),
  ],
  Invoices: [
    col("external_id", true, false, "Source-platform identifier, used for dedup."),
    col("invoice_number", true, false, "Invoice number."),
    col("status", true, false, "Invoice status."),
    col("total_cents", true, false, "Invoice total, in cents.", "integer"),
    col("subtotal_cents", false, false, "Subtotal before tax/discount, in cents.", "integer"),
    col("payments_total", false, false, "Amount paid so far.", "decimal"),
    col("balance", false, false, "Remaining balance.", "decimal"),
    col("customer_name", true, false, "Customer name."),
    col("customer_email", false, false, "Customer email."),
    col("customer_phone", false, false, "Customer phone — historically the most-flagged real gap in this data."),
    col("issue_date", true, false, "Date the invoice was issued.", "date"),
    col("due_date", false, false, "Date payment is due.", "date"),
    col("line_items_json", false, true, "Line items — only available from certain export paths, not list views."),
  ],
};
