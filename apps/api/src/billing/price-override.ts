/**
 * #2223 / SA-444, SA-444a: a negotiated fee (`priceOverrideMonthly`) is what the tenant pays, and a
 * ranked plan change never moves it — the plan key (entitlements) changes, the price does not. So on
 * an override row: the quote is 0 with this note, `basePriceSnapshot` stays the fee (the invariant:
 * basePriceSnapshot = what the tenant actually pays; MrrService prices from it), the MRR delta is 0,
 * and `priceOverrideMonthly` is never cleared or rewritten. An explicit fee change in Pricing keeps
 * its own path (updateTenantPriceOverride → reconcilePriceLedger).
 */
export const CUSTOM_FEE_UNCHANGED = "custom fee unchanged — adjust it in Pricing";

/** The row's negotiated monthly fee, or null when it pays the catalog price. */
export function priceOverrideOf(
  sub: { priceOverrideMonthly?: unknown } | null | undefined,
): number | null {
  return sub?.priceOverrideMonthly != null ? Number(sub.priceOverrideMonthly) : null;
}
