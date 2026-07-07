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
