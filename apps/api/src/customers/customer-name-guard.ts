import {
  assertSafeTextCell,
  firstFormulaLedField,
  formulaLeadMessage,
} from "../common/safe-text-cell";

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
