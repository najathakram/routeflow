/**
 * B964-1: the address / license / buyer-name wrappers over the ONE write-side guard (`safe-text-cell.ts`, B956), and the OAuth
 * display-name neutraliser. Same rules as B956: change-only (a legacy stored value echoed back never blocks), the csv.ts grammar
 * with its numeric-only exemption, nothing reads or rewrites stored rows. Phone, mobile, email, notes and tax id are deliberately
 * NOT guarded ("+1 555..." is a legitimate phone number).
 */
import {
  assertSafeTextCell,
  firstFormulaLedField,
  formulaLeadMessage,
  isFormulaLedText,
} from "./safe-text-cell";

/** CustomerAddress text columns a spreadsheet export would print. */
export const ADDRESS_TEXT_FIELDS = ["label", "line1", "line2", "city", "state", "zip"] as const;
type AddressInput = Partial<
  Record<(typeof ADDRESS_TEXT_FIELDS)[number], string | null | undefined>
>;

function pickAddress(src: AddressInput) {
  return {
    label: src.label,
    line1: src.line1,
    line2: src.line2,
    city: src.city,
    state: src.state,
    zip: src.zip,
  };
}

/** Throws a readable 400 when a changed address field starts with a formula lead (B964). */
export function assertSafeAddress(next: AddressInput, stored?: AddressInput | null): void {
  assertSafeTextCell(pickAddress(next), stored ? pickAddress(stored) : null);
}

/** Non-throwing form for importers, which reject the ROW (not the batch) with this text. */
export function addressViolation(next: AddressInput, stored?: AddressInput | null): string | null {
  const field = firstFormulaLedField(pickAddress(next), stored ? pickAddress(stored) : null);
  return field === null ? null : formulaLeadMessage(field);
}

type LicenseInput = { tobaccoLicenseNo?: string | null; licenseNumber?: string | null };

function pickLicense(src: LicenseInput) {
  return { tobaccoLicenseNo: src.tobaccoLicenseNo, licenseNumber: src.licenseNumber };
}

/** Customer.tobaccoLicenseNo / CustomerAuthorization.licenseNumber: printed byte-verbatim on regulated filings. */
export function assertSafeLicense(next: LicenseInput, stored?: LicenseInput | null): void {
  assertSafeTextCell(pickLicense(next), stored ? pickLicense(stored) : null);
}

export function licenseViolation(next: LicenseInput, stored?: LicenseInput | null): string | null {
  const field = firstFormulaLedField(pickLicense(next), stored ? pickLicense(stored) : null);
  return field === null ? null : formulaLeadMessage(field);
}

/** A buyer name TYPED by the buyer (register, profile) or by staff (admin edit): refused, field `buyerName`. */
export function assertSafeBuyerName(name: string | null | undefined, stored?: string | null): void {
  assertSafeTextCell({ buyerName: name }, stored === undefined ? null : { buyerName: stored });
}

const FALLBACK_DISPLAY_NAME = "Customer";

/**
 * OAuth (Google / Apple) supplies the name: a sign-in must NEVER be blocked by it, so a missing or formula-led provider name is
 * neutralised instead of refused: the trimmed name, else the email's local part, else "Customer" (the local part is guarded too).
 */
export function safeBuyerDisplayName(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  const given = typeof name === "string" ? name.trim() : "";
  if (given && !isFormulaLedText(given)) return given;
  const local = typeof email === "string" ? email.split("@")[0].trim() : "";
  if (local && !isFormulaLedText(local)) return local;
  return FALLBACK_DISPLAY_NAME;
}

type ProductNameInput = { name?: string | null; variantName?: string | null };

// Product.name is reported under the field key `productName`: the generic `name` key stays B956's tenant name.
function pickProduct(src: ProductNameInput) {
  return { productName: src.name, variantName: src.variantName };
}

/** Product.name / variantName (B964-2): printed on invoices, order sheets, exports and the regulated filings. Change-only. */
export function assertSafeProductNames(
  next: ProductNameInput,
  stored?: ProductNameInput | null,
): void {
  assertSafeTextCell(pickProduct(next), stored ? pickProduct(stored) : null);
}

/** Non-throwing form for importers, which reject the ROW (not the batch) with this text. */
export function productNameViolation(
  next: ProductNameInput,
  stored?: ProductNameInput | null,
): string | null {
  const field = firstFormulaLedField(pickProduct(next), stored ? pickProduct(stored) : null);
  return field === null ? null : formulaLeadMessage(field);
}

/** A category name (ProductCategory label category, TrackedCategory section): printed on filings, invoices, exports (B983). Change-only. */
export function assertSafeCategoryName(
  name: string | null | undefined,
  stored?: string | null,
): void {
  assertSafeTextCell(
    { categoryName: name },
    stored === undefined ? null : { categoryName: stored },
  );
}

/** A TrackedSubcategory name (B983). Change-only. */
export function assertSafeSubcategoryName(
  name: string | null | undefined,
  stored?: string | null,
): void {
  assertSafeTextCell(
    { subcategoryName: name },
    stored === undefined ? null : { subcategoryName: stored },
  );
}

type PersonNameInput = {
  salutation?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

function pickPerson(src: PersonNameInput) {
  return { salutation: src.salutation, firstName: src.firstName, lastName: src.lastName };
}

/**
 * A person's name (B984): ContactPerson.salutation / firstName / lastName and the Customer's own copy of the same three
 * columns. Printed on statements, route sheets and exports. Change-only. Email, phone and mobile stay unguarded.
 */
export function assertSafePersonName(next: PersonNameInput, stored?: PersonNameInput | null): void {
  assertSafeTextCell(pickPerson(next), stored ? pickPerson(stored) : null);
}

/** Non-throwing form for importers, which reject the ROW (not the batch) with this text. */
export function personNameViolation(
  next: PersonNameInput,
  stored?: PersonNameInput | null,
): string | null {
  const field = firstFormulaLedField(pickPerson(next), stored ? pickPerson(stored) : null);
  return field === null ? null : formulaLeadMessage(field);
}
