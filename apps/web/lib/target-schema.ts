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

// Seeded from the customer's own real migration template ("Copy of Podium
// Migration Template.xlsx", provided directly — not derived/inferred),
// covering all 8 sheets it defines. Supersedes the earlier Jobber-export-
// derived version (docs/10-target-schema-reference.md's older sections) —
// that one only covered 3 entity types and used different column names in
// places (e.g. `job_number` vs this template's `job_id`); this is the
// customer's own authoritative field list for what Podium actually needs.
//
// `required` comes directly from the template's own color-coding (dark red
// header fill = required, blue = optional-but-expected), not inferred —
// see docs/10-target-schema-reference.md for the exact fill colors this
// was read from. `structurallyOptional` judgment calls (fields expected to
// be sparse even when present in principle, e.g. `unit`, `notes`, cost/
// duration fields) carry over the same reasoning the earlier Jobber-based
// version used, since that pattern (structurally-absent vs. genuine gap)
// is a property of the DATA, not the specific source platform.
export const TARGET_SCHEMA_TEMPLATES: Record<string, Column[]> = {
  Contacts: [
    col("first_name", true, false, "Given name."),
    col("last_name", false, false, "Family name."),
    col("phone", false, false, "Primary phone number."),
    col("email", false, false, "Email address."),
    col("street_address", false, false, "Street address."),
    col("unit", false, true, "Apartment/unit number — most addresses aren't multi-unit."),
    col("city", false, false, "City."),
    col("state", false, false, "State/province."),
    col("postal_code", false, false, "Postal code."),
    col("country", false, true, "Country — often left to a default."),
    col("tags", false, true, "Free-form tags."),
    col("contact_notes", false, true, "Free-text notes on the contact."),
    col("property_relation", false, false, "Relationship of this contact to the property (e.g. owner, tenant)."),
    col("property_type", false, false, "Type of property (e.g. residential, commercial)."),
    col("quickbooks_customer_id", false, true, "Linked QuickBooks customer id — only present for QuickBooks-integrated accounts."),
  ],
  Jobs: [
    col("job_id", true, false, "Source-platform job identifier."),
    col("customer_name", true, false, "Customer name."),
    col("customer_phone", false, false, "Customer phone."),
    col("customer_email", false, false, "Customer email."),
    col("job_title", true, false, "Job title/summary."),
    col("technician", false, false, "Assigned technician — missing means unassigned, worth flagging."),
    col("job_start_date", true, false, "Scheduled start date.", "date"),
    col("start_time", false, false, "Scheduled start time.", "time"),
    col("job_end_date", false, false, "Scheduled/actual end date.", "date"),
    col("end_time", false, false, "Scheduled/actual end time.", "time"),
    col("job_type", false, false, "Job type/category."),
    col("status", false, false, "Job status."),
    col("notes", false, true, "Free-text job notes."),
    col("address_street", false, false, "Job site street address."),
    col("address_unit", false, true, "Job site apartment/unit number — most addresses aren't multi-unit."),
    col("address_city", false, false, "Job site city."),
    col("address_state", false, false, "Job site state."),
    col("address_postal_code", false, false, "Job site postal code."),
  ],
  Invoices: [
    col("external_id", true, false, "Source-platform identifier, used for dedup."),
    col("status", true, false, "Invoice status."),
    col("job_id", false, false, "Associated job identifier."),
    col("customer_phone", false, false, "Customer phone."),
    col("customer_email", false, false, "Customer email."),
    col("total_cents", true, false, "Invoice total, in cents.", "integer"),
    col("subtotal_cents", false, false, "Subtotal before tax/discount, in cents.", "integer"),
    col("tax_amount_cents", false, false, "Tax amount, in cents.", "integer"),
    col("discount_amount_cents", false, true, "Discount amount, in cents — most invoices have no discount.", "integer"),
    col("issue_date", false, false, "Date the invoice was issued.", "date"),
    col("due_date", false, false, "Date payment is due.", "date"),
    col("notes", false, true, "Free-text invoice notes."),
    col("line_items_json", false, true, "Line items as a JSON string — only available from certain export paths.", "json"),
  ],
  Estimates: [
    col("name", true, false, "Estimate name/title."),
    col("external_estimate_id", false, false, "Source-platform identifier, used for dedup."),
    col("customer_name", false, false, "Customer name."),
    col("customer_email", false, false, "Customer email."),
    col("customer_phone", false, false, "Customer phone."),
    col("job_id", false, true, "Associated job identifier — open/lost estimates often aren't tied to a job yet."),
    col("total_cents", true, false, "Estimate total, in cents.", "integer"),
    col("subtotal_cents", true, false, "Subtotal before discount, in cents.", "integer"),
    col("discount_amount_cents", false, true, "Discount amount, in cents.", "integer"),
    col("discount_percentage", false, true, "Discount as a percentage.", "decimal"),
    col("valid_until", false, false, "Estimate expiration date.", "date"),
    col("notes", false, true, "Free-text estimate notes."),
    col("estimate_status", false, false, "Estimate status (e.g. draft, sent, approved)."),
    col("line_items_json", false, true, "Line items as a JSON string — only available from certain export paths.", "json"),
  ],
  "Pricebook - Services": [
    col("category", true, false, "Service category."),
    col("name", true, false, "Service name."),
    col("price", false, false, "Standard price.", "decimal"),
    col("after_hours_price", false, true, "After-hours price — not every service has one.", "decimal"),
    col("description", false, false, "Service description."),
    col("taxable", false, false, "Whether this service is taxable.", "boolean"),
    col("task_code", false, true, "Internal task/service code."),
    col("industry", false, true, "Industry this service applies to."),
    col("unit_of_measure", false, false, "Unit the price is quoted per (e.g. each, hour)."),
    col("unit_cost", false, true, "Internal unit cost — cost/pricing fields are the least reliably populated."),
    col("materials", false, true, "Associated materials."),
    col("duration", false, true, "Estimated duration — commonly unused."),
    col("labor_rate", false, true, "Labor rate.", "decimal"),
    col("labor_duration", false, true, "Labor duration."),
    col("income_account", false, true, "Linked accounting income account — only relevant for accounting-integrated setups."),
    col("expense_account", false, true, "Linked accounting expense account — only relevant for accounting-integrated setups."),
  ],
  "Pricebook - Materials": [
    col("category", true, false, "Material category."),
    col("name", true, false, "Material name."),
    col("price", false, false, "Standard price.", "decimal"),
    col("after_hours_price", false, true, "After-hours price — not every material has one.", "decimal"),
    col("description", false, false, "Material description."),
    col("taxable", false, false, "Whether this material is taxable.", "boolean"),
    col("task_code", false, true, "Internal task/material code."),
    col("industry", false, true, "Industry this material applies to."),
    col("unit_of_measure", false, false, "Unit the price is quoted per (e.g. each, box)."),
    col("unit_cost", false, true, "Internal unit cost — cost/pricing fields are the least reliably populated."),
    col("material_number", false, true, "Internal material/part number."),
    col("income_account", false, true, "Linked accounting income account — only relevant for accounting-integrated setups."),
    col("expense_account", false, true, "Linked accounting expense account — only relevant for accounting-integrated setups."),
  ],
  Equipment: [
    col("equipment_type", true, false, "Type of equipment."),
    col("name", false, false, "Equipment name."),
    col("manufacturer", false, false, "Manufacturer."),
    col("model_number", false, false, "Model number."),
    col("serial_number", false, true, "Serial number — not always tracked."),
    col("install_date", false, false, "Installation date.", "date"),
    col("placement", false, true, "Where the equipment is located on the property."),
    col("status", false, false, "Equipment status."),
    col("manufacturer_warranty_end", false, true, "Manufacturer warranty end date.", "date"),
    col("notes", false, true, "Free-text equipment notes."),
    col("customer_number", false, false, "Linked customer identifier."),
    col("location_number", false, true, "Linked location identifier — only relevant for multi-location customers."),
    col("customer_name", false, false, "Customer name."),
    col("customer_email", false, false, "Customer email."),
    col("customer_phone", false, false, "Customer phone."),
    col("street_address", false, false, "Equipment site street address."),
    col("unit", false, true, "Apartment/unit number — most addresses aren't multi-unit."),
    col("city", false, false, "Equipment site city."),
    col("state", false, false, "Equipment site state."),
    col("zip", false, false, "Equipment site postal code."),
    col("country", false, true, "Country — often left to a default."),
    col("property_type", false, false, "Type of property (e.g. residential, commercial)."),
    col("job_location", false, true, "Associated job location, if different from the customer address."),
  ],
  // Source sheet is literally named "Members"; kept as "Memberships" here
  // to match the term already used elsewhere in this app (e.g. the HCP
  // README's category list).
  Memberships: [
    col("contact_name", true, false, "Member's contact name."),
    col("phone_number", false, false, "Member's phone number."),
    col("email", false, false, "Member's email address."),
    col("service_address", false, false, "Service address covered by the membership."),
    col("membership_plan", false, false, "Membership plan name."),
    col("number_of_systems", false, true, "Number of systems covered — commonly unused.", "integer"),
    col("start_date", false, false, "Membership start date.", "date"),
    col("is_auto_renewal", false, false, "Whether the membership auto-renews.", "boolean"),
    col("next_auto_renewal", false, true, "Next auto-renewal date — only applies to auto-renewing memberships.", "date"),
    col("end_date", false, true, "Membership end date — only set once a membership has ended.", "date"),
    col("last_service_date", false, true, "Date of the most recent service visit.", "date"),
    col("next_outreach_date", false, true, "Date of the next planned outreach.", "date"),
    // The source template has two separate columns both literally labeled
    // "notes" (positions 13 and 16) — almost certainly a copy-paste
    // artifact in the original spreadsheet, not two intentionally distinct
    // fields (nothing in the template distinguishes what each would hold).
    // Merged into one rather than kept as a literal duplicate name, since
    // this app's own column-identity model (schemas/[id]/page.tsx's
    // addColumn/removeColumn, keyed by `name`) assumes names are unique
    // within a TargetSchema — two columns named "notes" would make removing
    // one ambiguously remove both.
    col("notes", false, true, "Free-text notes."),
    col("country", false, true, "Country — often left to a default."),
    col("status", false, false, "Membership status."),
  ],
};
