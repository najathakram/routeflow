/**
 * The ONE rule for "what does this plan cost this tenant": a per-tenant custom fee beats the catalog
 * price, and annual prepay is `annualPrice ?? monthly * 10`. `PlatformPricingService` (checkout,
 * admin resolver, price sync) and the plan-change Stripe push (upgrade / admin plan edit, SA-733 D8)
 * both read it, so a tenant is never charged one number by one path and another by the next.
 *
 * Pure — no DB, no Stripe. The caller supplies the plan definition (already looked up in the tenant's
 * pinned or the published catalog version) and the row's override columns.
 */

export type PlanPriceSource = "override" | "catalog";

export type PlanPriceResolution =
  | { ok: true; monthly: number; annual: number; source: PlanPriceSource }
  | { ok: false; reason: "annual_override_without_monthly" | "no_catalog_price" };

export function resolvePlanPrice(
  definition: { monthlyPrice?: unknown; annualPrice?: unknown } | null | undefined,
  override: { monthly?: unknown; annual?: unknown } | null | undefined,
): PlanPriceResolution {
  // `annualPrice` of 0 is a DELIBERATE promotional price (free first year) — test for null, never
  // truthiness, or a 0 silently becomes "10x monthly".
  const catalogMonthly = definition?.monthlyPrice != null ? Number(definition.monthlyPrice) : null;
  const catalogAnnual = definition?.annualPrice != null ? Number(definition.annualPrice) : null;

  // Either override column on its own counts as a custom fee: an annual-only fee is a real
  // negotiated case, and ignoring it would bill the catalog price to a tenant already re-priced.
  if (override?.monthly != null || override?.annual != null) {
    const monthly = override.monthly != null ? Number(override.monthly) : catalogMonthly;
    if (monthly == null) return { ok: false, reason: "annual_override_without_monthly" };
    const annual = override.annual != null ? Number(override.annual) : monthly * 10;
    return { ok: true, monthly, annual, source: "override" };
  }

  if (catalogMonthly == null) return { ok: false, reason: "no_catalog_price" };
  return {
    ok: true,
    monthly: catalogMonthly,
    annual: catalogAnnual != null ? catalogAnnual : catalogMonthly * 10,
    source: "catalog",
  };
}
