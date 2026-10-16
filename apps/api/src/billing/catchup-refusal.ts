import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-733r5 r-note: every refusal a client or admin sees is an UPPER_SNAKE code with FIXED, mapped copy - never a raw
 * internal reason string. The catch-up plan and the eligibility check produce internal lower_snake reasons
 * (`billable_addon_not_card_billable`, `has_stripe_subscription`, ...); this module is the ONE place they become a
 * code. The owner's dry-run / census lists each refused tenant by id and this code (no names), so the tenant can
 * be routed to the manual path.
 */

export const CATCHUP_REFUSAL = {
  // plan refusals (catchup-plan.ts): the plan cannot be made, or would double-bill / lose money
  paid_after_gap: API_ERROR_CODES.CATCHUP_NEEDS_RULING,
  paid_invoice_without_period: API_ERROR_CODES.CATCHUP_NEEDS_RULING,
  no_monthly_price: API_ERROR_CODES.CATCHUP_NEEDS_RULING,
  // SA-733r9 rule 7: the resolved plan price is <= 0, so there is nothing a card could bill
  no_billable_price: API_ERROR_CODES.CATCHUP_NO_BILLABLE_PRICE,
  has_stripe_subscription: API_ERROR_CODES.CATCHUP_NEEDS_RULING,
  billable_addon_not_card_billable: API_ERROR_CODES.CATCHUP_ADDON_NOT_CARD_BILLABLE,
  addon_snapshot_not_catalog: API_ERROR_CODES.CATCHUP_ADDON_SNAPSHOT_NOT_CATALOG,
  // the reverse direction: a card line the manual invoice never billed. Same family, same fixed copy.
  checkout_addon_without_priced_row: API_ERROR_CODES.CATCHUP_ADDON_SNAPSHOT_NOT_CATALOG,
  // B1102: a held add-on whose catalog includedAtPlan names no plan (fix the catalog entry)
  addon_catalog_invalid: API_ERROR_CODES.ADDON_CATALOG_INVALID,
  manual_period_ahead: API_ERROR_CODES.CATCHUP_MANUAL_PERIOD_AHEAD,
  // a legacy activation marker with no recorded period cannot be measured: same code, fail closed
  manual_marker_without_period: API_ERROR_CODES.CATCHUP_MANUAL_PERIOD_AHEAD,
} as const;

/** The fixed sentence per code (operator copy; the web maps the same codes to its own toast copy). */
const MESSAGE: Record<string, string> = {
  [API_ERROR_CODES.CATCHUP_NEEDS_RULING]:
    "NEEDS RULING: this tenant's catch-up cannot be planned automatically. Nothing was created.",
  [API_ERROR_CODES.CATCHUP_ADDON_NOT_CARD_BILLABLE]:
    "NEEDS RULING: this tenant holds a priced add-on the card checkout cannot bill. Voiding its invoices would lose that charge. Keep it on the manual path. Nothing was created.",
  [API_ERROR_CODES.CATCHUP_ADDON_SNAPSHOT_NOT_CATALOG]:
    "NEEDS RULING: this tenant's add-on price or quantity differs from what the card checkout would bill. Keep it on the manual path. Nothing was created.",
  [API_ERROR_CODES.CATCHUP_MANUAL_PERIOD_AHEAD]:
    "NEEDS RULING: an activation on this tenant has no recorded period, so its paid days cannot be measured. A catch-up could charge days that are already paid. Keep it on the manual path until the activation is corrected. Nothing was created.",
  [API_ERROR_CODES.CATCHUP_NO_BILLABLE_PRICE]:
    "NEEDS RULING: this tenant's plan has no billable monthly price (zero or negative). A card subscription would bill nothing. Keep it on the manual path. Nothing was created.",
};

/** The code an internal refusal reason maps to; anything unlisted is the generic "not eligible". */
export function refusalCodeOf(reason: string): string {
  return (
    (CATCHUP_REFUSAL as Record<string, string>)[reason] ?? API_ERROR_CODES.CATCHUP_NOT_ELIGIBLE
  );
}

/** Distinct codes for a list of internal reasons, in first-seen order. */
export function refusalCodesOf(reasons: readonly string[]): string[] {
  return [...new Set(reasons.map(refusalCodeOf))];
}

/** The coded 409 for a plan refusal (never the raw reason in its message). */
export function planRefusalException(reason: string): ConflictException {
  const code = refusalCodeOf(reason);
  return new ConflictException({
    code,
    message:
      MESSAGE[code] ?? "This tenant is not eligible for a catch-up checkout. Nothing was created.",
  });
}
