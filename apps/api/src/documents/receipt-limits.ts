/**
 * Receipt email limits (SA-751r change 4): settings with named defaults. The keys are SystemConfig rows (registered in the
 * shared settings registry); an absent or unusable value is the default, so a typo in a row can never turn a limit off.
 */
export const RECEIPT_EMAIL_PER_ORDER_KEY = "receipts.email.perOrder";
export const RECEIPT_EMAIL_PER_TENANT_PER_DAY_KEY = "receipts.email.perTenantPerDay";
export const RECEIPT_EMAIL_PER_ADDRESS_PER_DAY_KEY = "receipts.email.perAddressPerDay";

/** How many times one order's receipt may be emailed. */
export const RECEIPT_EMAIL_PER_ORDER_DEFAULT = 3;
/** How many receipt emails a tenant may send in its own calendar day. */
export const RECEIPT_EMAIL_PER_TENANT_PER_DAY_DEFAULT = 100;
/** How many receipt emails one address may get from a tenant in the tenant's day (any order, any status): a stranger's inbox cannot be flooded. */
export const RECEIPT_EMAIL_PER_ADDRESS_PER_DAY_DEFAULT = 5;

/** A cap above this is not a limit anyone meant; it reads as unusable and falls back to the default. */
const MAX_LIMIT = 100_000;

/** A positive whole number (optionally padded), else the fallback. Never 0 and never negative: a limit of 0 is not "off". */
export function resolveReceiptLimit(raw: string | null | undefined, fallback: number): number {
  const text = (raw ?? "").trim();
  if (!/^\d+$/.test(text)) return fallback;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_LIMIT ? n : fallback;
}
