import {
  assertSafeTextCell,
  firstFormulaLedField,
  formulaLeadMessage,
} from "../common/safe-text-cell";
import { assertSafeLicense, assertSafePersonName } from "../common/text-cell-guards";

/** The customer NAME fields B956 guards on write (address / license / product names are B964). */
export const CUSTOMER_NAME_FIELDS = ["businessName", "contactName", "displayName"] as const;

type NameInput = Partial<Record<(typeof CUSTOMER_NAME_FIELDS)[number], string | null | undefined>>;

function pick(src: NameInput) {
  return {
    businessName: src.businessName,
    contactName: src.contactName,
    displayName: src.displayName,
  };
}

/** Throws a readable 400 when a changed customer name starts with a formula lead (B956). */
export function assertSafeCustomerNames(next: NameInput, stored?: NameInput | null): void {
  assertSafeTextCell(pick(next), stored ? pick(stored) : null);
}

/** The first refused customer-name field (a structured result, never parsed from a message), or null. */
export function refusedCustomerNameField(
  next: NameInput,
  stored?: NameInput | null,
): string | null {
  return firstFormulaLedField(pick(next), stored ? pick(stored) : null);
}

/** Non-throwing form for the import, which rejects the ROW (not the batch) with this text. */
export function customerNameViolation(next: NameInput, stored?: NameInput | null): string | null {
  const field = firstFormulaLedField(pick(next), stored ? pick(stored) : null);
  return field === null ? null : formulaLeadMessage(field);
}

/**
 * The change-only text guards the customer PATCH runs before it writes: B956 names, B984 salutation /
 * first / last name, B964 the importer's tobaccoLicenseNo. Only a CHANGED value is checked.
 */
export function assertSafeCustomerUpdate(
  dto: Parameters<typeof assertSafePersonName>[0],
  existing: Parameters<typeof assertSafePersonName>[1] & NameInput,
  compliance: Parameters<typeof assertSafeLicense>[0] | undefined,
): void {
  assertSafeCustomerNames(dto as NameInput, existing);
  assertSafePersonName(dto, existing);
  assertSafeLicense(compliance ?? {}, existing as Parameters<typeof assertSafeLicense>[1]);
}
