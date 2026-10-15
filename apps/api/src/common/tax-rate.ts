import { flatRateFromTotals } from "@routeflow/pricing";
import type { SystemConfigService } from "../system-config/system-config.service";

/**
 * `SystemConfig` key "settings.taxRate" stores a PERCENT (0–100, string) — every
 * client (web, mobile) divides the stored value by 100 before using it as a
 * multiplier. `orders.service.getTaxRate()` was the one server reader that
 * treated the same stored value as an already-divided FRACTION, so a tenant
 * with `taxRate = "5"` (meaning 5%) would have been taxed at 500%. This helper
 * is now the ONLY parser of that setting: it centralizes the percent→fraction
 * conversion so every reader agrees on the unit.
 *
 * The 0–100 clamp exists because `PATCH /settings` historically stored
 * whatever string it was given with no validation — a direct API call (not the
 * web form, which enforces min(0)/max(100)) could and did persist an
 * out-of-range value like "150". Clamping here makes any such stored value
 * inert without having to backfill or rewrite tenant data.
 *
 * Takes the stored PERCENT string; returns a FRACTION ready to multiply.
 */
export function taxRateFractionFrom(stored: string | null): number {
  if (stored === null || stored === "") return 0;
  const pct = parseFloat(stored);
  if (!Number.isFinite(pct)) return 0;
  return Math.min(Math.max(pct, 0), 100) / 100;
}

/**
 * The tenant's configured rate in PERCENT (8.25), through the same parser as the fraction above; null when none is set. A
 * receipt corroborates a stored line rate against this before it names one (`storedTaxRatePercent`).
 */
export function taxRatePercentFrom(stored: string | null | undefined): number | null {
  const fraction = taxRateFractionFrom(stored ?? null);
  return fraction > 0 ? Number((fraction * 100).toFixed(4)) : null;
}

/** Reads `settings.taxRate` for the current tenant (one query) as a percent; null when unset. */
export async function configuredTaxRatePercent(prisma: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PrismaService and its test mock both fit
  forTenant(): { systemConfig: { findFirst(args: any): Promise<{ value: string } | null> } };
}): Promise<number | null> {
  const row = await prisma.forTenant().systemConfig.findFirst({
    where: { key: "settings.taxRate" },
    select: { value: true },
  });
  return taxRatePercentFrom(row?.value);
}

/**
 * H5: the tenant's configured rate as a FRACTION (0.0825), read from `settings.taxRate` through the same parser as
 * every other reader; 0 when unset. For a service that holds a Prisma client but no SystemConfigService
 * (the estimate quote), exactly like `configuredTaxRatePercent`.
 */
export async function configuredTaxRateFraction(prisma: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PrismaService and its test mock both fit
  forTenant(): { systemConfig: { findFirst(args: any): Promise<{ value: string } | null> } };
}): Promise<number> {
  const row = await prisma.forTenant().systemConfig.findFirst({
    where: { key: "settings.taxRate" },
    select: { value: true },
  });
  return taxRateFractionFrom(row?.value ?? null);
}

/**
 * The tenant's CURRENT tax rate (fraction), read from Settings — the ONE reader every
 * caller shares, so the percent→fraction parsing above is never re-derived a second time
 * (the exact L-072/duplicated-rule class this file's own header warns about). Originally
 * `orders.service.ts`'s private `getTaxRate()`; extracted here (Returns Inside Order
 * Creation PR-1c, deferred item from PR-1b) so `InlineReturnsQuoteService`'s unreferenced-
 * chunk pricing (§3.2 case 2/3 — no matched invoice line to snapshot a rate from) can call
 * the SAME reader instead of falling back to a hand-rolled 0. `orders.service.ts.getTaxRate()`
 * now just forwards here; behaviour for every existing caller is unchanged.
 *
 * Never the SNAPSHOT rate a return chunk was priced at when it WAS matched to an invoice
 * line — that path reads `line.taxRate` verbatim (m-7 / inline-returns-pricing.ts's
 * `priceMatchedChunk`), deliberately never the tenant's current rate (design.md §3.5's
 * "rate change" oracle: a matched chunk taxes at the line's OWN snapshot, not this one).
 */
export async function currentTaxRate(systemConfig: SystemConfigService): Promise<number> {
  const stored = await systemConfig.get("settings.taxRate");
  return taxRateFractionFrom(stored);
}

/**
 * B294: the effective REGULAR (non-category) tax rate to stamp on invoice
 * lines derived from an order. The order stores one flat tax amount over its
 * whole subtotal — `order.tax = subtotal * rate` — rather than a per-line rate, so
 * `tax / subtotal` recovers that same rate exactly.
 * (H5: a converted ESTIMATE no longer recovers its rate this way - it re-takes today's tenant
 * rate; `estimate.taxAmount` is kept only to report the difference against the quote.)
 *
 * Zero for an exempt customer (mirrors foldCategoryTax's contract), and zero
 * for a degenerate zero-or-negative subtotal (the guard this helper always
 * applies). That guard's 0 agrees with the three proportional `regularTax`
 * call sites (`orderTax * (lineSubtotal / orderSubtotal)`) only when the
 * order header's subtotal equals the sum of its lines — the normal case,
 * since no line item ever has a negative subtotal (validated at creation).
 * A header desynced from its lines (subtotal stored as 0 while lines sum to
 * something > 0 and `tax` is a stale non-zero from an older code path) is a
 * pre-existing data inconsistency this helper does not detect or resolve —
 * it will report a 0 rate for that row same as the genuine zero-subtotal case.
 *
 * Shared by invoices.service.ts (order-derived lines) and
 * estimates.service.ts (estimate→invoice conversion) — one implementation,
 * no copy.
 */
export function effectiveTaxRateFromTotals(
  tax: unknown,
  subtotal: unknown,
  isTaxExempt: boolean,
): number {
  // B294 (SA-141): the one `tax / subtotal` rule lives in @routeflow/pricing (flatRateFromTotals),
  // shared with inferredFlatRate — the backfill, applyPriceAdjustment and mobile all use it.
  return isTaxExempt ? 0 : flatRateFromTotals(tax, subtotal);
}
