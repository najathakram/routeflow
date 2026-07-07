/**
 * The PLAN_GATE error contract. When a plan gate denies a request, the server
 * returns HTTP 403 with this body; the web renders one of three gate states
 * (plan-gating-wiring.md §1):
 *  - LOCKED_PAGE   — the flag needs a plan UPGRADE (ghost page + upsell card).
 *  - INLINE_RESOLVE — the flag is grantable à la carte (enable add-on w/ proration).
 *  - GRACE         — soft cap; NOT a 403 (handled by the meter/grace path, not this gate).
 */
export type PlanGateState = "LOCKED_PAGE" | "INLINE_RESOLVE" | "GRACE";

export interface PlanGateUpgrade {
  /** Cheapest plan that grants the flag (LOCKED_PAGE upgrade CTA); null if none/custom. */
  planKey: string | null;
  /** Decimal string to preserve money precision across the wire. */
  planMonthlyPrice: string | null;
  /** À-la-carte SKU that grants the flag (INLINE_RESOLVE), if any. */
  addonSku: string | null;
  addonMonthlyPrice: string | null;
}

export interface PlanGateErrorBody {
  code: "PLAN_GATE";
  state: PlanGateState;
  /** The flag key that was missing. */
  flag: string;
  message: string;
  upgrade: PlanGateUpgrade;
}

/** Build the structured 403 body. INLINE_RESOLVE when an add-on can grant the flag, else LOCKED_PAGE. */
export function buildPlanGateBody(flag: string, upgrade: PlanGateUpgrade): PlanGateErrorBody {
  const state: PlanGateState = upgrade.addonSku ? "INLINE_RESOLVE" : "LOCKED_PAGE";
  const message = upgrade.addonSku
    ? `This feature requires the ${upgrade.addonSku} add-on.`
    : upgrade.planKey
      ? `This feature requires the ${upgrade.planKey} plan or higher.`
      : "This feature is not available on your current plan.";
  return { code: "PLAN_GATE", state, flag, message, upgrade };
}
