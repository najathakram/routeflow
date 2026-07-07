/**
 * STOPGAP monthly list price (USD) per plan tier — used ONLY to render the
 * admin "Est. MRR" figure until the billing-plans session's persisted
 * plan-price catalog lands. That session OWNS pricing models; this file must
 * not grow into a second source of truth (no DB model, no per-addon pricing).
 * Values mirror the current admin billing page so the two surfaces agree.
 * When the catalog exists, replace these reads with it.
 */
export const STOPGAP_PLAN_MONTHLY_USD: Record<string, number> = {
  STARTER: 29,
  PROFESSIONAL: 79,
  ENTERPRISE: 199,
};

/**
 * Rough platform MRR = Σ(plan tenant count × stopgap monthly price).
 * Display-only approximation: ignores add-ons, discounts, and annual cadence
 * (the real rollup is billing-plans' job). Returns whole USD.
 */
export function estimatePlatformMrrUsd(planBreakdown: Record<string, number>): number {
  return Object.entries(planBreakdown).reduce((sum, [plan, count]) => {
    const price = STOPGAP_PLAN_MONTHLY_USD[plan] ?? 0;
    return sum + price * (count ?? 0);
  }, 0);
}

/**
 * STOPGAP monthly price (USD) per add-on key — same caveat as the plan map
 * (billing-plans owns the real add-on SKU pricing). Unknown keys contribute $0.
 */
export const STOPGAP_ADDON_MONTHLY_USD: Record<string, number> = {
  ai_scanning: 19,
  advanced_routes: 15,
  api_access: 49,
  custom_branding: 29,
  priority_support: 99,
  advanced_reporting: 39,
  tobacco_dealer: 39,
  regulated_items: 39,
  buyer_portal: 49,
};

/** Sum the stopgap monthly price of a set of active add-on keys. */
export function addonMonthlyUsd(addonKeys: string[]): number {
  return addonKeys.reduce((sum, k) => sum + (STOPGAP_ADDON_MONTHLY_USD[k] ?? 0), 0);
}
