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
  has_stripe_subscription: API_ERROR_CODES.CATCHUP_NEEDS_RULING,
  billable_addon_not_card_billable: API_ERROR_CODES.CATCHUP_ADDON_NOT_CARD_BILLABLE,
  addon_snapshot_not_catalog: API_ERROR_CODES.CATCHUP_ADDON_SNAPSHOT_NOT_CATALOG,
} as const;

/** The fixed sentence per code (operator copy; the web maps the same codes to its own toast copy). */
const MESSAGE: Record<string, string> = {
  [API_ERROR_CODES.CATCHUP_NEEDS_RULING]:
    "NEEDS RULING: this tenant's catch-up cannot be planned automatically. Nothing was created.",
  [API_ERROR_CODES.CATCHUP_ADDON_NOT_CARD_BILLABLE]:
    "NEEDS RULING: this tenant holds a priced add-on the card checkout cannot bill. Voiding its invoices would lose that charge. Keep it on the manual path. Nothing was created.",
  [API_ERROR_CODES.CATCHUP_ADDON_SNAPSHOT_NOT_CATALOG]:
    "NEEDS RULING: this tenant's add-on price or quantity differs from what the card checkout would bill. Keep it on the manual path. Nothing was created.",
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
