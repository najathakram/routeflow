/**
 * B956 / SA-629f: the ONE write-side guard for user-typed text a spreadsheet would run as a formula.
 * The export side (csv.ts `csvCell`) neutralises such text with an apostrophe; this refuses it at
 * the door for the fields where a leading `= + - @ TAB CR LF` is never legitimate (names), because
 * the byte-verbatim regulated/tobacco filings cannot carry that apostrophe. The grammar is the
 * csv.ts one (`FORMULA_LEAD` minus the `PLAIN_DECIMAL` numeric-only exemption), imported, never
 * copied. Validation is on WRITE only and only when the value CHANGES: a legacy row that already
 * holds such text must not block an unrelated edit, and nothing here reads or rewrites stored rows.
 */
import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES } from "./api-error-codes";
import { FORMULA_LEAD, PLAIN_DECIMAL } from "./csv";

export const TEXT_CELL_FORMULA_LEAD_CODE = API_ERROR_CODES.TEXT_CELL_FORMULA_LEAD;

/** True when a spreadsheet could run `value` as a formula (formula-led and not numeric-only). */
export function isFormulaLedText(value: string): boolean {
  return FORMULA_LEAD.test(value) && !PLAIN_DECIMAL.test(value);
}

/**
 * B964: human labels for the fields B964 guards (addresses, license numbers, buyer names), so the 400 and an import row's skip reason
 * read "City can't start with ..." instead of a camelCase key. B956's customer name fields (businessName, contactName,
 * displayName, tenant name) are deliberately NOT here: their message text is pinned by existing specs and stays as it was.
 * Web and mobile carry the same labels in their fixed copy (`safe-text-error-copy.ts`, pinned equal by a parity spec).
 */
export const TEXT_CELL_FIELD_LABELS: Readonly<Record<string, string>> = {
  label: "Address label",
  line1: "Address line 1",
  line2: "Address line 2",
  city: "City",
  state: "State",
  zip: "ZIP code",
  tobaccoLicenseNo: "Tobacco license number",
  licenseNumber: "License number",
  buyerName: "Name",
  productName: "Product name",
  variantName: "Variant name",
  // B983: category / subcategory names (regulated filings, invoices, exports)
  category: "Category", // Product.category (free text, B990)
  categoryName: "Category name",
  subcategoryName: "Subcategory name",
  // B984: a person's name (Customer / ContactPerson)
  salutation: "Salutation",
  firstName: "First name",
  lastName: "Last name",
  // Row 507: the shipment tracking text (order and invoice PATCH .../shipment)
  shippingCarrier: "Carrier",
  shippingTrackingNumber: "Tracking number",
};

/** Readable text for the 400 (and for an import row's skip reason). */
export function formulaLeadMessage(field: string): string {
  const label = Object.prototype.hasOwnProperty.call(TEXT_CELL_FIELD_LABELS, field)
    ? TEXT_CELL_FIELD_LABELS[field]
    : null;
  return label
    ? `${label} can't start with =, +, -, @ or a tab/line break`
    : `${field} must not start with = + - @ or a tab/line break`;
}

/**
 * The first field in `next` whose NEW value is formula-led, or null. A field is checked only when it
 * is present (a string) and differs from the same key in `stored`; `null`/`undefined` are skipped.
 */
export function firstFormulaLedField(
  next: Record<string, string | null | undefined>,
  stored?: Record<string, unknown> | null,
): string | null {
  for (const [field, value] of Object.entries(next)) {
    if (typeof value !== "string") continue;
    if (stored && stored[field] === value) continue;
    if (isFormulaLedText(value)) return field;
  }
  return null;
}

/** Throws a readable 400 (`code`, `field`, `message`) for the first formula-led changed field. */
export function assertSafeTextCell(
  next: Record<string, string | null | undefined>,
  stored?: Record<string, unknown> | null,
): void {
  const field = firstFormulaLedField(next, stored);
  if (field === null) return;
  throw new BadRequestException({
    statusCode: 400,
    code: TEXT_CELL_FORMULA_LEAD_CODE,
    field,
    message: formulaLeadMessage(field),
    error: "Bad Request",
  });
}
